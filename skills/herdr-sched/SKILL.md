---
name: herdr-sched
description: Create, list, inspect, run, pause, or delete background scheduled tasks in Herdr (`herdr-sched`). Use whenever the user asks to schedule a recurring or one-shot task, set a reminder for this or another agent, run a command periodically, spawn an agent later/nightly/daily, check scheduled job status or logs, or says "定时任务", "定时提醒", "每天/每小时/过几分钟帮我...", "到点启动一个 agent", or "查看定时任务". Tasks run in a persistent `herdr-core` engine and keep running even when Herdr closes.
---

# Herdr Scheduler (`herdr-sched`)

Use the `herdr-sched` CLI (symlinked at `~/.local/bin/herdr-sched` → `~/.config/herdr-app/sched/sched`) to manage persistent scheduled tasks. The scheduler engine runs in `herdr-core` (`sched-engine`), so tasks keep running even after `herdr-app` closes, and toast alerts are delivered automatically via the sidebar `sched-entry` mod.

> Avoid running bare `sched` in zsh — `sched` is a zsh built-in command. Always use `herdr-sched`.

## Quick Reference

```bash
# 1) Periodic or scheduled Shell command
herdr-sched add --name "测试巡检" --every 30 --cmd "pnpm test" --here --notify err
herdr-sched add --name "每日拉取" --cron "0 9 * * 1-5" --cmd "git fetch --all" --cwd ~/repo --timeout 300 --notify err

# 2) Remind the CURRENT agent session (--self auto-uses $HC_TERMINAL_ID and defaults to --if idle)
herdr-sched add --name "检查构建" --in 15 --self --text "检查刚才的构建是否通过，如果失败帮我定位原因" --notify always

# 3) Send a scheduled prompt to a specific terminal/agent
herdr-sched add --name "周五收工提醒" --cron "0 18 * * 5" --terminal t18 --text "总结本周改动" --if idle --notify always

# 4) Spawn a brand-new Agent tab on a schedule
herdr-sched add --name "夜间代码审查" --cron "0 22 * * *" --argv "claude" \
  --task "review 今天的 git diff 并汇总潜在风险" --here --notify always

# Inspect & manage
herdr-sched ls                 # list jobs, next/last run, duration (--json for structured output)
herdr-sched logs <id> -n 5     # show recent run history and stdout/stderr (--json supported)
herdr-sched run <id>           # trigger immediately (works even if disabled)
herdr-sched enable <id>        # resume a paused job
herdr-sched disable <id>       # pause a job
herdr-sched rm <id>            # delete a job
herdr-sched status             # engine heartbeat & running count (--json supported)
```

## Schedule Options (pick one)

- `--every MIN`: interval in minutes (`>= 0.5`).
- `--cron "M H D MON W"`: 5-field Vixie cron (`0 9 * * 1-5` = weekdays 09:00).
- `--at "YYYY-MM-DD HH:MM"`: one-shot at local date/time (auto-disables after running).
- `--in MIN`: one-shot after `MIN` minutes from now (convenient for "10 分钟后提醒我…").

## Action Options (pick one)

1. **Shell (`--cmd`)**: runs via `/bin/sh -c`. Use `--here` for the current working directory or `--cwd DIR`, optional `--timeout SEC` (default 600).
2. **Prompt existing agent/terminal (`--self` or `--terminal <addr>`, plus `--text`)**: sends text via `hc send`.
   - `--self` resolves `$HC_TERMINAL_ID` automatically and defaults to `--if idle` so it won't interrupt an active turn. Pass `--if always` to send unconditionally.
3. **Spawn new agent (`--argv "<cmd>"`)**: opens a new Herdr tab in the background (pass `--focus` to foreground it) and sends `--task "..."`. Use `--here` or `--folder DIR`, optional `--tab-name`.

## Guidelines for Agents

1. **Check engine health first** if unsure: `herdr-sched status`. If `engine: dead`, open Scheduler (`herdr-app do sched-entry.open`) or restart `sched-engine` via `hc`.
2. **Pick sensible notifications**: default to `--notify err` for background shell checks and `--notify always` for user-requested reminders or agent spawns, unless the user specifies otherwise.
3. **Confirm key details concisely** after creating a job: report the created job ID, schedule, action target, and how to inspect/cancel it (`herdr-sched ls` / `herdr-sched rm <id>` or in Herdr's Scheduler panel).
4. **Destructive actions**: before removing or disabling jobs the user didn't explicitly name, run `herdr-sched ls` first to confirm the exact ID.
