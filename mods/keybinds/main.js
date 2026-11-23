// Keybinds — 全中文可视化快捷键速查墙（实时读取 keys.json，支持搜索与点击直接触发）。
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { checking, closeOverlay, keys, props, run, theme, window } from "herdr";

const ICON = (name) => `mods/keybinds/icons/${name}.svg`;

const ACTION_ZH = {
  "board-entry.quick": { group: "自定义工作台", label: "闪记一条灵感卡片" },
  "board-entry.open": { group: "自定义工作台", label: "打开项目看板（Board）" },
  "sched-entry.open": { group: "自定义工作台", label: "打开定时任务（Scheduler）" },
  "status-pro.prompts": { group: "自定义工作台", label: "打开高频 Prompt 指令库" },
  "status-pro.skills": { group: "自定义工作台", label: "打开技能管理中心（Skills）" },
  "status-pro.keybinds": { group: "自定义工作台", label: "打开可视化快捷键速查墙" },
  "status-pro.theme": { group: "自定义工作台", label: "一键切换主题与外观" },
  "mod.open:herdr-web-browser": { group: "自定义工作台", label: "打开 Chromium 浏览器菜单" },
  "mod.open:picker": { group: "自定义工作台", label: "快速切换 Space / 会话" },

  "agent.next": { group: "Agent 导航", label: "跳到下一个 Agent" },
  "agent.prev": { group: "Agent 导航", label: "跳到上一个 Agent" },

  "tab.new": { group: "标签页管理", label: "新建终端标签页" },
  "tab.close": { group: "标签页管理", label: "关闭当前标签页" },
  "tab.next": { group: "标签页管理", label: "切换到下一个标签页" },
  "tab.prev": { group: "标签页管理", label: "切换到上一个标签页" },
  "tab.rename": { group: "标签页管理", label: "重命名当前标签页" },

  "pane.split:right": { group: "分屏与窗格", label: "向右分屏" },
  "pane.split:down": { group: "分屏与窗格", label: "向下分屏" },
  "pane.close": { group: "分屏与窗格", label: "关闭当前窗格" },
  "pane.zoom": { group: "分屏与窗格", label: "最大化 / 还原当前窗格" },
  "pane.go:left": { group: "分屏与窗格", label: "焦点移至左侧窗格" },
  "pane.go:right": { group: "分屏与窗格", label: "焦点移至右侧窗格" },
  "pane.go:up": { group: "分屏与窗格", label: "焦点移至上方窗格" },
  "pane.go:down": { group: "分屏与窗格", label: "焦点移至下方窗格" },
  "pane.swap:left": { group: "分屏与窗格", label: "与左侧窗格交换位置" },
  "pane.swap:right": { group: "分屏与窗格", label: "与右侧窗格交换位置" },
  "pane.swap:up": { group: "分屏与窗格", label: "与上方窗格交换位置" },
  "pane.swap:down": { group: "分屏与窗格", label: "与下方窗格交换位置" },

  "space.new": { group: "工作空间（Space）", label: "新建工作空间" },
  "space.next": { group: "工作空间（Space）", label: "下一个工作空间" },
  "space.prev": { group: "工作空间（Space）", label: "上一个工作空间" },
  "space.rename": { group: "工作空间（Space）", label: "重命名当前工作空间" },

  "terminal.search": { group: "终端内操作", label: "在终端历史中查找文本" },
  "terminal.select_all": { group: "终端内操作", label: "全选终端屏幕与历史" },
  "terminal.copy": { group: "终端内操作", label: "复制选中文本" },
  "terminal.paste": { group: "终端内操作", label: "粘贴剪贴板文本/文件" },
  "terminal.paste_image": { group: "终端内操作", label: "粘贴剪贴板图片（支持远程）" },

  "app.palette": { group: "窗口与系统", label: "打开全局命令面板" },
  "app.settings": { group: "窗口与系统", label: "打开 Herdr 设置" },
  "app.help": { group: "窗口与系统", label: "打开官方帮助" },
  "layout.toggle:sidebar": { group: "窗口与系统", label: "折叠 / 展开左侧栏" },
  "layout.switch": { group: "窗口与系统", label: "切换窗口布局" },
  "app.zoom_in": { group: "窗口与系统", label: "放大界面缩放" },
  "app.zoom_out": { group: "窗口与系统", label: "缩小界面缩放" },
  "app.zoom_reset": { group: "窗口与系统", label: "重置界面缩放（100%）" },
  "window.minimize": { group: "窗口与系统", label: "最小化窗口" },
  "app.hide": { group: "窗口与系统", label: "隐藏 Herdr 窗口" },
  "app.hide_others": { group: "窗口与系统", label: "隐藏其他应用" },
  "app.quit": { group: "窗口与系统", label: "退出 Herdr（后台 Agent 照跑）" },
};

const GROUP_ORDER = [
  "自定义工作台",
  "Agent 导航",
  "分屏与窗格",
  "标签页管理",
  "工作空间（Space）",
  "终端内操作",
  "窗口与系统",
];

