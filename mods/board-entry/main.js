// Board Entry — 左侧栏上方一级看板入口，位于品牌栏正下方、Spaces 上方。
// 点击：已有 Board 面板 Tab 就跳过去，没有就在当前 Space 开一个宽屏 Tab。
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  agents,
  appHome,
  checking,
  focused,
  layout,
  nextCommand,
  openOverlay,
  panes,
  readTextFile,
  run,
  spaces,
  theme,
} from "herdr";

const TASKS = () => `${appHome()}/board/tasks.json`;
const ICON = (name) => `mods/board-entry/icons/${name}.svg`;

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

const narrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export default class BoardEntry extends View {
  init(_p, cx) {
    this.openTasks = 0;
    this.busy = false;
    if (checking()) return;
    this.poll(cx);
    cx.timer.every(5000, (cx) => this.poll(cx));
    cx.spawn(async () => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "open") this.open();
        else if (cmd === "quick") this.quickCapture();
      }
    });
  }

  quickCapture() {
    openOverlay({
      mod: "board",
      props: { cardForm: { edit: null, column: "ideas" } },
      kind: "dialog",
      width: 580,
      height: 550,
    });
  }

  poll(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(TASKS()).catch(() => null);
        let openTasks = 0;
        try {
          const list = JSON.parse(raw || "{}").tasks || [];
          for (const t of list) {
            if (t.column !== "done") openTasks++;
          }
        } catch {}
        if (openTasks !== this.openTasks) {
          this.openTasks = openTasks;
          cx.notify();
        }
      } finally {
        this.busy = false;
      }
    });
  }

  open() {
    const allPanes = panes();
    const pane = allPanes.find((p) => p.mod === "board");
    if (pane) {
      const owner = spaces().find((s) => (s.tabs || []).some((t) => t.id === pane.tab));
      if (owner && !owner.active) run("space.select", { id: owner.id });
      run("tab.select", { id: pane.tab });
    } else {
      run("tab.new", { name: "Board", mod: "board" });
    }
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const activeTabId = focused()?.tab;
    const active = panes().some((p) => p.mod === "board" && p.tab === activeTabId);

    const live = agents();
    const blockedCount = live.filter((a) => a.status === "blocked").length;
    const doneCount = live.filter((a) => a.status === "done").length;
    const workingCount = live.filter((a) => a.status === "working").length;
    const totalCount = this.openTasks + live.length;

    const dotColor = blockedCount > 0
      ? t.blocked
      : doneCount > 0
      ? t.done
      : workingCount > 0
      ? t.working
      : live.length > 0
      ? t.accent
      : null;

    const tip = `Board 看板 (⌘⇧K) · 闪记灵感 (⌘⇧I) · ${live.length} 会话 · ${this.openTasks} 待办`;

    return h_flex()
      .size_full()
      .bg(t.chrome)
      .px(collapsed ? 0 : 8)
      .pb(4)
      .items_center()
      .justify_center()
      .border_b_1()
      .border_color(t.border)
      .text_size(13)
      .child(
        h_flex()
          .id("board-entry")
          .h(29)
          .rounded(8)
          .items_center()
          .cursor_pointer()
          .when(collapsed, (el) => el.relative().w(32).px(0).justify_center().tooltip(tip))
          .when(!collapsed, (el) => el.flex_1().px(8).gap(9).tooltip(tip))
          .when(active, (el) => el.bg(t.selected).text_color(t.foreground).font_medium())
          .when(!active, (el) => el.text_color(t.foreground).hover((s) => s.bg(t.hover)))
          .on_click(() => this.open())
          .child(svg(ICON("kanban")).size(14.5).flex_none().text_color(active ? t.accent : t.muted))
          .when(!collapsed, (el) =>
            el.children([
              div().flex_1().truncate().child("Board"),
              ...(totalCount > 0
                ? [
                    div()
                      .px(6)
                      .h(17)
                      .rounded(8)
                      .flex()
                      .items_center()
                      .justify_center()
                      .bg(blockedCount > 0 ? t.raised : t.hover)
                      .text_size(10.5)
                      .font_medium()
                      .text_color(blockedCount > 0 ? t.blocked : t.muted)
                      .child(`${totalCount}`),
                  ]
                : []),
              ...(dotColor ? [div().size(6).flex_none().rounded_full().bg(dotColor)] : []),
            ])
          )
          .when(collapsed && Boolean(dotColor), (el) =>
            el.child(div().size(6).rounded_full().bg(dotColor).absolute().top(5).right(6))
          )
      );
  }
}
