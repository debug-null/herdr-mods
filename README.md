# herdr-mods

Personal [Herdr Desktop](https://herdr.dev) mod suite — 一套深度定制、全中文优化的 AI Coding Agent 桌面工作台套件（项目看板、后台定时任务、跨机每日会话反思、技能管理、图片插针批注、指令库、可视化快捷键墙与 6 套精调主题），开箱即可同步到任意 Mac。

Previously published alone: [`herdr-open-in-editor`](https://github.com/debug-null/herdr-open-in-editor) (now included under `mods/open-in-editor`).

## 包含模块

### 核心工作台（宽屏 / 侧栏 / 弹窗）

| 模块 | 说明 | 快捷入口 |
|---|---|---|
| `mods/board` + `mods/board-entry` | **5 列项目看板（Trello 风格）**：灵感池 → 待开发 → 进行中 → 待验收 → 已完成；支持 GPU 弹簧物理拖拽跨列与排序、宽/半屏(3+2 网格)/窄屏自适应、行内回车极速建卡、实时同步活跃 Agent 会话、一键「立即/定时派给 Agent」 | 左侧栏顶部 `Board` · `⌘⇧K` 打开 · `⌘⇧I` 全局闪记 |
| `mods/sched` + `mods/sched-entry` | **后台定时任务系统**：常驻 `herdr-core` 引擎（关窗照跑）、支持 Shell / 发消息 / 启动新 Agent、12 条运行历史与输出查看、内置命令速查弹窗、常驻侧栏 Toast 告警 | 左侧栏底部 `Scheduler` · `⌘⇧J` |
| `mods/status-pro` | **增强底部状态栏**：macOS Dock 未回复红点 (`setBadge`) + 动态窗口标题 + 一键换肤浮窗 + 极简番茄专注计时器 + 技能/指令库/快捷键入口 | 窗口底部状态栏 |
| `mods/prompts` | **高频 Prompt 指令库**：Raycast 风格搜索、分类筛选、键盘 `↑↓ + ↵` 一键发送给当前聚焦 Agent、增删改置顶（持久化 `prompts.json`） | `⌘⇧Y` · 状态栏 `指令库` |
| `mods/keybinds` | **中文可视化快捷键速查墙**：实时读取 `keys.json` 分区展示 macOS 立体键帽，支持搜索与点击直接执行 | `⌘⇧/` · 状态栏 `快捷键` |
| `mods/spaces-icons` | **真实项目图标侧栏**：自动发现 `.herdr/icon.*` / SVG / PNG / favicon，`.ico` 自动用 `sips` 转高清 64×64 PNG 缓存 | 左侧 `Spaces` 列表 |

### 右侧面板工具集（`panel-body`）

| 模块 | 说明 |
|---|---|
| `mods/files-md` + `mods/md-preview` | 文件浏览器 + **跨项目全文内容/文件名搜索**（`rg` 优先、无 `rg` 降级 `grep`）+ **文件内实时查找高亮（`⌘F`）** + Markdown 预览 |
| `mods/changes-scm` | Git 变更管理与 Diff 浮窗 |
| `mods/history` | 跨机多 Agent 会话历史（Claude / Codex / Cursor / Devin / Pi / OpenCode / Antigravity），自动过滤 `claude-mem` 噪音、支持时间分组、全局天数切换、会话内搜索与纯对话切换、一键复制恢复命令 |
| `mods/web` | 网页预览 & Chromium (`herdr-web-browser`) 联动面板：本机监听端口探测、前进后退、收藏书签、SPA 自动识别、一键发页面/截图给 Agent |
| `mods/actions` | 工作区快捷动作面板：支持新标签/右侧分屏/当前终端、全局/项目绑定，并自动探测 `package.json` / `justfile` / `Makefile` 脚本 |
| `mods/image-annotate` | **图片预览 & 图上插针批注**：自动发现最近截图/项目图片、支持拖入图片，点击任意位置插编号红针写意见，`⌘↵` 一键带精确坐标发回 Agent |
| `mods/skills` | **中文技能管理右侧面板**：扫描 `~/.agents` / Claude / Cursor / Codex / 当前项目技能，三端软链状态检查与一键同步、渲染 `SKILL.md`、一键让 Agent 调用（`⌘⇧S`） |
| `mods/tabs-history` | 顶栏标签页与右侧 7 大面板切换条 |
| `mods/open-in-editor` / `mods/better-alerts` | 在外部编辑器打开当前项目 / macOS 系统级 Agent 通知 |

### 6 套自定义主题（`themes/`）

- 浅色：`warm-paper`（纸墨暖白）、`matcha-mist`（抹茶晨雾）、`nord-snow`（北欧雪白）
- 深色：`tokyo-night`（东京夜）、`catppuccin-mocha`（摩卡猫布丁）、`rose-pine`（玫瑰松）

### 后台引擎、CLI 与 Agent Skills

- `herdr-sched`（`sched/sched` + `sched/engine.py`）：定时任务 CLI + 后台调度引擎
- `herdr-board`（`board/board`）：项目看板 CLI
- `herdr-reflect`（`reflections/reflect.py` + `reflections/prompt.md`）：跨机每日会话反思引擎（`claude -p --no-session-persistence`），自动将未收尾高优事项去重同步至 Board 看板
- `skills/herdr-sched`、`skills/herdr-board`：让 Claude Code / Cursor / Codex 在对话中自动识别并调用定时任务与看板

## 一键安装 / 同步到另一台 Mac

```bash
git clone https://github.com/debug-null/herdr-mods.git /tmp/herdr-mods
bash /tmp/herdr-mods/install.sh
```

> `install.sh` 会自动备份原有的 `layouts/scm.json` 与 `keys.json`，**不会覆盖**已有的 `sched/jobs.json`、`board/tasks.json`、`prompts.json` 或 `settings.json`（如需同步 `settings.json` 可加 `--with-settings`）。

安装后在 Herdr 中用 `⌘⇧L` 切换到 `scm` 布局即可生效。

## Notes

- 不提交 `shared.json`、`view.json`、`window.json`、`cache/`、`data/`、`sched/jobs.json`、`board/tasks.json`、`reflections/2026-*.md` 等运行态/隐私数据。
- `gpui-kit.d.ts` 与 `jsconfig.json` 由 Herdr 自动生成，已通过 `.gitignore` 忽略。

## License

MIT
