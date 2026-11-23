// Scheduler Entry — 侧栏底部入口 + 全局后台守护（告警 toast 消费、引擎自拉起）。
// 与 workspace-chrome footer 视觉对齐，并适配侧栏紧凑模式（< 160px）。
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  appHome,
  checking,
  focused,
  hc,
  layout,
  nextCommand,
  notify,
  panes,
  playSound,
  readTextFile,
  run,
  spaces,
  theme,
  writeTextFile,
} from "herdr";

const DIR = () => `${appHome()}/sched`;
const JOBS = () => `${DIR()}/jobs.json`;
const STATE = () => `${DIR()}/state.json`;
const ALERTS = () => `${DIR()}/alerts`;
const ENGINE = () => `${DIR()}/engine.py`;
const ENGINE_NAME = "sched-engine";
const ICON = (name) => `mods/sched-entry/icons/${name}.svg`;

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

const narrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export default class SchedEntry extends View {
  init(_p, cx) {
    this.alive = false;
    this.enabledCount = 0;
    this.totalCount = 0;
    this.runningCount = 0;
    this.errorCount = 0;
    this.busy = false;
    this.starting = false;
    this.lastProbe = 0;
    if (checking()) return;
    this.poll(cx);
    cx.timer.every(5000, (cx) => this.poll(cx));
    cx.spawn(async () => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "open") this.open();
      }
    });
  }

  poll(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const [jobsRaw, stateRaw] = await Promise.all([
          readTextFile(JOBS()).catch(() => null),
          readTextFile(STATE()).catch(() => null),
        ]);
        let alive = false;
        let runningCount = 0;
        let errorCount = 0;
        let enabledCount = 0;
        let totalCount = 0;
        let st = {};
        try {
          st = JSON.parse(stateRaw || "{}");
          const hb = st?.engine?.heartbeat;
          alive = hb ? Date.now() / 1000 - hb < 22 : false;
          runningCount = Array.isArray(st?.engine?.running) ? st.engine.running.length : 0;
        } catch {}
        try {
          const jobs = JSON.parse(jobsRaw || "{}").jobs || [];
          totalCount = jobs.length;
          for (const j of jobs) {
            if (j.enabled !== false) enabledCount++;
            if (st?.jobs?.[j.id]?.last_status === "err" && j.enabled !== false) errorCount++;
          }
        } catch {}

        await this.drainAlerts();

        // 心跳失联时每 15s 最多探测并拉起一次引擎，避免频繁调用 hc
        const now = Date.now();
        if (!alive && now - this.lastProbe > 15000) {
          this.lastProbe = now;
          const ok = await this.probeEngine();
          if (ok) alive = true;
          else this.startEngine(cx);
        }

        if (
          alive !== this.alive ||
          enabledCount !== this.enabledCount ||
          totalCount !== this.totalCount ||
          runningCount !== this.runningCount ||
          errorCount !== this.errorCount
        ) {
          this.alive = alive;
          this.enabledCount = enabledCount;
          this.totalCount = totalCount;
          this.runningCount = runningCount;
          this.errorCount = errorCount;
          cx.notify();
        }
      } finally {
        this.busy = false;
      }
    });
  }

  async drainAlerts() {
    const raw = await readTextFile(ALERTS()).catch(() => null);
    if (!raw || !raw.trim()) return;
    const cleared = await writeTextFile(ALERTS(), "", raw)
      .then(() => true)
      .catch(() => false);
    if (!cleared) return;
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const a = JSON.parse(line);
        const isErr = a.status === "err";
        notify({
          title: `定时任务 · ${a.job}`,
          body: a.msg || (isErr ? "执行失败" : "执行完成"),
          level: isErr ? "error" : "success",
          action: { name: "sched-entry.open" },
        });
        if (isErr) playSound("blocked");
        else playSound("done");
      } catch {}
    }
  }

  async probeEngine() {
    const r = await hc(["get", ENGINE_NAME, "--json"]).catch(() => null);
    if (!r || r.code !== 0) return false;
    try {
      const t = JSON.parse(r.stdout);
      const live = t.state === "live";
      const mine =
        (t.argv || []).join(" ").includes("engine.py") ||
        (t.foreground?.argv || []).join(" ").includes("engine.py") ||
        (t.labels || {})["herdr.sched"] === "engine";
      if (live && mine) return true;
      if (!live) await hc(["rm", ENGINE_NAME]).catch(() => {});
      return false;
    } catch {
      return false;
    }
  }

  startEngine(cx) {
    if (this.starting) return;
    this.starting = true;
    cx.spawn(async () => {
      try {
        await hc([
          "run", "--bg", "--name", ENGINE_NAME,
          "--label", "herdr.sched=engine",
          "--cwd", DIR(),
          "--", "python3", ENGINE(),
        ]).catch(() => null);
      } finally {
        this.starting = false;
      }
    });
  }

  open() {
    const allPanes = panes();
    const pane = allPanes.find((p) => p.mod === "sched");
    if (pane) {
      const owner = spaces().find((s) => (s.tabs || []).some((t) => t.id === pane.tab));
      if (owner && !owner.active) run("space.select", { id: owner.id });
      run("tab.select", { id: pane.tab });
    } else {
      run("tab.new", { name: "Scheduler", mod: "sched" });
    }
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const activeTabId = focused()?.tab;
    const active = panes().some((p) => p.mod === "sched" && p.tab === activeTabId);
    const dotColor = !this.alive
      ? t.dim
      : this.runningCount > 0
      ? t.working
      : this.errorCount > 0
      ? t.blocked
      : t.done;
    const tip = !this.alive
      ? "Scheduler (⌘⇧J) · 引擎未运行"
      : this.runningCount > 0
      ? `Scheduler (⌘⇧J) · ${this.runningCount} 个任务运行中`
      : this.errorCount > 0
      ? `Scheduler (⌘⇧J) · ${this.errorCount} 个任务异常`
      : `Scheduler (⌘⇧J) · ${this.enabledCount}/${this.totalCount} 个任务启用`;

    const leadIcon =
      this.runningCount > 0
        ? svg(ICON("spinner")).size(14).flex_none().text_color(t.working).spin(900)
        : svg(ICON("clock")).size(14).flex_none();

    return h_flex()
      .size_full()
      .bg(t.chrome)
      .px(collapsed ? 0 : 8)
      .pb(4)
      .items_center()
      .justify_center()
      .text_size(13)
      .child(
        h_flex()
          .id("sched-entry")
          .h(28)
          .rounded(8)
          .items_center()
          .cursor_pointer()
          .when(collapsed, (el) => el.relative().w(32).px(0).justify_center().tooltip(tip))
          .when(!collapsed, (el) => el.flex_1().px(8).gap(9).tooltip(tip))
          .when(active, (el) => el.bg(t.selected).text_color(t.foreground))
          .when(!active, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .on_click(() => this.open())
          .child(leadIcon)
          .when(!collapsed, (el) =>
            el.children([
              div().flex_1().truncate().child("Scheduler"),
              ...(this.totalCount > 0
                ? [
                    div()
                      .px(5)
                      .h(16)
                      .rounded(8)
                      .flex()
                      .items_center()
                      .justify_center()
                      .bg(this.errorCount > 0 ? t.raised : t.hover)
                      .text_size(10.5)
                      .font_medium()
                      .text_color(this.errorCount > 0 ? t.blocked : t.muted)
                      .child(`${this.enabledCount}`),
                  ]
                : []),
              div().size(6).flex_none().rounded_full().bg(dotColor),
            ])
          )
          .when(collapsed, (el) =>
            el.child(div().size(6).rounded_full().bg(dotColor).absolute().top(5).right(6))
          )
      );
  }
}