function describeBinding(b) {
  const act = String(b.action || "");
  if (ACTION_ZH[act]) return ACTION_ZH[act];
  if (act.startsWith("tab.select:")) return { group: "标签页管理", label: `切换到第 ${act.split(":")[1]} 个标签页`, compact: true };
  if (act.startsWith("space.select:")) return { group: "工作空间（Space）", label: `切换到第 ${act.split(":")[1]} 个工作空间`, compact: true };
  if (act.startsWith("send:")) {
    const k = b.keys;
    const hint =
      k === "alt-left" ? "光标向左跳过一个词" :
      k === "alt-right" ? "光标向右跳过一个词" :
      k === "alt-backspace" ? "删除左侧一个词" :
      k === "cmd-left" ? "光标移至行首" :
      k === "cmd-right" ? "光标移至行尾" :
      k === "cmd-backspace" ? "删除至行首" : "向终端发送转义序列";
    return { group: "终端内操作", label: hint, runnable: false };
  }
  return { group: "窗口与系统", label: act };
}

function parseKeyCaps(rawKeys) {
  const mac = window()?.platform !== "windows" && window()?.platform !== "linux";
  const map = {
    cmd: mac ? "⌘" : "Ctrl",
    ctrl: mac ? "⌃" : "Ctrl",
    alt: mac ? "⌥" : "Alt",
    shift: mac ? "⇧" : "Shift",
    left: "←",
    right: "→",
    up: "↑",
    down: "↓",
    enter: "↵",
    backspace: "⌫",
    escape: "Esc",
    tab: "⇥",
  };
  const s = String(rawKeys || "").trim();
  const tokens = s.endsWith("--") ? [...s.slice(0, -2).split("-"), "-"] : s.split("-");
  return tokens
    .filter(Boolean)
    .map((tk) => map[tk.toLowerCase()] || (tk.length === 1 ? tk.toUpperCase() : tk.toUpperCase()));
}

function runBindingAction(action) {
  if (!action || action.startsWith("send:") || action === "terminal") return;
  if (action.includes(":")) {
    const idx = action.indexOf(":");
    const name = action.slice(0, idx);
    const val = action.slice(idx + 1);
    if (name === "mod.open") run(name, { name: val });
    else if (name === "layout.toggle") run(name, { id: val });
    else if (name === "pane.split" || name === "pane.go" || name === "pane.swap") run(name, { direction: val });
    else if (name === "tab.select" || name === "space.select") run(name, { index: Number(val) });
    else run(name);
  } else {
    run(action);
  }
}

function chunk(arr, n) {
  const rows = [];
  for (let i = 0; i < arr.length; i += n) rows.push(arr.slice(i, i + n));
  return rows;
}

