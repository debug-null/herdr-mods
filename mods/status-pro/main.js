// Status Pro — 增强型底部状态栏：
//   - macOS Dock 图标实时未回复红点徽标 (setBadge) + 动态窗口标题 (setWindowTitle)
//   - 一键换肤弹窗（支持 6 套自定义主题 + 原生主题 + 亮/暗/跟随系统实时同步）
//   - 极简番茄专注计时器（25m / 15m / 5m 休息，到点弹 Toast + 提示音）
//   - 一键呼出 Prompt 高频指令库（⌘⇧Y）
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  agents,
  appHome,
  checking,
  closeOverlay,
  keys,
  nextCommand,
  notify,
  openOverlay,
  playSound,
  props,
  readTextFile,
  run,
  setBadge,
  setShared,
  setWindowTitle,
  settings,
  shared,
  spaces,
  theme,
  themes,
  window,
  writeTextFile,
} from "herdr";

const ICON = (name) => `mods/status-pro/icons/${name}.svg`;
const TIMER_KEY = "status-pro.timer";
const SETTINGS_FILE = () => `${appHome()}/settings.json`;

const THEME_LABELS = {
  "warm-paper": "纸墨暖白",
  "matcha-mist": "抹茶晨雾",
  "nord-snow": "北欧雪白",
  paper: "经典浅色",
  "tokyo-night": "东京夜",
  "catppuccin-mocha": "摩卡猫布丁",
  "rose-pine": "玫瑰松",
  graphite: "石墨深灰",
  ink: "深墨蓝",
  moss: "苔藓绿",
  "atom-one-dark": "Atom One Dark",
};

const TIMER_PRESETS = [
  { min: 25, label: "25 分钟 · 深度专注" },
  { min: 15, label: "15 分钟 · 快速冲刺" },
  { min: 45, label: "45 分钟 · 长程编码" },
  { min: 5, label: "5 分钟 · 起身休息" },
];

function fmtCountdown(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

async function updateAppearance(mode) {
  const path = SETTINGS_FILE();
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await readTextFile(path).catch(() => null);
    let obj;
    try {
      obj = raw ? JSON.parse(raw) : {};
    } catch {
      return false;
    }
    if (mode === "system") delete obj.appearance;
    else obj.appearance = mode;
    const next = JSON.stringify(obj, null, 2) + "\n";
    try {
      await writeTextFile(path, next, raw);
      return true;
    } catch {}
  }
  return false;
}

