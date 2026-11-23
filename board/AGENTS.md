# board — herdr-app 项目看板（Trello 风格）

集中存储在 `~/.config/herdr-app/board/tasks.json`，配合 5 列看板面板（`mods/board`）和侧栏入口（`mods/board-entry`），支持把灵感/待办与具体项目绑定，并实时联动 Herdr 运行中的 Agent。

## 5 个列

- `ideas` — 💡 灵感池（先记下来，暂时不开发）
- `todo` — 📋 待开发（明确要做，准备派给 Agent 或自己动手）
- `doing` — ⚙️ 进行中（同时自动展示正在 `working` 的实时 Agent）
- `review` — 👀 待验收（自动浮起 `blocked` / `done` 等待你处理的 Agent）
- `done` — ✅ 已完成

## CLI：`herdr-board`

已软链到 `~/.local/bin/herdr-board`：

```bash
# 记一个灵感，并自动绑定当前仓库项目
herdr-board add --title "回放导出改成 WebWorker" --notes "避免主线程卡顿" --col ideas --here --priority p2 --tags perf

# 添加到某项目的待开发列
herdr-board add --title "修复 health 路由路径" --col todo --project my-app --path ~/projects/my-app --priority p1

# 查看看板任务
herdr-board ls [--col ideas|todo|doing|review|done] [--project NAME] [--json]

# 移动列 / 编辑 / 删除 / 统计
herdr-board move <id> todo
herdr-board edit <id> --priority p1 --notes "补充上下文"
herdr-board rm <id>
herdr-board stats [--json]
```
