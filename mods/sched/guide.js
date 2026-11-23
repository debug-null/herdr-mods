// guide.js — Scheduler 内置命令速查 & 用法指南弹窗（含一键复制）。
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, notify, props, settings } from "herdr";
import { ICON } from "./helpers.js";

const TABS = [
  { id: "all", label: "全部" },
  { id: "sched", label: "herdr-sched" },
  { id: "reflect", label: "herdr-reflect" },
  { id: "board", label: "herdr-board" },
  { id: "agent", label: "Agent 对话" },
];

const SECTIONS = [
  {
    id: "sched",
    title: "定时任务 CLI · herdr-sched",
    subtitle: "已软链至 ~/.local/bin/herdr-sched（避开 zsh 内建 sched 命令，任意终端可直接用）",
    items: [
      {
        label: "定时跑 Shell 命令（每 30 分钟在当前目录）",
        cmd: 'herdr-sched add --name "测试巡检" --every 30 --cmd "pnpm test" --here --notify err',
      },
      {
        label: "N 分钟后提醒当前 Agent（--self 自动识别当前终端，空闲时发送）",
        cmd: 'herdr-sched add --name "检查构建" --in 15 --self --text "检查刚才的构建状态" --notify always',
      },
      {
        label: "按 Cron 提醒指定终端 / Agent",
        cmd: 'herdr-sched add --name "周五收工" --cron "0 18 * * 5" --terminal t15 --text "总结本周改动" --if idle --notify always',
      },
      {
        label: "定时静默启动一个新 Agent Tab",
        cmd: 'herdr-sched add --name "夜间审查" --cron "0 22 * * *" --argv "claude" --task "review 今天的 git diff" --here --notify always',
      },
      {
        label: "查看所有任务与下次执行时间（支持 --json）",
        cmd: "herdr-sched ls",
      },
      {
        label: "查看某任务的最近运行历史与完整输出",
        cmd: "herdr-sched logs <id> -n 5",
      },
      {
        label: "立即手动触发一次 / 启用 / 暂停 / 删除",
        cmd: "herdr-sched run <id>   # enable | disable | rm <id>",
      },
      {
        label: "查看调度引擎心跳与运行状态",
        cmd: "herdr-sched status",
      },
    ],
  },
  {
    id: "reflect",
    title: "会话反思 CLI · herdr-reflect",
    subtitle: "跨本机与已连远程机器（mac-mini），报告保存在 ~/.config/herdr-app/reflections/",
    items: [
      {
        label: "立即生成今天的会话反思报告",
        cmd: "herdr-reflect",
      },
      {
        label: "生成今天的反思并在 Herdr 中自动打开预览",
        cmd: "herdr-reflect --open",
      },
      {
        label: "补跑昨天的会话反思（或指定 YYYY-MM-DD）",
        cmd: "herdr-reflect --date yesterday --open",
      },
      {
        label: "生成最近 7 天的深度周复盘",
        cmd: "herdr-reflect --days 7 --open",
      },
      {
        label: "仅采集原始摘要包（0 Token，排查数据用）",
        cmd: "herdr-reflect --dry-run",
      },
      {
        label: "自定义反思 Prompt 模板文件",
        cmd: "~/.config/herdr-app/reflections/prompt.md",
      },
    ],
  },
  {
    id: "board",
    title: "项目看板 CLI · herdr-board",
    subtitle: "5 列看板（ideas / todo / doing / review / done），数据保存在 ~/.config/herdr-app/board/tasks.json",
    items: [
      {
        label: "记一个灵感并自动绑定当前仓库项目",
        cmd: 'herdr-board add --title "回放导出改成 WebWorker" --notes "避免主线程卡顿" --col ideas --here --priority p2',
      },
      {
        label: "添加高优待开发任务到指定项目",
        cmd: 'herdr-board add --title "补齐 health 路由单测" --col todo --project my-app --path ~/projects/my-app --priority p1',
      },
      {
        label: "查看看板任务（可按列或项目筛选，支持 --json）",
        cmd: "herdr-board ls",
      },
      {
        label: "移动任务列 / 标为完成 / 删除",
        cmd: "herdr-board move <id> done   # ideas | todo | doing | review | done",
      },
      {
        label: "全局快捷键（任意页面随时触发）",
        cmd: "⌘⇧I 闪记灵感 · ⌘⇧K 看板 · ⌘⇧J 定时任务 · ⌘⇧Y 指令库",
      },
    ],
  },
  {
    id: "agent",
    title: "在 Agent 对话中直接调用（全局 Skill 已装）",
    subtitle: "Claude Code / Codex / Cursor 会自动识别 herdr-sched Skill，直接说自然语言即可：",
    items: [
      {
        label: "临时提醒当前会话",
        cmd: "15 分钟后提醒我检查一下刚才的发布和构建结果",
      },
      {
        label: "创建周期巡检任务",
        cmd: "帮我建个定时任务，每 30 分钟在当前仓库跑一次 pnpm test，失败就提醒我",
      },
      {
        label: "定时派新 Agent 干活",
        cmd: "每天晚上 10 点帮我自动起一个 claude，review 当天的 git diff 并列出风险",
      },
      {
        label: "查看或管理现有任务",
        cmd: "看看我有哪些定时任务，顺便查一下 daily-reflect 最近一次跑的日志",
      },
    ],
  },
];

function copyText(view, key, text, label, cx) {
  cx.write_to_clipboard(text);
  view.copiedKey = key;
  notify({ title: "已复制到剪贴板", body: label, level: "success", timeout: 1800 });
  cx.notify();
  cx.timer.after(1800, (cx) => {
    if (view.copiedKey === key) {
      view.copiedKey = null;
      cx.notify();
    }
  });
}