export default class StatusPro extends View {
  init(p, cx) {
    const myProps = p || props() || {};
    this.isThemePicker = Boolean(myProps.themePicker);
    this.isTimerPopup = Boolean(myProps.timerPopup);
    this.lastBadge = undefined;
    this.lastTitle = undefined;
    this.appearance = "system";

    if (checking()) return;

    if (this.isThemePicker) {
      this.loadAppearance(cx);
      return;
    }
    if (this.isTimerPopup) {
      cx.timer.every(1000, (cx) => cx.notify());
      return;
    }

    // Main status bar: listen for global commands + 1s timer tick (only redraws when timer active)
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c === "prompts") this.openPrompts();
        else if (c === "skills") this.openSkills();
        else if (c === "keybinds") this.openKeybinds();
        else if (c === "theme") this.openThemePicker();
        else if (c === "timer") this.openTimerPopup();
      }
    });

    cx.timer.every(1000, (cx) => {
      const tm = shared(TIMER_KEY);
      if (!tm?.endAt) return;
      const left = (tm.endAt - Date.now()) / 1000;
      if (left <= 0) {
        const label = tm.label || "专注计时";
        setShared(TIMER_KEY, null);
        playSound("done");
        notify({
          title: `⏱ ${label}完成`,
          body: tm.durationMin === 5 ? "休息结束，准备回到工作节奏！" : "辛苦了，起身喝口水活动一下吧！",
          level: "success",
          timeout: 6000,
        });
      }
      cx.notify();
    });
  }

  loadAppearance(cx) {
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(SETTINGS_FILE()).catch(() => null);
        const obj = raw ? JSON.parse(raw) : {};
        this.appearance = obj.appearance === "light" || obj.appearance === "dark" ? obj.appearance : "system";
      } catch {
        this.appearance = "system";
      }
      cx.notify();
    });
  }

  syncSystemChrome(space, list) {
    if (checking()) return;
    const blocked = list.filter((a) => a.status === "blocked").length;
    const working = list.filter((a) => a.status === "working").length;

    const badge = blocked > 0 ? String(blocked) : null;
    if (badge !== this.lastBadge) {
      this.lastBadge = badge;
      setBadge(badge);
    }

    const parts = ["Herdr"];
    if (space?.name) parts.push(space.name);
    if (blocked > 0) parts.push(`${blocked} 待回复`);
    else if (working > 0) parts.push(`${working} 运行中`);
    const title = parts.join(" · ");
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      setWindowTitle(title);
    }
  }

  openPrompts() {
    openOverlay({
      mod: "prompts",
      kind: "dialog",
      width: 640,
      height: 560,
    });
  }

  openSkills() {
    run("layout.select", { stack: "panel-body", child: "skills" });
    run("layout.show", { id: "panel" });
  }

  openKeybinds() {
    openOverlay({
      mod: "keybinds",
      kind: "dialog",
      width: 760,
      height: 580,
    });
  }

  openThemePicker() {
    openOverlay({
      mod: "status-pro",
      props: { themePicker: true },
      kind: "dialog",
      width: 440,
      height: 500,
    });
  }

  openTimerPopup() {
    openOverlay({
      mod: "status-pro",
      props: { timerPopup: true },
      kind: "dialog",
      width: 340,
      height: 310,
    });
  }

  // ---- Theme Picker Dialog ------------------------------------------------

  pickTheme(th, cx) {
    const targetMode = th.light ? "light" : "dark";
    cx.spawn(async (cx) => {
      if (this.appearance !== "system" && this.appearance !== targetMode) {
        await updateAppearance(targetMode);
        this.appearance = targetMode;
      } else if (this.appearance === "system") {
        // Also switch appearance explicitly if system mode differs from picked theme lightness
        const isDarkNow = Boolean(settings().dark);
        if (isDarkNow === th.light) {
          await updateAppearance(targetMode);
          this.appearance = targetMode;
        }
      }
      run("app.theme", { name: th.name });
      cx.notify();
    });
  }

  renderThemePicker(t) {
    const all = themes().filter((x) => x.name !== "win98");
    const lights = all.filter((x) => x.light);
    const darks = all.filter((x) => !x.light);
    const curName = String(settings().theme || "");

    const themeRow = (th) => {
      const active = curName === th.name;
      const c = th.colors || {};
      const swatches = [c.background || "#888", c.chrome || "#888", c.accent || "#888", c.done || c.ansi2 || "#888"];
      return h_flex()
        .id(`th-${th.name}`)
        .flex_none()
        .h(34)
        .px(10)
        .gap(10)
        .items_center()
        .rounded(8)
        .cursor_pointer()
        .border_1()
        .when(active, (e) => e.bg(t.selected).border_color(t.accent))
        .when(!active, (e) => e.bg(t.surface).border_color(t.border).hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.pickTheme(th, cx))
        .children([
          // 4-dot mini palette swatch
          h_flex()
            .gap(3)
            .flex_none()
            .items_center()
            .children(
              swatches.map((hex, i) =>
                div()
                  .id(`sw-${th.name}-${i}`)
                  .size(11)
                  .rounded_full()
                  .bg(hex)
                  .border_1()
                  .border_color(t.border)
              )
            ),
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(12.5)
            .font_medium()
            .text_color(t.foreground)
            .child(THEME_LABELS[th.name] || th.name),
          div().text_size(10.5).text_color(t.dim).child(th.name),
          ...(active ? [svg(ICON("check")).size(13).text_color(t.accent)] : []),
        ]);
    };

    const appModes = [
      { id: "light", label: "浅色" },
      { id: "dark", label: "深色" },
      { id: "system", label: "跟随系统" },
    ];

    return v_flex()
      .id("theme-picker-dialog")
      .size_full()
      .bg(t.popover)
      .child(
        h_flex()
          .flex_none()
          .px(16)
          .py(12)
          .items_center()
          .justify_between()
          .border_b_1()
          .border_color(t.border)
          .children([
            h_flex()
              .gap(8)
              .items_center()
              .children([
                svg(ICON("palette")).size(15).text_color(t.accent),
                div().font_semibold().text_size(14).text_color(t.foreground).child("主题与外观"),
              ]),
            h_flex()
              .id("tp-close")
              .size(24)
              .rounded(6)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => closeOverlay(props().overlay))
              .child(svg(ICON("x")).size(13.5)),
          ])
      )
      // Light / Dark / System segmented switch
      .child(
        h_flex()
          .flex_none()
          .px(16)
          .py(10)
          .border_b_1()
          .border_color(t.border)
          .child(
            h_flex()
              .flex_1()
              .p(3)
              .gap(3)
              .rounded(8)
              .bg(t.raised)
              .children(
                appModes.map((m) => {
                  const on = this.appearance === m.id;
                  return div()
                    .id(`appm-${m.id}`)
                    .flex_1()
                    .h(26)
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(6)
                    .cursor_pointer()
                    .text_size(11.5)
                    .when(on, (e) => e.bg(t.surface).text_color(t.foreground).font_medium().border_1().border_color(t.border))
                    .when(!on, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
                    .on_click((_e, cx) => {
                      this.appearance = m.id;
                      cx.notify();
                      cx.spawn(async (cx) => {
                        await updateAppearance(m.id);
                        cx.notify();
                      });
                    })
                    .child(m.label);
                })
              )
          )
      )
      // Scrollable theme list
      .child(
        div()
          .id("tp-scroll")
          .flex_1()
          .min_h(0)
          .w_full()
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .w_full()
              .px(16)
              .py(12)
              .gap(12)
              .child(
                v_flex()
                  .flex_none()
                  .gap(6)
                  .child(div().text_size(11).font_medium().text_color(t.dim).child(`浅色主题 (${lights.length})`))
                  .children(lights.map(themeRow))
              )
              .child(
                v_flex()
                  .flex_none()
                  .gap(6)
                  .child(div().text_size(11).font_medium().text_color(t.dim).child(`深色主题 (${darks.length})`))
                  .children(darks.map(themeRow))
              )
          )
      );
  }

  // ---- Focus Timer Popup --------------------------------------------------

  startTimer(min, label) {
    setShared(TIMER_KEY, {
      endAt: Date.now() + min * 60000,
      durationMin: min,
      label,
      pausedLeftSec: null,
    });
    closeOverlay(props().overlay);
  }

  renderTimerPopup(t) {
    const tm = shared(TIMER_KEY);
    const running = Boolean(tm?.endAt);
    const paused = Boolean(tm?.pausedLeftSec != null);
    const leftSec = running
      ? Math.max(0, (tm.endAt - Date.now()) / 1000)
      : paused
      ? tm.pausedLeftSec
      : 0;

    return v_flex()
      .id("timer-popup")
      .size_full()
      .bg(t.popover)
      .child(
        h_flex()
          .flex_none()
          .px(16)
          .py(12)
          .items_center()
          .justify_between()
          .border_b_1()
          .border_color(t.border)
          .children([
            h_flex()
              .gap(7)
              .items_center()
              .children([
                svg(ICON("timer")).size(15).text_color(t.accent),
                div().font_semibold().text_size(14).text_color(t.foreground).child("专注计时器"),
              ]),
            h_flex()
              .id("tm-close")
              .size(24)
              .rounded(6)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => closeOverlay(props().overlay))
              .child(svg(ICON("x")).size(13.5)),
          ])
      )
      .child(
        v_flex()
          .flex_1()
          .p(16)
          .gap(12)
          .when(running || paused, (el) =>
            el.child(
              v_flex()
                .p(12)
                .gap(8)
                .items_center()
                .rounded(10)
                .bg(t.surface)
                .border_1()
                .border_color(running ? t.accent : t.border)
                .children([
                  div().text_size(11.5).text_color(t.muted).child(tm.label || "专注中"),
                  div().text_size(28).font_semibold().text_color(t.foreground).child(fmtCountdown(leftSec)),
                  h_flex()
                    .gap(8)
                    .children([
                      div()
                        .id("tm-toggle")
                        .h(28)
                        .px(14)
                        .flex()
                        .items_center()
                        .rounded(7)
                        .cursor_pointer()
                        .bg(t.solid)
                        .text_color(t.solid_foreground)
                        .text_size(12)
                        .on_click((_e, cx) => {
                          if (running) {
                            setShared(TIMER_KEY, { ...tm, endAt: null, pausedLeftSec: leftSec });
                          } else {
                            setShared(TIMER_KEY, { ...tm, endAt: Date.now() + leftSec * 1000, pausedLeftSec: null });
                          }
                          cx.notify();
                        })
                        .child(running ? "暂停" : "继续"),
                      div()
                        .id("tm-stop")
                        .h(28)
                        .px(12)
                        .flex()
                        .items_center()
                        .rounded(7)
                        .cursor_pointer()
                        .border_1()
                        .border_color(t.border)
                        .text_size(12)
                        .text_color(t.muted)
                        .hover((s) => s.bg(t.hover).text_color(t.blocked))
                        .on_click((_e, cx) => {
                          setShared(TIMER_KEY, null);
                          cx.notify();
                        })
                        .child("结束"),
                    ]),
                ])
            )
          )
          .child(
            v_flex()
              .gap(6)
              .children(
                TIMER_PRESETS.map((p) =>
                  h_flex()
                    .id(`tm-p-${p.min}`)
                    .h(34)
                    .px(12)
                    .items_center()
                    .justify_between()
                    .rounded(8)
                    .bg(t.surface)
                    .border_1()
                    .border_color(t.border)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).border_color(t.accent))
                    .on_click(() => this.startTimer(p.min, p.label))
                    .children([
                      div().text_size(12.5).text_color(t.foreground).child(p.label),
                      div().text_size(11).text_color(t.accent).child("开始 →"),
                    ])
                )
              )
          )
      );
  }

  // ---- Main Status Bar ----------------------------------------------------

  paletteHint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    if (!b?.keys) return "命令面板";
    const parts = b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b.keys.split("-");
    const key = parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key} 命令` : "命令面板";
  }

  render() {
    const t = theme();
    if (this.isThemePicker) return this.renderThemePicker(t);
    if (this.isTimerPopup) return this.renderTimerPopup(t);

    const space = spaces().find((s) => s.active);
    const list = agents();
    this.syncSystemChrome(space, list);

    const needs = list.filter((a) => a.status === "blocked").length;
    const working = list.filter((a) => a.status === "working").length;
    const tm = shared(TIMER_KEY);
    const timerRunning = Boolean(tm?.endAt);
    const timerPaused = Boolean(tm?.pausedLeftSec != null);
    const leftSec = timerRunning
      ? Math.max(0, (tm.endAt - Date.now()) / 1000)
      : timerPaused
      ? tm.pausedLeftSec
      : 0;
    const curTheme = String(settings().theme || (settings().dark ? "dark" : "light"));

    const pill = (id, icon, text, tip, onClick, opts = {}) =>
      h_flex()
        .id(id)
        .h(20)
        .px(7)
        .gap(5)
        .items_center()
        .rounded(5)
        .cursor_pointer()
        .tooltip(tip)
        .when(Boolean(opts.active), (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
        .when(!opts.active, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click(onClick)
        .when(Boolean(opts.dotColor), (e) => e.child(div().size(6).rounded_full().bg(opts.dotColor)))
        .when(Boolean(icon), (e) => e.child(svg(ICON(icon)).size(12).flex_none().text_color(opts.iconColor || t.muted)))
        .child(text);

    return h_flex()
      .size_full()
      .px(12)
      .gap(12)
      .items_center()
      .bg(t.chrome)
      .border_t_1()
      .border_color(t.border)
      .text_size(11.5)
      .text_color(t.muted)
      // Left: machine + branch + agents pulse
      .child(
        h_flex()
          .gap(5)
          .items_center()
          .children([
            svg(`mods/workspace-chrome/${space?.machine ? "server" : "monitor"}.svg`).size(12.5),
            space?.machine ?? "This computer",
          ])
      )
      .when(Boolean(space?.branch), (el) =>
        el.child(
          h_flex()
            .gap(5)
            .items_center()
            .children([svg("mods/workspace-chrome/branch.svg").size(12.5), space.branch])
        )
      )
      .child(
        h_flex()
          .id("st-agents")
          .gap(5)
          .items_center()
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => run("agent.next"))
          .children([
            div().size(6).rounded_full().bg(needs > 0 ? t.blocked : working > 0 ? t.working : t.dim),
            `${list.length} agents`,
            ...(needs > 0 ? [div().text_color(t.blocked).font_medium().child(`· ${needs} 待回复`)] : []),
          ])
      )
      .child(div().flex_1())
      // Right: Skills + Prompts + Focus Timer + Quick Theme + Keybinds + Command Palette
      .child(
        pill(
          "st-skills",
          "layers",
          "技能",
          "打开技能管理中心 (⌘⇧S)",
          () => this.openSkills()
        )
      )
      .child(
        pill(
          "st-prompts",
          "sparkles",
          "指令库",
          "打开高频 Prompt 指令库 (⌘⇧Y)",
          () => this.openPrompts(),
          { iconColor: t.accent }
        )
      )
      .child(
        pill(
          "st-timer",
          "timer",
          timerRunning || timerPaused ? fmtCountdown(leftSec) : "专注",
          timerRunning ? `${tm.label || "专注计时中"} · 点击管理` : "启动番茄专注计时器",
          () => this.openTimerPopup(),
          { active: timerRunning, iconColor: timerRunning ? t.accent : t.muted }
        )
      )
      .child(
        pill(
          "st-theme",
          null,
          THEME_LABELS[curTheme] || curTheme,
          "一键切换主题与亮暗外观",
          () => this.openThemePicker(),
          { dotColor: t.accent }
        )
      )
      .child(
        pill(
          "st-keys",
          "keyboard",
          "快捷键",
          "打开中文可视化快捷键速查墙 (⌘⇧/)",
          () => this.openKeybinds()
        )
      )
      .child(
        div()
          .id("palette")
          .px(5)
          .h(20)
          .flex()
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("app.palette"))
          .child(this.paletteHint())
      );
  }
}
