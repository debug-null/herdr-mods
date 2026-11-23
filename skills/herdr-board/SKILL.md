---
name: herdr-board
description: Manage the user's project-linked Kanban/Trello board in Herdr (`herdr-board`) with 5 columns: ideas (灵感池), todo (待开发), doing (进行中), review (待验收), done (已完成). Use whenever the user says "记个灵感", "放到待办", "加到看板", "先记下来以后再做", "看看看板/待办", "把这个任务标成完成", "移到待开发", or wants to capture an idea/task linked to the current or named project.
---

# Herdr Project Board (`herdr-board`)

Use the `herdr-board` CLI (`~/.local/bin/herdr-board` → `~/.config/herdr-app/board/board`) to capture ideas, manage project-linked todos, and move cards across the 5-column Kanban board in Herdr (`ideas` → `todo` → `doing` → `review` → `done`).

## Quick Reference

```bash
# Capture a new idea linked to the current git repo / folder (--here)
herdr-board add --title "回放导出改成 WebWorker" --notes "避免主线程录屏卡顿" --col ideas --here --priority p2 --tags perf

# Add directly to Todo for a specific project
herdr-board add --title "补齐 health 路由单测" --col todo --project my-app --path ~/projects/my-app --priority p1

# List / filter tasks
herdr-board ls                         # grouped by column
herdr-board ls --project my-app
herdr-board ls --col todo --json

# Move / edit / delete / stats
herdr-board move <id> doing
herdr-board move <id> done
herdr-board edit <id> --priority p1 --notes "补充实现细节"
herdr-board rm <id>
herdr-board stats
```

## Guidelines for Agents

1. **Always link to a project when working inside a repo**: pass `--here` so the card automatically binds to the current git root (or pass `--project <name> --path <dir>` if the user specifies another repo).
2. **Choose the right column**:
   - "突然想到/暂时不做/记个想法/灵感" → `--col ideas`
   - "接下来要做/待开发/加到 TODO" → `--col todo`
   - "正在做" → `--col doing`
   - "等验收/待确认" → `--col review`
   - "做完了/标成完成" → `--col done`
3. **Write actionable `--notes`**: include enough concrete context (files, goal, constraints) so the user can later click **「派给 Agent」** on the Board UI and kick off an agent immediately without re-explaining.
4. **Confirm concisely**: report the created/updated task ID, column, linked project, and note that it's immediately visible in Herdr's Board panel.
