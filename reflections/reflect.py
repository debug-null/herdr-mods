#!/usr/bin/env python3
"""herdr-reflect — Daily reflection over all coding-agent sessions in Herdr.

Collects today's (or a chosen date's) sessions across the local machine and
connected remote herdr-core machines via `history.py`, filters out background
noise, computes friction signals, builds a compact digest, and runs headless
`claude -p --no-session-persistence --tools ""` to generate a structured
Markdown reflection report under ~/.config/herdr-app/reflections/YYYY-MM-DD.md.

Usage:
  herdr-reflect                      Reflect on today's sessions
  herdr-reflect --date yesterday     Reflect on yesterday's sessions
  herdr-reflect --date 2026-11-22    Reflect on a specific date
  herdr-reflect --days 3             Reflect on the last N days
  herdr-reflect --dry-run            Only collect & write digest (0 LLM tokens)
  herdr-reflect --open               Open the generated report in Herdr md-preview
  herdr-reflect --local-only         Skip remote machines
  herdr-reflect --model sonnet       Override Claude model
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timedelta

# Ensure ~/.local/bin and Homebrew are in PATH when invoked from cron/sched-engine
_EXTRA_PATHS = [
    os.path.expanduser("~/.local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
]
_cur_path = os.environ.get("PATH", "")
for _p in reversed(_EXTRA_PATHS):
    if _p not in _cur_path.split(":"):
        _cur_path = f"{_p}:{_cur_path}" if _cur_path else _p
os.environ["PATH"] = _cur_path

HOME = os.path.expanduser("~")
BASE_DIR = os.path.dirname(os.path.realpath(__file__))
DIGEST_DIR = os.path.join(BASE_DIR, "digests")
PROMPT_FILE = os.path.join(BASE_DIR, "prompt.md")
LOCAL_HISTORY = os.path.expanduser("~/.config/herdr-app/mods/history/history.py")
BOARD_TASKS_FILE = os.path.expanduser("~/.config/herdr-app/board/tasks.json")
HC = os.environ.get("HC_BIN", "hc")
APP = os.environ.get("HERDR_APP_BIN", "herdr-app")
CLAUDE = os.environ.get("CLAUDE_BIN", "claude")

RESUME_CMDS = {
    "claude": lambda s: f"claude --resume {s['id']}",
    "codex": lambda s: f"codex resume {s['id']}",
    "pi": lambda s: f"pi --session {s['file']}",
    "cursor": lambda s: f"cursor agent --resume {s['id']}",
    "opencode": lambda s: f"opencode --session {s['id']}",
    "antigravity": lambda s: f"agy --conversation {s['id']}",
    "devin": lambda s: f"devin --resume {s['id']}",
}

FRICTION_PATTERNS = re.compile(
    r"(不对|不是这|错了|报错|异常|还是不行|没生效|没有生效|失败|重来|重新|回滚|不要改|别改|"
    r"卡住|怎么又|依然|还是有|不行|崩溃|崩了|bug|error|failed|broken|wrong|revert|undo|still not)",
    re.IGNORECASE,
)

NOISE_CWD_SUBSTRS = (
    "/.claude-mem/observer-sessions",
    "/.claude-mem/",
)

NOISE_TITLE_SUBSTRS = (
    "Condense the tool payload below",
    "每日会话反思",
    "daily-reflection",
)

MAX_DIGEST_CHARS = 20000
MAX_SESSION_CHARS = 3200
MAX_SESSIONS = 18


def run_cmd(args, timeout=45, stdin_text=None):
    try:
        p = subprocess.run(
            args,
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"
    except OSError as e:
        return 127, "", str(e)


def tilde(path):
    if not path:
        return "—"
    return re.sub(r"^/Users/[^/]+", "~", str(path))


def clip(text, n):
    text = str(text or "").strip()
    if len(text) <= n:
        return text
    return text[: max(0, n - 1)] + "…"


def connected_machines():
    rc, out, _ = run_cmd([HC, "machine", "ls"], timeout=10)
    if rc != 0:
        return []
    try:
        data = json.loads(out)
    except ValueError:
        return []
    names = []
    for m in data.get("machines") or []:
        if m.get("temporary"):
            continue
        if m.get("state") == "connected" and m.get("name"):
            names.append(m["name"])
    return names


def fetch_session_list(host):
    if host == "local":
        rc, out, err = run_cmd(["python3", LOCAL_HISTORY, "list"], timeout=30)
    else:
        rc, out, err = run_cmd(
            [
                HC, "exec", "--on", host, "--",
                "sh", "-c", 'python3 "$HOME/.config/herdr-app/mods/history/history.py" list',
            ],
            timeout=30,
        )
    if rc != 0:
        return None, err.strip() or f"exit {rc}"
    try:
        return json.loads(out), None
    except ValueError as e:
        return None, f"invalid json: {e}"


def fetch_session_messages(host, agent, ref):
    if host == "local":
        rc, out, _ = run_cmd(["python3", LOCAL_HISTORY, "show", agent, ref], timeout=25)
    else:
        safe_agent = agent.replace("'", "'\\''")
        safe_ref = ref.replace("'", "'\\''")
        rc, out, _ = run_cmd(
            [
                HC, "exec", "--on", host, "--",
                "sh", "-c",
                f'python3 "$HOME/.config/herdr-app/mods/history/history.py" show \'{safe_agent}\' \'{safe_ref}\'',
            ],
            timeout=25,
        )
    if rc != 0:
        return []
    try:
        data = json.loads(out)
        return data.get("messages") or []
    except ValueError:
        return []


def is_noise_session(s):
    cwd = s.get("cwd") or ""
    title = s.get("title") or ""
    for sub in NOISE_CWD_SUBSTRS:
        if sub in cwd:
            return True
    for sub in NOISE_TITLE_SUBSTRS:
        if sub in title:
            return True
    if (s.get("turns") or 0) <= 1 and len(title.strip()) < 6:
        return True
    return False


def list_installed_skills():
    """Scan ~/.agents/skills and ~/.claude/skills for existing skill names + short descriptions."""
    found = {}
    roots = [
        os.path.join(HOME, ".agents", "skills"),
        os.path.join(HOME, ".claude", "skills"),
        os.path.join(HOME, ".cursor", "skills"),
    ]
    for root in roots:
        if not os.path.isdir(root):
            continue
        for entry in sorted(os.listdir(root)):
            if entry.startswith(".") or entry.startswith("_"):
                continue
            skill_md = os.path.join(root, entry, "SKILL.md")
            if not os.path.isfile(skill_md) or entry in found:
                continue
            desc = ""
            try:
                with open(skill_md, "r", encoding="utf-8", errors="replace") as f:
                    head = f.read(1200)
                m = re.search(r"(?m)^description:\s*(.+)$", head)
                if m:
                    desc = m.group(1).strip().strip('"').strip("'")
                    if desc in ("|", ">", "|-", ">-"):
                        # grab next non-empty indented line
                        lines = head[m.end():].splitlines()
                        for ln in lines:
                            if ln.strip():
                                desc = ln.strip()
                                break
            except OSError:
                pass
            found[entry] = clip(desc, 110)
    return found


def analyze_messages(msgs):
    """Extract objective metrics and select high-signal excerpts from a session."""
    user_msgs = []
    tool_counter = Counter()
    friction_hits = []

    for idx, m in enumerate(msgs):
        role = m.get("role")
        text = (m.get("text") or "").strip()
        if role == "tool":
            for line in text.splitlines():
                name = line.split("·", 1)[0].split(" ", 1)[0].strip()
                if name:
                    tool_counter[name] += 1
        elif role == "user":
            user_msgs.append((idx, text))
            if FRICTION_PATTERNS.search(text):
                friction_hits.append((idx, clip(text.replace("\n", " "), 160)))

    # Select key message indices: opening turns + friction turns + closing turns
    keep_idx = set()
    n = len(msgs)
    for i in range(min(6, n)):
        keep_idx.add(i)
    for i in range(max(0, n - 8), n):
        keep_idx.add(i)
    for idx, _ in friction_hits[:6]:
        keep_idx.add(idx)
        if idx + 1 < n:
            keep_idx.add(idx + 1)
    # Also include every user message (clipped) so no topic shift is missed
    for idx, _ in user_msgs:
        keep_idx.add(idx)

    excerpts = []
    last_i = -1
    char_budget = MAX_SESSION_CHARS
    for i in sorted(keep_idx):
        if char_budget <= 200:
            excerpts.append("...（已达单会话摘要字符上限，后续略）")
            break
        if last_i >= 0 and i > last_i + 1:
            excerpts.append(f"...（省略中间 {i - last_i - 1} 条消息）")
        last_i = i
        m = msgs[i]
        role = m.get("role", "?")
        text = (m.get("text") or "").strip()
        if role == "tool":
            lines = text.splitlines()
            summary = " ; ".join(clip(l, 90) for l in lines[:4])
            if len(lines) > 4:
                summary += f" (+{len(lines) - 4} calls)"
            line_out = f"- [tool] {summary}"
        elif role == "user":
            line_out = f"- **User**: {clip(text, 420)}"
        else:
            line_out = f"- **Assistant**: {clip(text, 380)}"
        excerpts.append(line_out)
        char_budget -= len(line_out) + 1

    return {
        "msg_count": n,
        "user_count": len(user_msgs),
        "friction_count": len(friction_hits),
        "friction_samples": [t for _, t in friction_hits[:4]],
        "top_tools": tool_counter.most_common(5),
        "excerpts": excerpts,
    }


def resolve_window(date_arg, days_arg):
    now = datetime.now()
    if days_arg is not None:
        end = now
        start = now - timedelta(days=days_arg)
        label = f"{start.strftime('%Y-%m-%d')}~{end.strftime('%Y-%m-%d')}"
        file_stem = f"{end.strftime('%Y-%m-%d')}-{days_arg}d"
        return start, end, label, file_stem

    if not date_arg or date_arg == "today":
        target = now.date()
    elif date_arg == "yesterday":
        target = (now - timedelta(days=1)).date()
    else:
        target = datetime.strptime(date_arg, "%Y-%m-%d").date()

    start = datetime(target.year, target.month, target.day, 0, 0, 0)
    end = datetime(target.year, target.month, target.day, 23, 59, 59)
    label = target.strftime("%Y-%m-%d")
    return start, end, label, label


def build_digest(date_label, start, end, include_remote=True):
    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    hosts = ["local"]
    if include_remote:
        hosts.extend(connected_machines())

    host_notes = []
    collected = []
    skipped_noise = 0

    for host in hosts:
        sessions, err = fetch_session_list(host)
        if err is not None:
            host_notes.append(f"- `{host}`: 拉取失败（{err}）")
            continue
        in_window = [
            s for s in sessions
            if start_ms <= (s.get("updated") or 0) <= end_ms
        ]
        valid = []
        for s in in_window:
            if is_noise_session(s):
                skipped_noise += 1
                continue
            s["_host"] = host
            valid.append(s)
        host_notes.append(f"- `{host}`: 命中 {len(valid)} 个有效会话（总索引 {len(sessions)}）")
        collected.extend(valid)

    # Sort by turns * weight + recency so substantial sessions never get dropped
    collected.sort(key=lambda s: (s.get("updated") or 0), reverse=True)
    if len(collected) > MAX_SESSIONS:
        collected = collected[:MAX_SESSIONS]

    skills = list_installed_skills()

    lines = [
        f"# 会话原始摘要包 · {date_label}",
        "",
        f"- 时间范围：{start.strftime('%Y-%m-%d %H:%M')} ~ {end.strftime('%Y-%m-%d %H:%M')}",
        f"- 有效会话数：{len(collected)}（已自动过滤 {skipped_noise} 个后台观察器/噪音会话）",
        *host_notes,
        "",
        f"## 已安装的全局 Skill 清单（共 {len(skills)} 个，用于去重与改进判断）",
        "",
        ", ".join(f"`{name}`" for name in sorted(skills.keys())),
        "",
        "## 有效会话明细",
        "",
    ]

    total_chars = sum(len(x) for x in lines)
    session_summaries = []

    for idx, s in enumerate(collected, 1):
        host = s["_host"]
        agent = s.get("agent", "?")
        msgs = fetch_session_messages(host, agent, s.get("file") or s.get("id") or "")
        info = analyze_messages(msgs)

        created_s = datetime.fromtimestamp(s["created"] / 1000).strftime("%H:%M") if s.get("created") else "?"
        updated_s = datetime.fromtimestamp(s["updated"] / 1000).strftime("%H:%M") if s.get("updated") else "?"
        resume_fn = RESUME_CMDS.get(agent)
        resume_cmd = resume_fn(s) if resume_fn else ""
        if host != "local" and resume_cmd:
            resume_cmd = f"hc run --on {host} -- {resume_cmd}"

        tools_str = ", ".join(f"{k}×{v}" for k, v in info["top_tools"]) or "无"
        block = [
            f"### 会话 {idx}: [{host} / {agent}] {s.get('title') or s.get('id')}",
            f"- **目录**: `{tilde(s.get('cwd'))}`",
            f"- **时间**: {created_s} → {updated_s} · **用户轮数**: {s.get('turns', info['user_count'])} · **消息数**: {info['msg_count']}",
            f"- **摩擦/纠偏信号**: {info['friction_count']} 次"
            + (f"（示例：{' | '.join(info['friction_samples'][:2])}）" if info["friction_samples"] else ""),
            f"- **高频工具**: {tools_str}",
            f"- **恢复命令**: `{resume_cmd}`" if resume_cmd else "",
            "",
            *info["excerpts"],
            "",
        ]
        block = [b for b in block if b is not None]
        block_text = "\n".join(block)
        if total_chars + len(block_text) > MAX_DIGEST_CHARS:
            lines.append(f"### 会话 {idx}: [{host} / {agent}] {s.get('title') or s.get('id')}")
            lines.append(f"- **目录**: `{tilde(s.get('cwd'))}` · 轮数: {s.get('turns', 0)} · 摩擦: {info['friction_count']} 次（超出总摘要长度，仅保留元信息）")
            lines.append("")
        else:
            lines.append(block_text)
            total_chars += len(block_text)

        session_summaries.append({
            "host": host,
            "agent": agent,
            "title": s.get("title") or s.get("id"),
            "cwd": tilde(s.get("cwd")),
            "turns": s.get("turns", 0),
            "friction": info["friction_count"],
        })

    return "\n".join(lines), session_summaries, host_notes


def run_claude_reflection(date_label, digest_text, model=None, effort="low"):
    with open(PROMPT_FILE, "r", encoding="utf-8") as f:
        prompt_tpl = f.read().replace("{{DATE}}", date_label)

    full_input = f"{prompt_tpl}\n\n---\n\n{digest_text}\n"
    cmd = [
        CLAUDE,
        "-p",
        "--no-session-persistence",
        "--tools", "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--effort", effort,
    ]
    if model:
        cmd += ["--model", model]
    cmd.append("请严格按照 stdin 中给出的复盘要求和 Markdown 模板，直接输出今日反思报告正文。")
    rc, out, err = run_cmd(cmd, timeout=360, stdin_text=full_input)
    if rc != 0:
        raise RuntimeError(f"claude -p failed (code {rc}): {(err or out).strip()[:400]}")
    # Strip any leading diagnostic lines such as [claude-code:unrecognized_model]
    lines = [
        ln for ln in out.splitlines()
        if not ln.startswith("[claude-code:")
    ]
    body = "\n".join(lines).strip()
    if not body:
        raise RuntimeError("claude -p returned empty output")
    return body


def extract_board_items(markdown_body):
    m = re.search(r"<!--\s*BOARD_SYNC_START\s*([\s\S]*?)\s*BOARD_SYNC_END\s*-->", markdown_body)
    if not m:
        return []
    raw = m.group(1).strip()
    # Strip optional fenced code block if model wrapped it
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw).strip()
    try:
        items = json.loads(raw)
        return items if isinstance(items, list) else []
    except ValueError:
        return []


def _norm_title(s):
    return re.sub(r"[\s\W_]+", "", str(s or "").lower())


def sync_items_to_board(items, date_label):
    if not items:
        return 0
    os.makedirs(os.path.dirname(BOARD_TASKS_FILE), exist_ok=True)
    try:
        with open(BOARD_TASKS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data.get("tasks"), list):
            data["tasks"] = []
    except (OSError, ValueError):
        data = {"version": 1, "tasks": []}

    existing_open = {
        _norm_title(t.get("title"))
        for t in data["tasks"]
        if t.get("column") != "done" and t.get("title")
    }
    now = int(time.time() * 1000)
    added = 0
    for idx, it in enumerate(items[:3]):
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "").strip()
        if not title:
            continue
        norm = _norm_title(title)
        if norm in existing_open:
            continue
        existing_open.add(norm)
        col = it.get("column") if it.get("column") in ("ideas", "todo") else "todo"
        prio = it.get("priority") if it.get("priority") in ("p1", "p2", "p3") else "p2"
        proj = it.get("project")
        if isinstance(proj, dict) and (proj.get("name") or proj.get("path")):
            p_path = proj.get("path")
            if isinstance(p_path, str) and p_path.startswith("~"):
                p_path = os.path.expanduser(p_path)
            proj_obj = {
                "name": str(proj.get("name") or os.path.basename(str(p_path or "").rstrip("/")) or "未命名"),
                "path": p_path if isinstance(p_path, str) and p_path else None,
                "machine": proj.get("machine") or None,
            }
        else:
            proj_obj = None
        tags = [str(x).strip().lstrip("#") for x in (it.get("tags") or []) if str(x).strip()]
        if "reflect" not in tags:
            tags.insert(0, "reflect")

        rec = {
            "id": f"r{now + idx:x}"[-10:],
            "title": title,
            "notes": str(it.get("notes") or "").strip(),
            "column": col,
            "priority": prio,
            "project": proj_obj,
            "tags": tags[:4],
            "source": f"reflect:{date_label}",
            "createdAt": now + idx,
            "updatedAt": now + idx,
            "doneAt": None,
        }
        data["tasks"].insert(0, rec)
        added += 1

    if added > 0:
        tmp = f"{BOARD_TASKS_FILE}.tmp.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, BOARD_TASKS_FILE)
    return added


def open_in_herdr(report_path, date_label):
    run_cmd(
        [
            APP, "do", "tab.new",
            "--name", f"反思 {date_label}",
            "--mod", "md-preview",
            "--props", json.dumps({"file": report_path}, ensure_ascii=False),
            "--focus", "true",
        ],
        timeout=10,
    )


def main():
    p = argparse.ArgumentParser(prog="herdr-reflect")
    p.add_argument("--date", help="YYYY-MM-DD | today | yesterday (default: today)")
    p.add_argument("--days", type=int, help="reflect on the last N days instead of one date")
    p.add_argument("--dry-run", action="store_true", help="only collect & save digest, skip LLM call")
    p.add_argument("--open", action="store_true", help="open report in Herdr md-preview tab")
    p.add_argument("--local-only", action="store_true", help="skip remote herdr-core machines")
    p.add_argument("--model", help="override claude model (e.g. sonnet, opus)")
    p.add_argument("--effort", default="low", choices=["low", "medium", "high"], help="reasoning effort (default: low)")
    p.add_argument("--no-sync-board", action="store_true", help="do not push action items to Board")
    a = p.parse_args()

    os.makedirs(DIGEST_DIR, exist_ok=True)
    start, end, date_label, file_stem = resolve_window(a.date, a.days)

    digest_text, summaries, host_notes = build_digest(
        date_label, start, end, include_remote=not a.local_only
    )
    digest_path = os.path.join(DIGEST_DIR, f"{file_stem}.digest.md")
    with open(digest_path, "w", encoding="utf-8") as f:
        f.write(digest_text)

    report_path = os.path.join(BASE_DIR, f"{file_stem}.md")

    if a.dry_run:
        print(f"dry-run ok: {len(summaries)} sessions -> {digest_path} ({len(digest_text)} chars)")
        return

    if not summaries:
        empty_md = (
            f"---\ndate: {date_label}\nsessions: 0\ngenerated_at: {datetime.now().isoformat(timespec='seconds')}\n---\n\n"
            f"# 每日会话反思 · {date_label}\n\n"
            f"今日暂无有效的 Coding Agent 会话记录。\n"
        )
        with open(report_path, "w", encoding="utf-8") as f:
            f.write(empty_md)
        print(f"0 sessions on {date_label}; wrote {report_path}")
        return

    body = run_claude_reflection(date_label, digest_text, model=a.model, effort=a.effort)
    hosts_used = sorted({s["host"] for s in summaries})
    agents_used = sorted({s["agent"] for s in summaries})
    frontmatter = (
        "---\n"
        f"date: {date_label}\n"
        f"sessions: {len(summaries)}\n"
        f"hosts: [{', '.join(hosts_used)}]\n"
        f"agents: [{', '.join(agents_used)}]\n"
        f"generated_at: {datetime.now().isoformat(timespec='seconds')}\n"
        f"digest: digests/{file_stem}.digest.md\n"
        "---\n\n"
    )
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(frontmatter + body + "\n")

    synced = 0
    if not a.no_sync_board:
        board_items = extract_board_items(body)
        synced = sync_items_to_board(board_items, date_label)

    if a.open:
        open_in_herdr(report_path, date_label)

    # Concise summary for scheduler history & toast notification
    sync_note = f"，已同步 {synced} 条到 Board" if synced else ""
    print(f"反思已生成：{tilde(report_path)}（共分析 {len(summaries)} 个会话，跨 {'/'.join(hosts_used)}{sync_note}）")


if __name__ == "__main__":
    main()