export default class Keybinds extends View {
  init(_props, cx) {
    this.query = "";
    this.searchFocused = false;
    this.handle = cx.focus_handle();
    this.searchInput = InputState.new({ placeholder: "搜索中文功能名或按键（如：分屏、看板、shift）…" });
    this.searchInput.on("focus", (_e, cx) => { this.searchFocused = true; cx.notify(); });
    this.searchInput.on("blur", (_e, cx) => { this.searchFocused = false; cx.notify(); });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value().trim().toLowerCase();
      cx.notify();
    });
    if (!checking()) cx.timer.after(35, () => this.searchInput.focus());
  }

  groupedEntries() {
    const raw = keys();
    const map = new Map(GROUP_ORDER.map((g) => [g, []]));
    let hasTabNum = false;
    let hasSpaceNum = false;

    for (const b of raw) {
      const act = String(b.action || "");
      // Collapse 1..9 number shortcuts into 1 tidy summary row unless user is searching specifically
      if (!this.query && act.startsWith("tab.select:")) {
        if (hasTabNum) continue;
        hasTabNum = true;
        map.get("标签页管理").push({
          keys: "cmd-1…9",
          caps: ["⌘", "1–9"],
          label: "直接切换到第 1 ~ 9 个标签页",
          action: null,
        });
        continue;
      }
      if (!this.query && act.startsWith("space.select:")) {
        if (hasSpaceNum) continue;
        hasSpaceNum = true;
        map.get("工作空间（Space）").push({
          keys: "ctrl-1…9",
          caps: ["⌃", "1–9"],
          label: "直接切换到第 1 ~ 9 个工作空间",
          action: null,
        });
        continue;
      }
      const meta = describeBinding(b);
      if (!map.has(meta.group)) map.set(meta.group, []);
      const caps = parseKeyCaps(b.keys);
      if (this.query) {
        const hay = `${meta.group} ${meta.label} ${b.keys} ${act} ${caps.join(" ")}`.toLowerCase();
        if (!hay.includes(this.query)) continue;
      }
      map.get(meta.group).push({
        keys: b.keys,
        caps,
        label: meta.label,
        action: meta.runnable === false || b.section === "terminal" ? null : act,
      });
    }

    return [...map.entries()].filter(([, list]) => list.length > 0);
  }

  keyCap(text, t, key) {
    return div()
      .id(key)
      .min_w(22)
      .h(22)
      .px(6)
      .flex()
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(5)
      .bg(t.background)
      .border_1()
      .border_color(t.input)
      .shadow_2xs()
      .text_size(11)
      .font_semibold()
      .text_color(t.foreground)
      .child(text);
  }

  render() {
    const t = theme();
    const groups = this.groupedEntries();
    const rows = chunk(groups, 2);

    return v_flex()
      .id("keybinds-dialog")
      .size_full()
      .bg(t.popover)
      .track_focus(this.handle)
      // Header
      .child(
        h_flex()
          .flex_none()
          .px(18)
          .py(12)
          .gap(10)
          .items_center()
          .border_b_1()
          .border_color(t.border)
          .children([
            h_flex()
              .size(26)
              .rounded(7)
              .bg(t.raised)
              .items_center()
              .justify_center()
              .text_color(t.accent)
              .child(svg(ICON("keyboard")).size(14.5)),
            div().font_semibold().text_size(14.5).text_color(t.foreground).child("可视化快捷键速查墙"),
            div().flex_1(),
            h_flex()
              .w(260)
              .h(30)
              .px(9)
              .gap(6)
              .items_center()
              .rounded(7)
              .bg(t.surface)
              .border_1()
              .border_color(this.searchFocused ? t.accent : t.border)
              .children([
                svg(ICON("search")).size(12.5).flex_none().text_color(this.searchFocused ? t.accent : t.dim),
                Input.new(this.searchInput).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground),
                ...(this.query
                  ? [
                      div()
                        .id("kb-clr")
                        .size(16)
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .rounded(4)
                        .cursor_pointer()
                        .text_color(t.dim)
                        .on_click((_e, cx) => { this.searchInput.set_value(""); this.query = ""; cx.notify(); })
                        .child(svg(ICON("x")).size(10)),
                    ]
                  : []),
              ]),
            h_flex()
              .id("kb-close")
              .size(26)
              .rounded(6)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => closeOverlay(props().overlay))
              .child(svg(ICON("x")).size(14)),
          ])
      )
      // 2-column card wall
      .child(
        div()
          .id("kb-scroll")
          .flex_1()
          .min_h(0)
          .w_full()
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .w_full()
              .p(16)
              .gap(12)
              .when(rows.length === 0, (el) =>
                el.child(div().py(32).text_center().text_size(12.5).text_color(t.dim).child("没有匹配的快捷键"))
              )
              .children(
                rows.map((pair, rIdx) =>
                  h_flex()
                    .id(`kb-row-${rIdx}`)
                    .flex_none()
                    .gap(12)
                    .items_start()
                    .children([
                      ...pair.map(([groupName, items], cIdx) =>
                        v_flex()
                          .id(`kb-grp-${rIdx}-${cIdx}`)
                          .flex_1()
                          .min_w(0)
                          .rounded(10)
                          .bg(t.surface)
                          .border_1()
                          .border_color(t.border)
                          .overflow_hidden()
                          .child(
                            h_flex()
                              .px(12)
                              .py(8)
                              .items_center()
                              .justify_between()
                              .bg(t.chrome)
                              .border_b_1()
                              .border_color(t.border)
                              .children([
                                div().font_semibold().text_size(12).text_color(t.foreground).child(groupName),
                                div().text_size(10.5).text_color(t.dim).child(`${items.length}`),
                              ])
                          )
                          .child(
                            v_flex()
                              .p(6)
                              .gap(2)
                              .children(
                                items.map((it, i) => {
                                  const clickable = Boolean(it.action);
                                  return h_flex()
                                    .id(`kb-it-${rIdx}-${cIdx}-${i}`)
                                    .px(8)
                                    .py(6)
                                    .gap(8)
                                    .items_center()
                                    .justify_between()
                                    .rounded(7)
                                    .when(clickable, (e) =>
                                      e
                                        .cursor_pointer()
                                        .hover((s) => s.bg(t.hover))
                                        .tooltip("点击直接执行此命令")
                                        .on_click(() => {
                                          closeOverlay(props().overlay);
                                          runBindingAction(it.action);
                                        })
                                    )
                                    .children([
                                      div()
                                        .flex_1()
                                        .min_w(0)
                                        .truncate()
                                        .text_size(12)
                                        .text_color(t.foreground)
                                        .child(it.label),
                                      h_flex()
                                        .gap(3)
                                        .flex_none()
                                        .items_center()
                                        .children(
                                          it.caps.map((cap, ci) =>
                                            this.keyCap(cap, t, `cap-${rIdx}-${cIdx}-${i}-${ci}`)
                                          )
                                        ),
                                    ]);
                                })
                              )
                          )
                      ),
                      ...(pair.length === 1 ? [div().flex_1()] : []),
                    ])
                )
              )
          )
      )
      // Footer
      .child(
        h_flex()
          .flex_none()
          .px(18)
          .py(9)
          .items_center()
          .justify_between()
          .border_t_1()
          .border_color(t.border)
          .text_size(11)
          .text_color(t.dim)
          .children([
            div().child("实时同步自 ~/.config/herdr-app/keys.json · 点击任意全局项可直接触发"),
            div().child("Esc 关闭"),
          ])
      );
  }
}