export function initGuide(view) {
  view.guideTab = "all";
  view.copiedKey = null;
}

export function renderGuideDialog(view, t) {
  const mono = settings().font_family || "JetBrains Mono";
  const sections =
    view.guideTab === "all"
      ? SECTIONS
      : SECTIONS.filter((s) => s.id === view.guideTab);

  return v_flex()
    .id("sched-guide-dialog")
    .size_full()
    .bg(t.popover)
    // Header
    .child(
      h_flex()
        .flex_none()
        .px(18)
        .py(13)
        .items_center()
        .justify_between()
        .border_b_1()
        .border_color(t.border)
        .children([
          h_flex()
            .gap(8)
            .items_center()
            .children([
              h_flex()
                .w(26)
                .h(26)
                .rounded(7)
                .bg(t.raised)
                .items_center()
                .justify_center()
                .text_color(t.accent)
                .child(svg(ICON("book")).size(14)),
              div().font_semibold().text_size(14.5).text_color(t.foreground).child("命令速查与用法"),
            ]),
          h_flex()
            .id("guide-close")
            .w(26)
            .h(26)
            .rounded(6)
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => closeOverlay(props().overlay))
            .child(svg(ICON("x")).size(14)),
        ])
    )
    // Filter tabs
    .child(
      h_flex()
        .flex_none()
        .px(18)
        .py(10)
        .items_center()
        .justify_between()
        .border_b_1()
        .border_color(t.border)
        .children([
          h_flex()
            .p(3)
            .gap(3)
            .rounded(8)
            .bg(t.raised)
            .children(
              TABS.map((tab) => {
                const active = view.guideTab === tab.id;
                return div()
                  .id(`gtab-${tab.id}`)
                  .h(24)
                  .px(10)
                  .flex()
                  .items_center()
                  .rounded(6)
                  .cursor_pointer()
                  .text_size(11.5)
                  .when(active, (el) => el.bg(t.surface).text_color(t.foreground).font_medium())
                  .when(!active, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
                  .on_click((_e, cx) => {
                    view.guideTab = tab.id;
                    cx.notify();
                  })
                  .child(tab.label);
              })
            ),
          div().text_size(11).text_color(t.dim).child("点击右侧图标即可复制命令"),
        ])
    )
    // Scrollable body
    .child(
      div()
        .id("guide-scroll")
        .flex_1()
        .min_h(0)
        .w_full()
        .overflow_y_scrollbar()
        .child(
          v_flex()
            .w_full()
            .px(18)
            .py(14)
            .gap(16)
            .children(
              sections.map((sec) =>
                v_flex()
                  .id(`gsec-${sec.id}`)
                  .flex_none()
                  .gap(8)
                  .child(
                    v_flex()
                      .flex_none()
                      .gap(2)
                      .children([
                        div().font_semibold().text_size(13).text_color(t.foreground).child(sec.title),
                        div().text_size(11).text_color(t.dim).child(sec.subtitle),
                      ])
                  )
                  .child(
                    v_flex()
                      .flex_none()
                      .gap(6)
                      .children(
                        sec.items.map((item, idx) =>
                          v_flex()
                            .id(`gitem-${sec.id}-${idx}`)
                            .flex_none()
                            .p(10)
                            .gap(5)
                            .rounded(8)
                            .bg(t.surface)
                            .border_1()
                            .border_color(t.border)
                            .child(
                              h_flex()
                                .items_center()
                                .justify_between()
                                .gap(8)
                                .children([
                                  div()
                                    .flex_1()
                                    .min_w(0)
                                    .truncate()
                                    .text_size(11.5)
                                    .font_medium()
                                    .text_color(t.muted)
                                    .child(item.label),
                                  h_flex()
                                    .id(`gcopy-${sec.id}-${idx}`)
                                    .h(22)
                                    .px(7)
                                    .gap(4)
                                    .flex_none()
                                    .items_center()
                                    .rounded(5)
                                    .cursor_pointer()
                                    .text_size(11)
                                    .text_color(view.copiedKey === `${sec.id}-${idx}` ? t.done : t.muted)
                                    .hover((s) => s.bg(t.hover).text_color(view.copiedKey === `${sec.id}-${idx}` ? t.done : t.foreground))
                                    .on_click((_e, cx) => copyText(view, `${sec.id}-${idx}`, item.cmd, item.label, cx))
                                    .children([
                                      svg(ICON(view.copiedKey === `${sec.id}-${idx}` ? "check" : "copy")).size(11.5),
                                      view.copiedKey === `${sec.id}-${idx}` ? "已复制" : "复制",
                                    ]),
                                ])
                            )
                            .child(
                              div()
                                .px(9)
                                .py(6)
                                .rounded(6)
                                .bg(t.background)
                                .border_1()
                                .border_color(t.border)
                                .font_family(mono)
                                .text_size(11.5)
                                .text_color(t.foreground)
                                .whitespace_normal()
                                .child(item.cmd)
                            )
                        )
                      )
                  )
              )
            )
        )
    )
    // Footer
    .child(
      h_flex()
        .flex_none()
        .px(18)
        .py(10)
        .items_center()
        .justify_between()
        .border_t_1()
        .border_color(t.border)
        .text_size(11)
        .text_color(t.dim)
        .children([
          div().child("数据目录：~/.config/herdr-app/sched/ · ~/.config/herdr-app/reflections/"),
          div().child("Esc 关闭"),
        ])
    );
}
