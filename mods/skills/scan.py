#!/usr/bin/env python3
"""Scan installed Skills across ~/.agents, ~/.claude, ~/.cursor, ~/.codex, and optional project cwd."""
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
AGENTS_DIR = os.path.join(HOME, ".agents", "skills")
CLAUDE_DIR = os.path.join(HOME, ".claude", "skills")
CURSOR_DIR = os.path.join(HOME, ".cursor", "skills")
CODEX_DIR = os.path.join(HOME, ".codex", "skills")


def parse_frontmatter(skill_md):
    desc = ""
    name = ""
    try:
        with open(skill_md, "r", encoding="utf-8", errors="replace") as f:
            head = f.read(1600)
        m_name = re.search(r"(?m)^name:\s*(.+)$", head)
        if m_name:
            name = m_name.group(1).strip().strip('"').strip("'")
        m = re.search(r"(?m)^description:\s*(.+)$", head)
        if m:
            d = m.group(1).strip().strip('"').strip("'")
            if d in ("|", ">", "|-", ">-"):
                lines = []
                for ln in head[m.end():].splitlines():
                    if ln.strip() and (ln.startswith(" ") or ln.startswith("\t")):
                        lines.append(ln.strip())
                    elif lines:
                        break
                d = " ".join(lines)
            desc = d
    except OSError:
        pass
    return name, desc[:180]


def check_target(root, entry):
    p = os.path.join(root, entry)
    if os.path.islink(p):
        return "ok" if os.path.isfile(os.path.join(p, "SKILL.md")) else "broken"
    if os.path.isdir(p) and os.path.isfile(os.path.join(p, "SKILL.md")):
        return "dir"
    return None


def scan(cwd=None):
    skills = {}

    def add_root(root, source):
        if not root or not os.path.isdir(root):
            return
        for entry in sorted(os.listdir(root)):
            if entry.startswith(".") or entry.startswith("_"):
                continue
            full = os.path.join(root, entry)
            skill_md = os.path.join(full, "SKILL.md")
            if not os.path.isfile(skill_md):
                continue
            key = f"proj:{entry}" if source == "project" else entry
            if key in skills:
                continue
            fm_name, desc = parse_frontmatter(skill_md)
            real_md = os.path.realpath(skill_md)
            in_agents = os.path.isdir(os.path.join(AGENTS_DIR, entry)) and os.path.isfile(
                os.path.join(AGENTS_DIR, entry, "SKILL.md")
            )
            skills[key] = {
                "id": key,
                "name": entry,
                "display": fm_name or entry,
                "desc": desc,
                "path": real_md,
                "dir": os.path.realpath(full),
                "source": source,
                "canSync": bool(in_agents and source != "project"),
                "sync": {
                    "claude": check_target(CLAUDE_DIR, entry),
                    "cursor": check_target(CURSOR_DIR, entry),
                    "codex": check_target(CODEX_DIR, entry),
                } if source != "project" else None,
            }

    add_root(AGENTS_DIR, "agents")
    add_root(CLAUDE_DIR, "claude")
    add_root(CURSOR_DIR, "cursor")
    add_root(CODEX_DIR, "codex")
    if cwd:
        add_root(os.path.join(cwd, ".claude", "skills"), "project")

    out = sorted(
        skills.values(),
        key=lambda x: (
            0 if x["source"] == "project" else 1 if x["source"] == "agents" else 2,
            x["name"].lower(),
        ),
    )
    return out


if __name__ == "__main__":
    cwd = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    json.dump(scan(cwd), sys.stdout, ensure_ascii=False)
