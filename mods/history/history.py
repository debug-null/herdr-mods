#!/usr/bin/env python3
"""Indexes and reads coding-agent session transcripts for the History panel.

  history.py list [--cwd PATH]  -> JSON array of sessions, newest first
  history.py show AGENT REF     -> JSON array of messages for one session

Sources: Claude Code, Codex, Pi, Cursor, OpenCode, Antigravity.
Per-file (and per-db) results are cached by (mtime, size) so a refresh only
re-reads transcripts that changed. --cwd keeps sessions related to PATH
(session under path, path under session, or missing cwd).
"""
import glob
import json
import os
import re
import sqlite3
import sys
from urllib.parse import unquote, urlparse

HOME = os.path.expanduser("~")
CACHE = os.path.join(HOME, ".cache", "herdr-history", "index.json")
CACHE_VERSION = 4
TITLE_MAX = 160
TEXT_MAX = 6000
SHOW_MAX = 400


def clip(text, n):
    text = " ".join(str(text).split()) if n <= TITLE_MAX else str(text)
    return text if len(text) <= n else text[: n - 1] + "…"


def ms(ts):
    """ISO-8601 string or epoch number -> epoch milliseconds."""
    if ts is None:
        return 0
    if isinstance(ts, (int, float)):
        return int(ts if ts > 1e12 else ts * 1000)
    from datetime import datetime
    try:
        return int(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def noise(text):
    """Injected context rather than something the person typed."""
    t = text.lstrip()
    return (not t or t.startswith("<") or t.startswith("# AGENTS.md")
            or t.startswith("Caveat:") or t.startswith("[Request interrupted"))


def jsonl(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def text_of(content, roles=("text", "input_text", "output_text")):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content
                         if isinstance(p, dict) and p.get("type", "text") in roles and p.get("text"))
    return ""


def tool_line(name, args):
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return f"{name} {clip(args, 200)}"
    if isinstance(args, dict):
        for k in ("command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt"):
            if args.get(k):
                v = args[k]
                return f"{name} · {clip(' '.join(v) if isinstance(v, list) else v, 200)}"
    return name


def path_inside(path, root):
    if not path or not root:
        return False
    path, root = os.path.normpath(path), os.path.normpath(root)
    return path == root or path.startswith(root + os.sep)


def related_cwd(session_cwd, filter_cwd):
    """Keep sessions in/above/below filter. Unknown cwd only appears in unfiltered list."""
    if not filter_cwd:
        return True
    if not session_cwd:
        return False
    return path_inside(session_cwd, filter_cwd) or path_inside(filter_cwd, session_cwd)


def file_uri_path(uri):
    if not uri:
        return None
    if uri.startswith("file://"):
        return unquote(urlparse(uri).path)
    return uri if uri.startswith("/") else None


# ---------- Claude Code ----------

def claude_index(path):
    title = ai_title = first = cwd = None
    created = updated = 0
    turns = 0
    sid = os.path.splitext(os.path.basename(path))[0]
    for d in jsonl(path):
        t = d.get("type")
        if t == "ai-title":
            ai_title = d.get("aiTitle") or ai_title
        elif t in ("custom-title", "summary"):
            title = d.get("customTitle") or d.get("summary") or title
        elif t == "workspace-directories" and not cwd:
            cwd = (d.get("directories") or [None])[0]
        elif t in ("user", "assistant"):
            if d.get("isSidechain"):
                continue
            cwd = cwd or d.get("cwd")
            ts = ms(d.get("timestamp"))
            if ts:
                created = created or ts
                updated = max(updated, ts)
            if t == "user" and not d.get("isMeta"):
                text = text_of((d.get("message") or {}).get("content"), ("text",))
                if text and not noise(text):
                    turns += 1
                    first = first or text
    if not turns:
        return None
    return {"agent": "claude", "id": sid, "file": path, "cwd": cwd, "created": created,
            "updated": updated, "turns": turns,
            "title": clip(title or ai_title or first, TITLE_MAX)}


def claude_show(path):
    out = []
    for d in jsonl(path):
        t = d.get("type")
        if t not in ("user", "assistant") or d.get("isSidechain") or d.get("isMeta"):
            continue
        content = (d.get("message") or {}).get("content")
        ts = ms(d.get("timestamp"))
        if isinstance(content, str):
            if t == "user" and noise(content):
                continue
            out.append({"role": t, "text": content, "time": ts})
            continue
        for p in content or []:
            if not isinstance(p, dict):
                continue
            k = p.get("type")
            if k == "text" and p.get("text"):
                if t == "user" and noise(p["text"]):
                    continue
                out.append({"role": t, "text": p["text"], "time": ts})
            elif k == "tool_use":
                out.append({"role": "tool", "text": tool_line(p.get("name", "tool"), p.get("input")), "time": ts})
    return out


# ---------- Codex ----------

def codex_items(path):
    for d in jsonl(path):
        p = d.get("payload") or {}
        yield d, p


def codex_index(path):
    sid = cwd = first = None
    created = updated = turns = 0
    for d, p in codex_items(path):
        ts = ms(d.get("timestamp"))
        if d.get("type") == "session_meta":
            src = p.get("source")
            if isinstance(src, dict) and "subagent" in src:
                return None  # reviewer/sub-agent threads, not a conversation
            sid = p.get("id") or p.get("session_id")
            cwd = p.get("cwd")
            created = ms(p.get("timestamp")) or ts
        if ts:
            updated = max(updated, ts)
        if d.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
            text = text_of(p.get("content"))
            if text and not noise(text):
                turns += 1
                first = first or text
    if not sid or not turns:
        return None
    return {"agent": "codex", "id": sid, "file": path, "cwd": cwd, "created": created,
            "updated": updated, "turns": turns, "title": clip(first, TITLE_MAX)}


def codex_show(path):
    out = []
    for d, p in codex_items(path):
        if d.get("type") != "response_item":
            continue
        ts = ms(d.get("timestamp"))
        k = p.get("type")
        if k == "message" and p.get("role") in ("user", "assistant"):
            text = text_of(p.get("content"))
            if text and not (p["role"] == "user" and noise(text)):
                out.append({"role": p["role"], "text": text, "time": ts})
        elif k in ("function_call", "custom_tool_call", "local_shell_call"):
            out.append({"role": "tool", "time": ts,
                        "text": tool_line(p.get("name") or "shell", p.get("arguments") or p.get("input") or p.get("action"))})
    return out


def codex_titles():
    names = {}
    path = os.path.join(HOME, ".codex", "session_index.jsonl")
    if os.path.exists(path):
        for d in jsonl(path):
            if d.get("id") and d.get("thread_name"):
                names[d["id"]] = d["thread_name"]
    return names


# ---------- Pi ----------

def pi_index(path):
    sid = cwd = title = first = None
    created = updated = turns = 0
    for d in jsonl(path):
        ts = ms(d.get("timestamp"))
        updated = max(updated, ts)
        if d.get("type") == "session":
            sid, cwd, created = d.get("id"), d.get("cwd"), ts
        elif d.get("type") == "session_info":
            title = d.get("name")
        elif d.get("type") == "message":
            m = d.get("message") or {}
            if m.get("role") == "user":
                text = text_of(m.get("content"))
                if text and not noise(text):
                    turns += 1
                    first = first or text
    if not sid or not turns:
        return None
    return {"agent": "pi", "id": sid, "file": path, "cwd": cwd, "created": created,
            "updated": updated, "turns": turns, "title": clip(title or first, TITLE_MAX)}


def pi_show(path):
    out = []
    for d in jsonl(path):
        if d.get("type") != "message":
            continue
        m = d.get("message") or {}
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        ts = ms(d.get("timestamp") or m.get("timestamp"))
        content = m.get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        # Match the other readers: show visible text and tool calls, omitting
        # thinking, images and tool results that would duplicate the call list.
        for p in content or []:
            if not isinstance(p, dict):
                continue
            if p.get("type") == "text" and p.get("text"):
                if role == "user" and noise(p["text"]):
                    continue
                out.append({"role": role, "text": p["text"], "time": ts})
            elif role == "assistant" and p.get("type") == "toolCall":
                out.append({"role": "tool", "text": tool_line(p.get("name", "tool"), p.get("arguments")), "time": ts})
    return out


# ---------- Cursor ----------

_CURSOR_USER_QUERY = re.compile(r"<user_query>\s*(.*?)\s*</user_query>", re.S)
_CURSOR_ABS_PATH = re.compile(r"(/Users/[^\s\"'<>]+)")
_cursor_cwd_cache = {}
_cursor_slug_map = None


def cursor_encode_slug(path):
    return path.lstrip("/").replace("/", "-")


def cursor_workspace_slugs():
    """folder path -> slug from Cursor workspaceStorage (exact, not guessed)."""
    global _cursor_slug_map
    if _cursor_slug_map is not None:
        return _cursor_slug_map
    mapping = {}
    root = os.path.join(HOME, "Library", "Application Support", "Cursor", "User", "workspaceStorage")
    if os.path.isdir(root):
        for name in os.listdir(root):
            meta = os.path.join(root, name, "workspace.json")
            if not os.path.isfile(meta):
                continue
            try:
                with open(meta, encoding="utf-8") as f:
                    folder = (json.load(f) or {}).get("folder") or ""
            except (OSError, ValueError):
                continue
            path = file_uri_path(folder)
            if path:
                mapping[cursor_encode_slug(path)] = path
    _cursor_slug_map = mapping
    return mapping


def cursor_slug_to_path(slug):
    """Rebuild /a/b/c from Cursor's a-b-c slug by walking existing dirs (hyphen-safe)."""
    if not slug or slug.startswith(".") or slug.isdigit():
        return None
    known = cursor_workspace_slugs().get(slug)
    if known:
        return known
    remaining = slug.split("-")
    path = ""
    while remaining:
        found = None
        for i in range(len(remaining), 0, -1):
            trial = f"{path}/{'-'.join(remaining[:i])}"
            if os.path.isdir(trial):
                found = trial
                remaining = remaining[i:]
                path = trial
                break
        if not found:
            break
    # Only accept a full consume — partial parents are too broad for 本目录.
    if remaining or not path or not os.path.isdir(path):
        return None
    return path


def cursor_cwd_from_transcript(path, slug=None):
    """Last-resort: absolute paths mentioned in the first transcript lines."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            head = f.read(12000)
    except OSError:
        return None
    candidates = []
    for m in _CURSOR_ABS_PATH.finditer(head):
        p = m.group(1).rstrip("\",'")
        # Prefer real project roots over .cursor/projects/... asset paths.
        if "/.cursor/" in p or "/Library/" in p:
            continue
        if os.path.isdir(p):
            candidates.append(p)
        else:
            parent = os.path.dirname(p)
            if os.path.isdir(parent) and "/.cursor/" not in parent:
                candidates.append(parent)
    if not candidates:
        return None
    # Exact slug match first, then longest path whose slug is a prefix of the project slug.
    if slug:
        for c in sorted(set(candidates), key=len, reverse=True):
            if cursor_encode_slug(c) == slug:
                return c
        for c in sorted(set(candidates), key=len, reverse=True):
            enc = cursor_encode_slug(c)
            if slug.startswith(enc + "-") or slug == enc:
                return c
    # Fall back to the most common mention (stable project root beats deep temps).
    freq = {}
    for c in candidates:
        freq[c] = freq.get(c, 0) + 1
    return max(freq, key=lambda c: (freq[c], -len(c)))


def cursor_project_cwd(project_dir, transcript_path=None):
    """Recover workspace path: terminals → workspaceStorage → slug walk → transcript."""
    if project_dir in _cursor_cwd_cache:
        return _cursor_cwd_cache[project_dir]
    slug = os.path.basename(project_dir)
    cwd = None
    term = os.path.join(project_dir, "terminals")
    if os.path.isdir(term):
        for name in sorted(os.listdir(term)):
            path = os.path.join(term, name)
            if not name.endswith(".txt") or not os.path.isfile(path):
                continue
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    head = f.read(800)
            except OSError:
                continue
            m = re.search(r'(?m)^cwd:\s*"([^"]+)"', head) or re.search(r"(?m)^cwd:\s*(\S+)", head)
            if m:
                cwd = m.group(1).strip('"')
                break
    if not cwd:
        cwd = cursor_slug_to_path(slug)
    if not cwd and transcript_path:
        cwd = cursor_cwd_from_transcript(transcript_path, slug)
    _cursor_cwd_cache[project_dir] = cwd
    return cwd


def cursor_user_text(raw):
    if not raw:
        return ""
    m = _CURSOR_USER_QUERY.search(raw)
    return (m.group(1) if m else raw).strip()


def cursor_index(path):
    # .../project/agent-transcripts/<id>/<id>.jsonl
    project_dir = os.path.dirname(os.path.dirname(path))
    slug = os.path.basename(project_dir)
    # Cleanup dumps and numeric composer buckets are not real workspaces.
    if slug.startswith(".agent-data-cleanup") or slug.isdigit():
        return None
    sid = os.path.splitext(os.path.basename(path))[0]
    if sid.startswith("agent-"):
        sid = sid[len("agent-"):]
    first = None
    turns = 0
    try:
        st = os.stat(path)
        updated = int(st.st_mtime * 1000)
        created = int(st.st_ctime * 1000)
    except OSError:
        return None
    for d in jsonl(path):
        if d.get("role") != "user":
            continue
        text = cursor_user_text(text_of((d.get("message") or {}).get("content"), ("text",)))
        if text and not noise(text):
            turns += 1
            first = first or text
    if not turns:
        return None
    return {"agent": "cursor", "id": sid, "file": path,
            "cwd": cursor_project_cwd(project_dir, path),
            "created": created, "updated": updated, "turns": turns, "title": clip(first, TITLE_MAX)}


def cursor_show(path):
    out = []
    for d in jsonl(path):
        role = d.get("role")
        if role not in ("user", "assistant"):
            continue
        content = (d.get("message") or {}).get("content")
        if role == "user":
            text = cursor_user_text(text_of(content, ("text",)))
            if text and not noise(text):
                out.append({"role": "user", "text": text, "time": 0})
            continue
        text = text_of(content, ("text",))
        if text:
            out.append({"role": "assistant", "text": text, "time": 0})
        for p in content or [] if isinstance(content, list) else []:
            if isinstance(p, dict) and p.get("type") == "tool_use":
                out.append({"role": "tool", "text": tool_line(p.get("name", "tool"), p.get("input")), "time": 0})
    return out


# ---------- OpenCode ----------

def opencode_db_paths():
    root = os.path.join(HOME, ".local", "share", "opencode")
    if not os.path.isdir(root):
        return []
    dbs = [os.path.join(root, n) for n in os.listdir(root) if n.endswith(".db") and not n.endswith("-wal") and not n.endswith("-shm")]
    # Prefer the main db; still scan others for older machines.
    dbs.sort(key=lambda p: (0 if os.path.basename(p) == "opencode.db" else 1, -os.path.getsize(p) if os.path.exists(p) else 0))
    return dbs


def opencode_index_db(db_path):
    sessions = []
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return sessions
    try:
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        table = "session_v2" if "session_v2" in tables else ("session" if "session" in tables else None)
        if not table:
            return sessions
        cols = {c[1] for c in con.execute(f"PRAGMA table_info({table})")}
        has_parent = "parent_id" in cols
        msg_table = "session_message" if "session_message" in tables else None
        rows = con.execute(
            f"SELECT id, directory, title, time_created, time_updated"
            + (", parent_id" if has_parent else ", NULL")
            + f" FROM {table}"
        ).fetchall()
        for sid, directory, title, created, updated, parent_id in rows:
            if parent_id:
                continue
            turns = 0
            first = None
            if msg_table:
                for data, in con.execute(
                    f"SELECT data FROM {msg_table} WHERE session_id=? AND type='user' ORDER BY seq LIMIT 20",
                    (sid,),
                ):
                    try:
                        payload = json.loads(data) if isinstance(data, str) else {}
                    except ValueError:
                        payload = {}
                    text = payload.get("text") or text_of(payload.get("content"))
                    if text and not noise(text):
                        turns += 1
                        first = first or text
            if not turns and not title:
                continue
            sessions.append({
                "agent": "opencode", "id": sid, "file": f"opencode:{db_path}:{sid}",
                "cwd": directory or None, "created": int(created or 0), "updated": int(updated or created or 0),
                "turns": turns or 1, "title": clip(title or first or sid, TITLE_MAX),
            })
    except sqlite3.Error:
        return sessions
    finally:
        con.close()
    return sessions


def opencode_list():
    seen, out = set(), []
    for db in opencode_db_paths():
        for s in opencode_index_db(db):
            if s["id"] in seen:
                continue
            seen.add(s["id"])
            out.append(s)
    return out


def opencode_show(ref):
    # ref: opencode:/path/to.db:ses_xxx
    if not ref.startswith("opencode:") or ref.count(":") < 2:
        return []
    _, db_path, sid = ref.split(":", 2)
    out = []
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return out
    try:
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "session_message" in tables:
            rows = con.execute(
                "SELECT type, data, time_created FROM session_message WHERE session_id=? ORDER BY seq",
                (sid,),
            ).fetchall()
            for typ, data, ts in rows:
                try:
                    payload = json.loads(data) if isinstance(data, str) else {}
                except ValueError:
                    continue
                if typ == "user":
                    text = payload.get("text") or text_of(payload.get("content"))
                    if text and not noise(text):
                        out.append({"role": "user", "text": text, "time": int(ts or 0)})
                elif typ == "assistant":
                    for p in payload.get("content") or []:
                        if not isinstance(p, dict):
                            continue
                        if p.get("type") == "text" and p.get("text"):
                            out.append({"role": "assistant", "text": p["text"], "time": int(ts or 0)})
                        elif p.get("type") == "tool":
                            out.append({"role": "tool", "time": int(ts or 0),
                                        "text": tool_line(p.get("tool") or p.get("name") or "tool",
                                                          (p.get("state") or {}).get("input") or p.get("input"))})
        if "part" in tables and not out:
            # Older rows sometimes live only in part.
            for data, ts in con.execute(
                "SELECT data, time_created FROM part WHERE session_id=? ORDER BY time_created", (sid,)
            ):
                try:
                    p = json.loads(data) if isinstance(data, str) else {}
                except ValueError:
                    continue
                if p.get("type") == "text" and p.get("text"):
                    out.append({"role": "assistant", "text": p["text"], "time": int(ts or 0)})
                elif p.get("type") == "tool":
                    out.append({"role": "tool", "time": int(ts or 0),
                                "text": tool_line(p.get("tool") or "tool",
                                                  (p.get("state") or {}).get("input") or p.get("input"))})
    except sqlite3.Error:
        pass
    finally:
        con.close()
    return out


# ---------- Antigravity (agy / Gemini CLI agent) ----------

_AGY_REQUEST = re.compile(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", re.S)
_AGY_TOOLS = {"RUN_COMMAND", "LIST_DIRECTORY", "VIEW_FILE", "CODE_ACTION", "GREP_SEARCH", "SEARCH_WEB"}


def agy_user_text(raw):
    if not raw:
        return ""
    m = _AGY_REQUEST.search(raw)
    return (m.group(1) if m else raw).strip()


def agy_meta():
    path = os.path.join(HOME, ".gemini", "antigravity-cli", "cache", "conversation_metadata.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("conversations") or {}
    except (OSError, ValueError):
        return {}


def agy_transcript(sid):
    base = os.path.join(HOME, ".gemini", "antigravity-cli", "brain", sid, ".system_generated", "logs")
    for name in ("transcript.jsonl", "transcript_full.jsonl"):
        path = os.path.join(base, name)
        if os.path.isfile(path):
            return path
    return None


def antigravity_list():
    out = []
    for sid, entry in agy_meta().items():
        summary = (entry or {}).get("summary") or {}
        if summary.get("Internal") or (entry or {}).get("is_internal"):
            continue
        cwd = None
        for uri in summary.get("WorkspaceURIs") or []:
            cwd = file_uri_path(uri)
            if cwd:
                break
        title = summary.get("Title") or summary.get("Preview") or ""
        updated = ms(summary.get("UpdatedAt") or (entry or {}).get("last_modified_time"))
        created = updated
        turns = max(1, int(summary.get("NumSteps") or 0) // 20) if summary.get("NumSteps") else 1
        path = agy_transcript(sid)
        if path:
            try:
                st = os.stat(path)
                updated = max(updated, int(st.st_mtime * 1000))
                created = int(st.st_ctime * 1000) or updated
            except OSError:
                pass
            # Prefer first user turn as title when preview is generic.
            if not title or title in ("Friendly Casual Greeting",):
                for d in jsonl(path):
                    if d.get("type") == "USER_INPUT":
                        text = agy_user_text(d.get("content"))
                        if text:
                            title = text
                            break
            user_turns = sum(1 for d in jsonl(path) if d.get("type") == "USER_INPUT")
            if user_turns:
                turns = user_turns
        if not title and not path:
            continue
        out.append({
            "agent": "antigravity", "id": sid, "file": path or f"agy:{sid}",
            "cwd": cwd, "created": created, "updated": updated, "turns": turns,
            "title": clip(title or sid, TITLE_MAX),
        })
    return out


def antigravity_show(ref):
    path = ref
    if ref.startswith("agy:"):
        path = agy_transcript(ref[4:]) or ""
    if not path or not os.path.isfile(path):
        return []
    out = []
    for d in jsonl(path):
        t = d.get("type")
        ts = ms(d.get("created_at"))
        if t == "USER_INPUT":
            text = agy_user_text(d.get("content"))
            if text:
                out.append({"role": "user", "text": text, "time": ts})
        elif t == "PLANNER_RESPONSE":
            text = (d.get("content") or "").strip()
            if text:
                out.append({"role": "assistant", "text": text, "time": ts})
        elif t in _AGY_TOOLS:
            out.append({"role": "tool", "text": f"{t} · {clip(d.get('content') or '', 200)}", "time": ts})
    return out


# ---------- driver ----------

def file_sources():
    for f in glob.glob(os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")):
        yield "claude", f
    for f in glob.glob(os.path.join(HOME, ".codex", "sessions", "*", "*", "*", "*.jsonl")):
        yield "codex", f
    pi_home = os.path.expanduser(os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(HOME, ".pi", "agent"))
    pi_sessions = os.path.expanduser(os.environ.get("PI_CODING_AGENT_SESSION_DIR") or os.path.join(pi_home, "sessions"))
    for f in glob.glob(os.path.join(pi_sessions, "**", "*.jsonl"), recursive=True):
        yield "pi", f
    for f in glob.glob(os.path.join(HOME, ".cursor", "projects", "*", "agent-transcripts", "*", "*.jsonl")):
        yield "cursor", f


def index_file(agent, path):
    if agent == "claude":
        return claude_index(path)
    if agent == "codex":
        return codex_index(path)
    if agent == "pi":
        return pi_index(path)
    if agent == "cursor":
        return cursor_index(path)
    return None


def cached_bundle(files, key, stamp, builder):
    hit = files.get(key)
    if hit and hit.get("stamp") == stamp:
        return hit.get("sessions") or [], True
    try:
        sessions = builder()
    except Exception:
        sessions = []
    files[key] = {"stamp": stamp, "sessions": sessions}
    return sessions, False


def cmd_list(cwd_filter=None):
    try:
        with open(CACHE) as f:
            cache = json.load(f)
        if cache.get("v") != CACHE_VERSION:
            cache = {}
    except (OSError, ValueError):
        cache = {}
    files = cache.get("files", {})
    fresh, sessions = {}, []
    for agent, path in file_sources():
        try:
            st = os.stat(path)
        except OSError:
            continue
        stamp = [int(st.st_mtime * 1000), st.st_size]
        hit = files.get(path)
        if hit and hit.get("stamp") == stamp:
            entry = hit.get("session")
        else:
            try:
                entry = index_file(agent, path)
            except Exception:  # one unreadable transcript never hides the rest
                entry = None
        fresh[path] = {"stamp": stamp, "session": entry}
        if entry:
            sessions.append(entry)

    # OpenCode: one cache entry per db file.
    for db in opencode_db_paths():
        try:
            st = os.stat(db)
        except OSError:
            continue
        stamp = [int(st.st_mtime * 1000), st.st_size]
        key = f"opencode-db:{db}"
        bundled, _ = cached_bundle(fresh, key, stamp, lambda db=db: opencode_index_db(db))
        sessions.extend(bundled)

    # Antigravity: cache on metadata file stamp.
    meta_path = os.path.join(HOME, ".gemini", "antigravity-cli", "cache", "conversation_metadata.json")
    try:
        st = os.stat(meta_path)
        stamp = [int(st.st_mtime * 1000), st.st_size]
    except OSError:
        stamp = [0, 0]
    bundled, _ = cached_bundle(fresh, "antigravity-meta", stamp, antigravity_list)
    sessions.extend(bundled)

    try:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        tmp = CACHE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"v": CACHE_VERSION, "files": fresh}, f)
        os.replace(tmp, CACHE)
    except OSError:
        pass
    names = codex_titles()
    for s in sessions:
        if s["agent"] == "codex" and s["id"] in names:
            s["title"] = clip(names[s["id"]], TITLE_MAX)
    if cwd_filter:
        cwd_filter = os.path.normpath(os.path.expanduser(cwd_filter))
        sessions = [s for s in sessions if related_cwd(s.get("cwd"), cwd_filter)]
    sessions.sort(key=lambda s: s.get("updated") or 0, reverse=True)
    return sessions


def cmd_show(agent, ref):
    if agent == "claude":
        msgs = claude_show(ref)
    elif agent == "codex":
        msgs = codex_show(ref)
    elif agent == "pi":
        msgs = pi_show(ref)
    elif agent == "cursor":
        msgs = cursor_show(ref)
    elif agent == "opencode":
        msgs = opencode_show(ref)
    elif agent == "antigravity":
        msgs = antigravity_show(ref)
    else:
        msgs = []
    # Merge consecutive tool lines so a long tool burst reads as one block.
    merged = []
    for m in msgs:
        m["text"] = clip(m["text"].strip(), TEXT_MAX)
        if not m["text"]:
            continue
        if merged and m["role"] == "tool" and merged[-1]["role"] == "tool":
            merged[-1]["text"] += "\n" + m["text"]
        else:
            merged.append(m)
    total = len(merged)
    return {"total": total, "messages": merged[-SHOW_MAX:]}


def main():
    args = sys.argv[1:]
    if args[:1] == ["list"]:
        cwd = None
        rest = args[1:]
        if rest[:1] == ["--cwd"] and len(rest) >= 2:
            cwd = rest[1]
            rest = rest[2:]
        if rest:
            print(__doc__, file=sys.stderr)
            sys.exit(2)
        result = cmd_list(cwd)
    elif args[:1] == ["show"] and len(args) == 3:
        result = cmd_show(args[1], args[2])
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
