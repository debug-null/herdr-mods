# sched — herdr-app 定时任务

给 agent 的接口说明。调度引擎是 `engine.py`，跑在名为 `sched-engine` 的常驻
herdr-core 终端里（herdr-app 关了任务照跑；机器/core 重启后由侧栏 `sched-entry`
或面板 `sched` 自动拉起）。

## 优先用 CLI：`herdr-sched`

已软链至 `~/.local/bin/herdr-sched`（指向 `~/.config/herdr-app/sched/sched`，避开 zsh 内建 `sched` 命令）：

```bash
# 建任务（三种动作）
herdr-sched add --name 每刻检查 --every 15 --cmd "just test" --here --timeout 300 --notify err
herdr-sched add --name 检查构建 --in 15 --self --text "检查刚才的构建状态" --notify always
herdr-sched add --name 提醒 --cron "0 18 * * 5" --terminal t18 --text "周五了，收工" --if idle
herdr-sched add --name 夜审 --at "2026-11-21 02:00" --argv claude --task "review 今天的 diff" --here

# 触发 / 查看 / 管理
herdr-sched run <id>          # 立即触发（禁用状态也能跑）
herdr-sched ls [--json]       # 任务 + 下次/上次运行 + 耗时
herdr-sched logs <id> -n 5    # 最近运行历史与输出日志（支持 --json）
herdr-sched enable|disable|rm <id>
herdr-sched status [--json]   # 引擎心跳 + 运行中任务数
```

`add` 打印新 job id。时间表四选一：`--every 分钟`（≥0.5）/ `--cron "分 时 日 月 周"` /
`--at "YYYY-MM-DD HH:MM"` / `--in 分钟`（相对当前时间的一次性任务，跑完自动禁用）。
`--self` 自动识别当前 Herdr 终端（`$HC_TERMINAL_ID`）并默认 `--if idle`。
`--here` 自动使用当前目录作为 `--cwd` / `--folder`。
`--notify err|always` 让侧栏常驻模块弹 toast（失败时附提示音）。

## 文件协议（不想调 CLI 时）

- `jobs.json`：任务定义。改写整个文件（读-改-写，engine 1s 内按 mtime 热加载）。
- `run-now`：每行一个 job id，立即触发（禁用/已完成也跑，engine 读后删文件）。
- `state.json`（只读，引擎写）：
  - `engine.{pid,started_at,heartbeat,jobs_error,running}`
  - `jobs.<id>.{running,running_since,next_run,last_run,last_duration_ms,last_status,last_msg,run_count,history}`
    其中 `history` 保留最近 12 次执行记录 `{ts,duration_ms,status,msg,forced}`。
- `alerts`（引擎写，侧栏 `sched-entry` 消费）：notify 命中的 JSON 行。
- `engine.log`：引擎日志。

job 结构见 `engine.py` 顶部 docstring。同一 job 前次未跑完会跳过重叠触发。
