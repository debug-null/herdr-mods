// Scheduler — 定时任务主面板 + 引擎日志弹窗 + 命令速查弹窗。
// 调度引擎是 sched/engine.py，跑在名为 sched-engine 的常驻 hc 终端里：herdr-app 关了任务照跑。
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import {
  agents,
  checking,
  closeOverlay,
  exec,
  hc,
  home,
  knownAgents,
  nextCommand,
  notify,
  openOverlay,
  props,
  readTextFile,
  run,
  settings,
  theme,
  writeTextFile,
} from "herdr";
import {
  DIR,
  ENGINE,
  ENGINE_NAME,
  ICON,
  JOBS,
  LOGFILE,
  REFLECT_DIR,
  RUNNOW,
  STATE,
  actionMeta,
  activeCwd,
  ago,
  cloneJobRecord,
  extractMdPath,
  fmtDur,
  fmtTime,
  saveJobsAtomic,
  schedRawTip,
  schedText,
  tilde,
  until,
} from "./helpers.js";
import { initForm, renderForm } from "./form.js";
import { initGuide, renderGuideDialog } from "./guide.js";

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "enabled", label: "启用中" },
  { id: "paused", label: "已暂停" },
  { id: "err", label: "异常" },
];

export default class Sched extends View {
  init(p, cx) {
    const myProps = p || props() || {};
    this.isForm = Boolean(myProps.form);
    this.isLogs = Boolean(myProps.logs);
    this.isGuide = Boolean(myProps.guide);
    this.handle = cx.focus_handle();

    if (this.isForm) {
      initForm(this, myProps.form, cx);
      return;
    }
    if (this.isGuide) {
      initGuide(this);
      return;
    }
    if (this.isLogs) {
      this.logLines = [];
      this.logLoading = false;
      if (!checking()) this.loadLogs(cx);
      return;
    }

    this.jobsRaw = null;
    this.stateRaw = null;
    this.jobs = [];
    this.st = {};
    this.engine = { alive: false };
    this.err = null;
    this.busy = false;
    this.starting = false;
    this.restarting = false;
    this.filter = "all";
    this.query = "";
    this.expanded = new Set();
    this.selectedRun = {}; // jobId -> history index
    this.confirmDel = null; // { id, until }
    this.pendingRun = {}; // jobId -> ts
    this.defaultAgent = "claude";
    this.latestReflection = null; // { name, label, file }

    this.searchFocused = false;
    this.searchInput = InputState.new({ placeholder: "搜索任务名称、命令、表达式…" });
    this.searchInput.on("focus", (_e, cx) => {
      this.searchFocused = true;
      cx.notify();
    });
    this.searchInput.on("blur", (_e, cx) => {
      this.searchFocused = false;
      cx.notify();
    });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value().trim().toLowerCase();
      cx.notify();
    });

    if (checking()) return;
    this.refresh(cx);
    this.scanReflections(cx);
    cx.timer.every(2000, (cx) => this.refresh(cx));
    cx.timer.every(15000, (cx) => this.scanReflections(cx));
    cx.spawn(async () => {
      const list = await knownAgents().catch(() => []);
      const first = (list || []).find((x) => x.installed);
      if (first?.run?.length) this.defaultAgent = first.run.join(" ");
    });
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c === "new") this.openForm(null);
        else if (c === "spawn") this.openForm(null, { action: { type: "spawn" } });
        else if (c === "prompt") this.openForm(null, { action: { type: "prompt" } });
        else if (c === "guide") this.openGuide();
      }
    });
  }

  // ---- reflections lookup & preview ---------------------------------------

  scanReflections(cx) {
    cx.spawn(async (cx) => {
      const dir = REFLECT_DIR();
      const r = await exec("/bin/ls", ["-1", dir]).catch(() => null);
      if (!r || r.code !== 0) return;
      const files = (r.stdout || "")
        .split("\n")
        .map((s) => s.trim())
        .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
        .sort()
        .reverse();
      const top = files[0] || null;
      const next = top
        ? { name: top, label: top.replace(/\.md$/, ""), file: `${dir}/${top}` }
        : null;
      if (next?.file !== this.latestReflection?.file) {
        this.latestReflection = next;
        cx.notify();
      }
    });
  }

  openMarkdownPreview(file, title = "Markdown 预览") {
    run("tab.new", {
      name: title,
      mod: "md-preview",
      props: { file },
      focus: true,
    });
  }

  // ---- engine logs dialog -------------------------------------------------

  loadLogs(cx) {
    if (this.logLoading) return;
    this.logLoading = true;
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(LOGFILE()).catch(() => "");
        const lines = (raw || "").split("\n").filter(Boolean);
        this.logLines = lines.slice(-80);
      } finally {
        this.logLoading = false;
        cx.notify();
      }
    });
  }

  renderLogsDialog(t) {
    const mono = settings().font_family || "JetBrains Mono";
    return v_flex()
      .id("sched-logs-dialog")
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
                svg(ICON("file-text")).size(15).text_color(t.accent),
                div().font_semibold().text_size(14).text_color(t.foreground).child("引擎日志"),
                div().text_size(11).text_color(t.dim).child(tilde(LOGFILE())),
              ]),
            h_flex()
              .gap(6)
              .items_center()
              .children([
                h_flex()
                  .id("logs-refresh")
                  .h(26)
                  .px(8)
                  .gap(5)
                  .items_center()
                  .rounded(6)
                  .cursor_pointer()
                  .text_size(11.5)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.loadLogs(cx))
                  .children([svg(ICON("refresh")).size(12.5), "刷新"]),
                h_flex()
                  .id("logs-close")
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
              ]),
          ])
      )
      .child(
        div()
          .id("sched-logs-scroll")
          .flex_1()
          .min_h(0)
          .m(14)
          .rounded(8)
          .bg(t.background)
          .border_1()
          .border_color(t.border)
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .w_full()
              .p(12)
              .gap(2)
              .children(
                this.logLines.length
                  ? this.logLines.map((line, i) =>
                      div()
                        .id(`log-${i}`)
                        .font_family(mono)
                        .text_size(11.5)
                        .text_color(
                          line.includes("-> err") || line.includes("failed")
                            ? t.blocked
                            : line.includes("-> ok")
                            ? t.done
                            : t.muted
                        )
                        .child(line)
                    )
                  : [div().text_size(12).text_color(t.dim).child("暂无引擎日志")]
              )
          )
      );
  }

  // ---- data & engine control ----------------------------------------------

  refresh(cx) {
    if (this.busy) return;
    const now = Date.now();
    if (this.confirmDel && now > this.confirmDel.until) {
      this.confirmDel = null;
      cx.notify();
    }
    for (const [k, ts] of Object.entries(this.pendingRun)) {
      if (now - ts > 4000) delete this.pendingRun[k];
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const [jobsRaw, stateRaw] = await Promise.all([
          readTextFile(JOBS()).catch(() => null),
          readTextFile(STATE()).catch(() => null),
        ]);
        let st = {};
        try {
          st = JSON.parse(stateRaw || "{}");
        } catch {
          st = {};
        }
        const hb = st?.engine?.heartbeat;
        let alive = hb ? Date.now() / 1000 - hb < 22 : false;
        if (!alive) {
          const eng = await this.probeEngine();
          alive = eng.alive;
        }

        const changed =
          jobsRaw !== this.jobsRaw ||
          stateRaw !== this.stateRaw ||
          alive !== this.engine.alive;

        this.jobsRaw = jobsRaw;
        this.stateRaw = stateRaw;
        this.st = st;
        this.engine = { alive };
        try {
          this.jobs = JSON.parse(jobsRaw || "{}").jobs || [];
          this.err = null;
        } catch (e) {
          this.err = `jobs.json 解析失败: ${e.message}`;
        }

        for (const j of this.jobs) {
          const js = st?.jobs?.[j.id];
          if (
            js?.running ||
            (js?.last_run && this.pendingRun[j.id] && js.last_run * 1000 > this.pendingRun[j.id])
          ) {
            delete this.pendingRun[j.id];
          }
        }

        if (!alive && !this.restarting) this.startEngine(cx);
        if (changed || !alive) cx.notify();
      } finally {
        this.busy = false;
      }
    });
  }

  async probeEngine() {
    const r = await hc(["get", ENGINE_NAME, "--json"]).catch(() => null);
    if (!r || r.code !== 0) return { alive: false };
    try {
      const t = JSON.parse(r.stdout);
      const live = t.state === "live";
      const mine =
        (t.argv || []).join(" ").includes("engine.py") ||
        (t.foreground?.argv || []).join(" ").includes("engine.py") ||
        (t.labels || {})["herdr.sched"] === "engine";
      if (live && mine) return { alive: true };
      if (!live) await hc(["rm", ENGINE_NAME]).catch(() => {});
      return { alive: false };
    } catch {
      return { alive: false };
    }
  }

  startEngine(cx) {
    if (this.starting) return;
    this.starting = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hc([
          "run", "--bg", "--name", ENGINE_NAME,
          "--label", "herdr.sched=engine",
          "--cwd", DIR(),
          "--", "python3", ENGINE(),
        ]).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code !== 0) {
          notify({
            title: "Scheduler",
            body: `引擎启动失败: ${(r.stderr || r.stdout || "").slice(0, 120)}`,
            level: "error",
          });
        }
      } finally {
        this.starting = false;
        cx.notify();
      }
    });
  }

  restartEngine(cx) {
    if (this.restarting) return;
    this.restarting = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await hc(["kill", ENGINE_NAME]).catch(() => null);
        await hc(["rm", ENGINE_NAME]).catch(() => null);
        const r = await hc([
          "run", "--bg", "--name", ENGINE_NAME,
          "--label", "herdr.sched=engine",
          "--cwd", DIR(),
          "--", "python3", ENGINE(),
        ]).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code === 0) {
          notify({ title: "Scheduler", body: "调度引擎已重启", level: "success", timeout: 2200 });
        } else {
          notify({
            title: "Scheduler",
            body: `引擎重启失败: ${(r.stderr || r.stdout || "").slice(0, 120)}`,
            level: "error",
          });
        }
      } finally {
        this.restarting = false;
        this.refresh(cx);
      }
    });
  }

  // ---- job mutations ------------------------------------------------------

  toggle(job, cx) {
    cx.spawn(async (cx) => {
      const res = await saveJobsAtomic((jobs) => {
        const j = jobs.find((x) => x.id === job.id);
        if (j) j.enabled = j.enabled === false;
      });
      if (!res.ok) notify({ title: "Scheduler", body: "保存失败，请重试", level: "error" });
      this.refresh(cx);
    });
  }

  duplicate(job, cx) {
    cx.spawn(async (cx) => {
      const copy = cloneJobRecord(job);
      const res = await saveJobsAtomic((jobs) => {
        const idx = jobs.findIndex((x) => x.id === job.id);
        if (idx >= 0) jobs.splice(idx + 1, 0, copy);
        else jobs.push(copy);
      });
      if (res.ok) {
        notify({ title: "Scheduler", body: `已复制为「${copy.name}」（默认暂停）`, level: "info", timeout: 2400 });
      }
      this.refresh(cx);
    });
  }

  remove(job, cx) {
    cx.spawn(async (cx) => {
      this.confirmDel = null;
      this.expanded.delete(job.id);
      const res = await saveJobsAtomic((jobs) => {
        const i = jobs.findIndex((x) => x.id === job.id);
        if (i >= 0) jobs.splice(i, 1);
      });
      if (!res.ok) notify({ title: "Scheduler", body: "删除失败，请重试", level: "error" });
      this.refresh(cx);
    });
  }

  runNow(job, cx) {
    this.pendingRun[job.id] = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const old = await readTextFile(RUNNOW()).catch(() => null);
        const ok = await writeTextFile(RUNNOW(), (old || "") + job.id + "\n", old)
          .then(() => true)
          .catch(() => false);
        if (ok) break;
      }
      cx.timer.after(800, (cx) => this.refresh(cx));
    });
  }

  openForm(job, preset = null) {
    openOverlay({
      mod: "sched",
      props: { form: { edit: job || null, preset } },
      kind: "dialog",
      width: 560,
      height: 680,
    });
  }

  openLogs() {
    openOverlay({
      mod: "sched",
      props: { logs: true },
      kind: "dialog",
      width: 600,
      height: 460,
    });
  }

  openGuide() {
    openOverlay({
      mod: "sched",
      props: { guide: true },
      kind: "dialog",
      width: 640,
      height: 600,
    });
  }

  // ---- UI building blocks -------------------------------------------------

  iconBtn(id, icon, tip, onClick, t, opts = {}) {
    const danger = Boolean(opts.danger);
    const spinning = Boolean(opts.spinning);
    const subtle = Boolean(opts.subtle);
    return h_flex()
      .id(id)
      .w(26)
      .h(26)
      .rounded(6)
      .items_center()
      .justify_center()
      .cursor_pointer()
      .tooltip(tip)
      .text_color(danger ? t.blocked : subtle ? t.dim : t.muted)
      .hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground))
      .on_click(onClick)
      .child(
        svg(ICON(icon))
          .size(13.5)
          .flex_none()
          .when(spinning, (el) => el.spin(900))
      );
  }

  enginePill(t) {
    const alive = this.engine.alive;
    const hb = this.st?.engine?.heartbeat;
    const pid = this.st?.engine?.pid;
    const runningList = this.st?.engine?.running || [];
    const dotColor = this.restarting || this.starting
      ? t.working
      : alive
      ? runningList.length > 0
        ? t.working
        : t.done
      : t.blocked;
    const label = this.restarting
      ? "正在重启…"
      : !alive
      ? this.starting
        ? "启动中…"
        : "引擎离线"
      : runningList.length > 0
      ? `${runningList.length} 个执行中`
      : "引擎在线";
    const tip = alive
      ? `PID ${pid || "?"} · 心跳 ${ago(hb)} · 点击查看引擎日志`
      : "引擎未连接，点击查看引擎日志";

    return h_flex()
      .id("engine-pill")
      .h(24)
      .px(9)
      .gap(6)
      .items_center()
      .rounded_full()
      .bg(t.surface)
      .border_1()
      .border_color(t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.openLogs())
      .children([
        runningList.length > 0
          ? svg(ICON("spinner")).size(11).text_color(t.working).spin(900)
          : div().size(6).rounded_full().bg(dotColor),
        div().text_size(11.5).text_color(t.muted).child(label),
      ]);
  }

  newJobButton(t, id) {
    return h_flex()
      .id(id)
      .h(30)
      .px(13)
      .gap(5)
      .items_center()
      .rounded(7)
      .bg(t.solid)
      .text_color(t.solid_foreground)
      .text_size(12)
      .font_medium()
      .cursor_pointer()
      .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
      .on_click(() => this.openForm(null))
      .children([svg(ICON("plus")).size(13.5).flex_none(), "新建任务"]);
  }

  actionBadge(meta, enabled, t) {
    const color = !enabled
      ? t.dim
      : meta.kind === "prompt"
      ? t.working
      : meta.kind === "spawn"
      ? t.accent
      : t.foreground;
    return h_flex()
      .w(32)
      .h(32)
      .flex_none()
      .rounded(8)
      .bg(t.raised)
      .border_1()
      .border_color(t.border)
      .items_center()
      .justify_center()
      .text_color(color)
      .tooltip(meta.label)
      .child(svg(ICON(meta.icon)).size(14.5));
  }

  statusIcon(status, t) {
    if (status === "ok") return svg(ICON("check")).size(12).flex_none().text_color(t.done);
    if (status === "err") return svg(ICON("alert")).size(12).flex_none().text_color(t.blocked);
    if (status === "skip") return svg(ICON("skip")).size(12).flex_none().text_color(t.idle);
    return null;
  }

  // ---- Bento overview strip -----------------------------------------------

  overviewStrip(counts, t) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todaySec = todayStart.getTime() / 1000;

    let todayRuns = 0;
    let nextDue = null;
    for (const j of this.jobs) {
      const js = this.st?.jobs?.[j.id];
      if (!js) continue;
      for (const h of js.history || []) {
        if ((h.ts || 0) >= todaySec) todayRuns++;
      }
      if (j.enabled !== false && js.next_run && (!nextDue || js.next_run < nextDue.ts)) {
        nextDue = { ts: js.next_run, name: j.name || j.id };
      }
    }

    const card = (id, label, value, sub, accentColor, onClick = null) =>
      v_flex()
        .id(id)
        .flex_1()
        .min_w(0)
        .px(14)
        .py(12)
        .gap(4)
        .rounded(10)
        .bg(t.surface)
        .border_1()
        .border_color(t.border)
        .shadow_xs()
        .when(Boolean(onClick), (el) =>
          el.cursor_pointer().hover((s) => s.bg(t.hover).border_color(t.input)).on_click(onClick)
        )
        .children([
          div().text_size(11).text_color(t.dim).child(label),
          div().truncate().text_size(16).font_semibold().text_color(accentColor || t.foreground).child(value),
          div().truncate().text_size(11).text_color(t.muted).child(sub),
        ]);

    const refl = this.latestReflection;
    return h_flex()
      .flex_none()
      .gap(10)
      .children([
        card(
          "kpi-active",
          "启用任务",
          `${counts.enabled} / ${counts.all}`,
          nextDue ? `最近待跑：${until(nextDue.ts)}` : "暂无待触发计划",
          t.foreground,
          (_e, cx) => {
            this.filter = "enabled";
            cx.notify();
          }
        ),
        card(
          "kpi-runs",
          "今日执行",
          `${todayRuns} 次`,
          this.st?.engine?.running?.length
            ? `${this.st.engine.running.length} 个任务正在执行`
            : "后台常驻引擎自动调度",
          todayRuns > 0 ? t.accent : t.foreground
        ),
        card(
          "kpi-health",
          "运行健康度",
          counts.err > 0 ? `${counts.err} 个异常` : "全部正常",
          counts.err > 0 ? "点击筛选查看异常任务" : "所有已执行任务均无报错",
          counts.err > 0 ? t.blocked : t.done,
          counts.err > 0
            ? (_e, cx) => {
                this.filter = "err";
                cx.notify();
              }
            : null
        ),
        v_flex()
          .id("kpi-reflection")
          .flex_1()
          .min_w(0)
          .px(14)
          .py(12)
          .gap(4)
          .rounded(10)
          .bg(t.surface)
          .border_1()
          .border_color(refl ? t.border : t.border)
          .shadow_xs()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).border_color(t.accent))
          .tooltip(refl ? `打开 ${tilde(refl.file)}` : "查看会话反思命令用法")
          .on_click(() => {
            if (refl) this.openMarkdownPreview(refl.file, `反思 ${refl.label}`);
            else this.openGuide();
          })
          .children([
            h_flex()
              .items_center()
              .justify_between()
              .children([
                div().text_size(11).text_color(t.dim).child("最新会话反思"),
                svg(ICON(refl ? "external" : "calendar")).size(12).text_color(t.accent),
              ]),
            div()
              .truncate()
              .text_size(15)
              .font_semibold()
              .text_color(refl ? t.foreground : t.muted)
              .child(refl ? refl.label : "尚未生成"),
            div()
              .truncate()
              .text_size(11)
              .text_color(refl ? t.accent : t.dim)
              .child(refl ? "点击在 Herdr 中阅读 →" : "点击查看 herdr-reflect 用法"),
          ]),
      ]);
  }

  // ---- job card -----------------------------------------------------------

  jobDetails(job, jstate, t) {
    const mono = settings().font_family || "JetBrains Mono";
    const hist = Array.isArray(jstate?.history) ? jstate.history : [];
    const selIdx = Math.min(this.selectedRun[job.id] ?? 0, Math.max(0, hist.length - 1));
    const current = hist[selIdx] || null;
    const a = job.action || {};
    const mdFile = extractMdPath(current?.msg, home());

    const metaBits = [
      `ID: ${job.id}`,
      ...(job.schedule?.cron ? [`Cron: ${job.schedule.cron}`] : []),
      `累计执行 ${jstate?.run_count || 0} 次`,
      ...(a.type === "exec" && a.cwd ? [`目录: ${tilde(a.cwd)}`] : []),
      ...(a.type === "exec" && job.timeout_sec ? [`超时: ${job.timeout_sec}s`] : []),
      ...(a.type === "prompt" ? [`目标: ${a.terminal}${a.if === "idle" ? "（仅空闲）" : ""}`] : []),
      ...(a.type === "spawn" && a.folder ? [`目录: ${tilde(a.folder)}`] : []),
      ...(job.notify ? [`提醒: ${job.notify === "always" ? "每次" : "仅失败"}`] : []),
    ];

    return v_flex()
      .pt(12)
      .mt(12)
      .border_t_1()
      .border_color(t.border)
      .gap(10)
      .child(
        h_flex()
          .gap(12)
          .overflow_x_scroll()
          .children(
            metaBits.map((bit, i) =>
              div().id(`meta-${job.id}-${i}`).flex_none().text_size(11).text_color(t.dim).child(bit)
            )
          )
      )
      .child(
        div()
          .px(10)
          .py(7)
          .rounded(7)
          .bg(t.background)
          .border_1()
          .border_color(t.border)
          .font_family(mono)
          .text_size(11.5)
          .text_color(t.muted)
          .whitespace_normal()
          .child(
            a.type === "prompt"
              ? `hc send ${a.terminal}${a.if ? ` --if ${a.if}` : ""} ${JSON.stringify(a.text || "")}`
              : a.type === "spawn"
              ? `${(a.argv || []).join(" ")}${a.task ? `\n${a.task}` : ""}`
              : a.cmd || ""
          )
      )
      .child(
        v_flex()
          .gap(7)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .children([
                div()
                  .text_size(11.5)
                  .font_medium()
                  .text_color(t.muted)
                  .child(hist.length ? `最近执行记录（${hist.length}）` : "暂无执行记录"),
                h_flex()
                  .gap(8)
                  .items_center()
                  .when(Boolean(current), (el) =>
                    el.child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(
                          `${fmtTime(current.ts)}${current.duration_ms != null ? ` · 耗时 ${fmtDur(current.duration_ms)}` : ""}${current.forced ? " · 手动" : ""}`
                        )
                    )
                  )
                  .when(Boolean(mdFile), (el) =>
                    el.child(
                      h_flex()
                        .id(`open-md-${job.id}`)
                        .h(22)
                        .px(8)
                        .gap(4)
                        .items_center()
                        .rounded(5)
                        .bg(t.selected)
                        .border_1()
                        .border_color(t.accent)
                        .text_size(11)
                        .font_medium()
                        .text_color(t.foreground)
                        .cursor_pointer()
                        .on_click(() => this.openMarkdownPreview(mdFile, job.name || "预览报告"))
                        .children([svg(ICON("external")).size(11), "打开报告"])
                    )
                  ),
              ])
          )
          .when(hist.length > 0, (el) =>
            el.children([
              h_flex()
                .gap(5)
                .overflow_x_scroll()
                .children(
                  hist.map((item, idx) => {
                    const active = idx === selIdx;
                    const c =
                      item.status === "ok"
                        ? t.done
                        : item.status === "err"
                        ? t.blocked
                        : t.idle;
                    return h_flex()
                      .id(`run-${job.id}-${idx}`)
                      .flex_none()
                      .h(22)
                      .px(8)
                      .gap(5)
                      .items_center()
                      .rounded(5)
                      .cursor_pointer()
                      .border_1()
                      .when(active, (e) => e.bg(t.selected).border_color(t.accent).text_color(t.foreground))
                      .when(!active, (e) => e.bg(t.raised).border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover)))
                      .on_click((_e, cx) => {
                        this.selectedRun[job.id] = idx;
                        cx.notify();
                      })
                      .children([
                        div().size(6).rounded_full().bg(c),
                        div().text_size(10.5).child(ago(item.ts)),
                      ]);
                  })
                ),
              div()
                .p(10)
                .max_h(170)
                .rounded(7)
                .bg(t.background)
                .border_1()
                .border_color(current?.status === "err" ? t.blocked : t.border)
                .overflow_y_scrollbar()
                .font_family(mono)
                .text_size(11.5)
                .whitespace_normal()
                .text_color(current?.status === "err" ? t.blocked : current?.msg ? t.foreground : t.dim)
                .child(current?.msg || "（无标准输出）"),
            ])
          )
      );
  }

  jobCard(job, jstate, t) {
    const enabled = job.enabled !== false;
    const status = jstate?.last_status;
    const isRunning = Boolean(jstate?.running || this.pendingRun[job.id]);
    const isExpanded = this.expanded.has(job.id);
    const confirming = this.confirmDel?.id === job.id;
    const meta = actionMeta(job.action);
    const doneOnce = Boolean(jstate?.done && job.schedule?.at);

    const railColor = isRunning
      ? t.working
      : status === "err"
      ? t.blocked
      : enabled
      ? t.done
      : t.border;

    const statusColor =
      status === "ok" ? t.done : status === "err" ? t.blocked : status === "skip" ? t.idle : t.dim;
    const nextLabel = isRunning
      ? "执行中…"
      : !enabled
      ? doneOnce
        ? "已完成"
        : "已暂停"
      : jstate?.schedule_error
      ? "规则异常"
      : until(jstate?.next_run);

    const toggleExpand = (_e, cx) => {
      if (this.expanded.has(job.id)) this.expanded.delete(job.id);
      else this.expanded.add(job.id);
      cx.notify();
    };

    return h_flex()
      .id(`job-${job.id}`)
      .flex_none()
      .rounded(11)
      .bg(t.surface)
      .border_1()
      .border_color(isRunning ? t.working : isExpanded ? t.accent : t.border)
      .shadow_xs()
      .overflow_hidden()
      .when(!enabled && !isRunning && !isExpanded, (el) => el.opacity(0.68))
      // 左侧 3px 语义状态竖条
      .child(div().w(3).flex_none().bg(railColor))
      // 右侧卡片主体
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .px(14)
          .py(12)
          .child(
            h_flex()
              .gap(12)
              .items_center()
              .children([
                // Switch
                h_flex()
                  .id(`tg-${job.id}`)
                  .w(30)
                  .h(17)
                  .flex_none()
                  .rounded_full()
                  .items_center()
                  .p(2)
                  .cursor_pointer()
                  .tooltip(enabled ? "点击暂停任务" : "点击启用任务")
                  .bg(enabled ? t.accent : t.raised)
                  .border_1()
                  .border_color(enabled ? t.accent : t.border)
                  .when(enabled, (e) => e.justify_end())
                  .when(!enabled, (e) => e.justify_start())
                  .on_click((_e, cx) => this.toggle(job, cx))
                  .child(div().w(11).h(11).rounded_full().bg(enabled ? t.accent_foreground : t.dim)),
                // 动作图标块
                this.actionBadge(meta, enabled, t),
                // 任务标题与摘要（点击展开/折叠）
                v_flex()
                  .id(`job-body-${job.id}`)
                  .flex_1()
                  .min_w(0)
                  .gap(4)
                  .cursor_pointer()
                  .on_click(toggleExpand)
                  .children([
                    h_flex()
                      .gap(7)
                      .items_center()
                      .children([
                        div()
                          .truncate()
                          .font_semibold()
                          .text_size(13.5)
                          .text_color(enabled ? t.foreground : t.muted)
                          .child(job.name || job.id),
                        div()
                          .id(`sch-${job.id}`)
                          .px(7)
                          .h(19)
                          .flex()
                          .flex_none()
                          .items_center()
                          .rounded(5)
                          .bg(t.raised)
                          .text_size(11)
                          .font_medium()
                          .text_color(t.muted)
                          .tooltip(schedRawTip(job.schedule))
                          .child(schedText(job.schedule)),
                        ...(job.notify
                          ? [
                              div()
                                .id(`nt-icon-${job.id}`)
                                .flex()
                                .flex_none()
                                .items_center()
                                .text_color(job.notify === "always" ? t.accent : t.dim)
                                .tooltip(job.notify === "always" ? "每次执行都提醒" : "仅失败时提醒")
                                .child(svg(ICON("bell")).size(12)),
                            ]
                          : []),
                        ...(isRunning
                          ? [
                              h_flex()
                                .gap(4)
                                .flex_none()
                                .items_center()
                                .px(6)
                                .h(19)
                                .rounded(5)
                                .bg(t.raised)
                                .text_size(10.5)
                                .text_color(t.working)
                                .children([svg(ICON("spinner")).size(10.5).spin(900), "运行中"]),
                            ]
                          : []),
                      ]),
                    div()
                      .truncate()
                      .text_size(11.5)
                      .text_color(t.dim)
                      .child(meta.summary),
                  ]),
                // 下次执行
                v_flex()
                  .w(92)
                  .flex_none()
                  .gap(2)
                  .items_end()
                  .children([
                    div().text_size(10).text_color(t.dim).child("下次执行"),
                    div()
                      .truncate()
                      .text_size(12)
                      .font_medium()
                      .text_color(jstate?.schedule_error ? t.blocked : enabled ? t.foreground : t.dim)
                      .child(nextLabel),
                  ]),
                // 柔和竖分隔
                div().w(1).h(24).flex_none().bg(t.border),
                // 上次执行
                v_flex()
                  .w(96)
                  .flex_none()
                  .gap(2)
                  .items_end()
                  .children([
                    div().text_size(10).text_color(t.dim).child("上次结果"),
                    h_flex()
                      .gap(4)
                      .items_center()
                      .when(Boolean(this.statusIcon(status, t)), (el) => el.child(this.statusIcon(status, t)))
                      .child(
                        div()
                          .truncate()
                          .text_size(11.5)
                          .text_color(statusColor)
                          .child(
                            status
                              ? `${ago(jstate?.last_run)}${jstate?.last_duration_ms != null ? ` · ${fmtDur(jstate.last_duration_ms)}` : ""}`
                              : "尚未运行"
                          )
                      ),
                  ]),
                // 操作组
                h_flex()
                  .pl(4)
                  .gap(2)
                  .flex_none()
                  .items_center()
                  .children([
                    this.iconBtn(
                      `run-${job.id}`,
                      isRunning ? "spinner" : "play",
                      isRunning ? "任务执行中" : "立即执行一次",
                      (_e, cx) => {
                        if (!isRunning) this.runNow(job, cx);
                      },
                      t,
                      { spinning: isRunning, subtle: !isRunning }
                    ),
                    this.iconBtn(`edit-${job.id}`, "edit", "编辑任务", () => this.openForm(job), t, { subtle: true }),
                    this.iconBtn(`dup-${job.id}`, "copy", "复制任务", (_e, cx) => this.duplicate(job, cx), t, { subtle: true }),
                    confirming
                      ? div()
                          .id(`del-cfm-${job.id}`)
                          .h(24)
                          .px(8)
                          .flex()
                          .items_center()
                          .rounded(5)
                          .bg(t.blocked)
                          .text_color("#ffffff")
                          .text_size(11)
                          .font_medium()
                          .cursor_pointer()
                          .on_click((_e, cx) => this.remove(job, cx))
                          .child("确认删除")
                      : this.iconBtn(
                          `del-${job.id}`,
                          "trash",
                          "删除任务",
                          (_e, cx) => {
                            this.confirmDel = { id: job.id, until: Date.now() + 4000 };
                            cx.notify();
                          },
                          t,
                          { subtle: true }
                        ),
                    this.iconBtn(
                      `exp-${job.id}`,
                      isExpanded ? "chevron-down" : "chevron-right",
                      isExpanded ? "收起详情" : "展开日志与详情",
                      toggleExpand,
                      t,
                      { subtle: !isExpanded }
                    ),
                  ]),
              ])
          )
          .when(!isExpanded && status === "err" && jstate?.last_msg, (el) =>
            el.child(
              h_flex()
                .id(`err-bar-${job.id}`)
                .mt(9)
                .px(10)
                .py(6)
                .gap(6)
                .items_center()
                .rounded(7)
                .bg(t.background)
                .border_1()
                .border_color(t.blocked)
                .cursor_pointer()
                .on_click(toggleExpand)
                .children([
                  svg(ICON("alert")).size(12.5).flex_none().text_color(t.blocked),
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11.5)
                    .text_color(t.blocked)
                    .child(jstate.last_msg.replace(/\s+/g, " ")),
                  div().flex_none().text_size(11).text_color(t.dim).child("查看详情 →"),
                ])
            )
          )
          .when(isExpanded, (el) => el.child(this.jobDetails(job, jstate, t)))
      );
  }

  // ---- empty state with quick templates -----------------------------------

  templateCard(id, icon, title, desc, preset, t) {
    return v_flex()
      .id(id)
      .flex_1()
      .min_w(160)
      .p(16)
      .gap(8)
      .rounded(11)
      .bg(t.surface)
      .border_1()
      .border_color(t.border)
      .shadow_xs()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).border_color(t.accent))
      .on_click(() => this.openForm(null, preset))
      .children([
        h_flex()
          .w(32)
          .h(32)
          .rounded(8)
          .bg(t.raised)
          .items_center()
          .justify_center()
          .text_color(t.accent)
          .child(svg(ICON(icon)).size(15)),
        div().font_semibold().text_size(13).text_color(t.foreground).child(title),
        div().text_size(11.5).text_color(t.dim).whitespace_normal().child(desc),
      ]);
  }

  emptyState(t) {
    const cwd = activeCwd();
    const firstAgent = agents()[0];
    return v_flex()
      .flex_1()
      .min_h(0)
      .items_center()
      .justify_center()
      .px(28)
      .gap(20)
      .children([
        v_flex()
          .items_center()
          .gap(8)
          .children([
            h_flex()
              .w(50)
              .h(50)
              .rounded(14)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .shadow_xs()
              .items_center()
              .justify_center()
              .text_color(t.accent)
              .child(svg(ICON("clock")).size(24)),
            div().font_semibold().text_size(15.5).text_color(t.foreground).child("还没有定时任务"),
            div()
              .text_size(12.5)
              .text_color(t.muted)
              .child("支持定时跑 Shell 命令、空闲时提醒 Agent、定时启动新 Agent，窗口关闭后依然在后台运行"),
          ]),
        h_flex()
          .w_full()
          .max_w(640)
          .gap(12)
          .children([
            this.templateCard(
              "tpl-exec",
              "terminal",
              "定时 Shell 检查",
              "按间隔或 Cron 自动跑测试、状态巡检或反思脚本",
              {
                name: "定时检查",
                schedule: { every_min: 30 },
                action: { type: "exec", cmd: "git status -s", cwd },
                notify: "err",
              },
              t
            ),
            this.templateCard(
              "tpl-prompt",
              "message",
              "提醒活跃 Agent",
              "定时向指定终端发送指令，默认仅在空闲时触发",
              {
                name: "进度巡检",
                schedule: { cron: "0 18 * * 1-5" },
                action: {
                  type: "prompt",
                  terminal: firstAgent?.address || "",
                  text: "总结一下今天完成的改动并检查是否有遗漏",
                  if: "idle",
                },
                notify: "always",
              },
              t
            ),
            this.templateCard(
              "tpl-spawn",
              "sparkles",
              "定时起新 Agent",
              "到点自动打开新 Tab 启动 Agent 执行审查或巡检",
              {
                name: "夜间代码审查",
                schedule: { cron: "0 22 * * *" },
                action: {
                  type: "spawn",
                  argv: this.defaultAgent.split(/\s+/),
                  task: "review 今天的 git diff 并列出潜在风险",
                  folder: cwd,
                  focus: false,
                },
                notify: "always",
              },
              t
            ),
          ]),
      ]);
  }

  // ---- inline filter & search bar (aligned inside centered container) -----

  filterToolbar(counts, t) {
    return h_flex()
      .flex_none()
      .gap(10)
      .items_center()
      .justify_between()
      .children([
        h_flex()
          .p(3)
          .gap(2)
          .rounded(8)
          .bg(t.raised)
          .children(
            FILTERS.map((f) => {
              const active = this.filter === f.id;
              const n = counts[f.id] || 0;
              const isErr = f.id === "err" && n > 0;
              return h_flex()
                .id(`flt-${f.id}`)
                .h(25)
                .px(10)
                .gap(5)
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .text_size(12)
                .when(active, (e) => e.bg(t.surface).text_color(t.foreground).font_medium().shadow_xs())
                .when(!active, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
                .on_click((_e, cx) => {
                  this.filter = f.id;
                  cx.notify();
                })
                .children([
                  f.label,
                  div()
                    .text_size(11)
                    .text_color(isErr ? t.blocked : active ? t.muted : t.dim)
                    .child(`${n}`),
                ]);
            })
          ),
        h_flex()
          .w(260)
          .h(30)
          .px(10)
          .gap(6)
          .items_center()
          .rounded(8)
          .bg(t.surface)
          .border_1()
          .border_color(this.searchFocused ? t.accent : t.border)
          .children([
            svg(ICON("search")).size(13).flex_none().text_color(this.searchFocused ? t.accent : t.dim),
            Input.new(this.searchInput)
              .flex_1()
              .min_w(0)
              .h_full()
              .text_color(t.foreground)
              .text_size(12),
            ...(this.query
              ? [
                  h_flex()
                    .id("search-clear")
                    .w(18)
                    .h(18)
                    .rounded(4)
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .text_color(t.dim)
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.searchInput.set_value("");
                      this.query = "";
                      cx.notify();
                    })
                    .child(svg(ICON("x")).size(11)),
                ]
              : []),
          ]),
      ]);
  }

  filteredJobs() {
    return this.jobs.filter((j) => {
      const enabled = j.enabled !== false;
      const st = this.st?.jobs?.[j.id];
      if (this.filter === "enabled" && !enabled) return false;
      if (this.filter === "paused" && enabled) return false;
      if (this.filter === "err" && st?.last_status !== "err") return false;
      if (this.query) {
        const meta = actionMeta(j.action);
        const hay = `${j.id} ${j.name || ""} ${schedText(j.schedule)} ${j.schedule?.cron || ""} ${meta.summary}`.toLowerCase();
        if (!hay.includes(this.query)) return false;
      }
      return true;
    });
  }

  render() {
    const t = theme();
    if (this.isForm) return renderForm(this, t);
    if (this.isGuide) return renderGuideDialog(this, t);
    if (this.isLogs) return this.renderLogsDialog(t);

    const counts = {
      all: this.jobs.length,
      enabled: this.jobs.filter((j) => j.enabled !== false).length,
      paused: this.jobs.filter((j) => j.enabled === false).length,
      err: this.jobs.filter((j) => this.st?.jobs?.[j.id]?.last_status === "err").length,
    };
    const visible = this.filteredJobs();

    return v_flex()
      .id("root")
      .size_full()
      .bg(t.canvas)
      // Clean top bar
      .child(
        h_flex()
          .flex_none()
          .items_center()
          .gap(10)
          .px(20)
          .py(12)
          .border_b_1()
          .border_color(t.border)
          .children([
            h_flex()
              .w(28)
              .h(28)
              .rounded(8)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .items_center()
              .justify_center()
              .text_color(t.accent)
              .child(svg(ICON("clock")).size(15)),
            div().font_semibold().text_size(15).text_color(t.foreground).child("Scheduler"),
            this.enginePill(t),
            div().flex_1(),
            h_flex()
              .id("open-guide")
              .h(28)
              .px(10)
              .gap(5)
              .items_center()
              .rounded(7)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .text_size(11.5)
              .text_color(t.muted)
              .cursor_pointer()
              .tooltip("查看内置 CLI 命令与 Agent 对话用法")
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.openGuide())
              .children([svg(ICON("book")).size(13).flex_none(), "命令速查"]),
            this.iconBtn("open-logs", "file-text", "查看引擎日志", () => this.openLogs(), t),
            this.iconBtn(
              "restart-eng",
              "refresh",
              "重启调度引擎",
              (_e, cx) => this.restartEngine(cx),
              t,
              { spinning: this.restarting }
            ),
            this.newJobButton(t, "add-job"),
          ])
      )
      // Error banner
      .when(Boolean(this.err || this.st?.engine?.jobs_error), (el) =>
        el.child(
          h_flex()
            .flex_none()
            .px(20)
            .py(8)
            .gap(8)
            .items_center()
            .bg(t.surface)
            .border_b_1()
            .border_color(t.blocked)
            .children([
              svg(ICON("alert")).size(14).text_color(t.blocked),
              div()
                .text_size(12)
                .text_color(t.blocked)
                .child(this.err || `引擎错误: ${this.st.engine.jobs_error}`),
            ])
        )
      )
      // Centered main workspace
      .child(
        this.jobs.length === 0
          ? this.emptyState(t)
          : div()
              .id("sched-list-scroll")
              .flex_1()
              .min_h(0)
              .w_full()
              .overflow_y_scrollbar()
              .child(
                v_flex()
                  .w_full()
                  .max_w(980)
                  .mx_auto()
                  .px(28)
                  .py(22)
                  .gap(16)
                  .child(this.overviewStrip(counts, t))
                  .child(this.filterToolbar(counts, t))
                  .child(
                    visible.length === 0
                      ? v_flex()
                          .flex_none()
                          .py(48)
                          .items_center()
                          .justify_center()
                          .gap(8)
                          .children([
                            div().text_size(13).font_medium().text_color(t.muted).child("没有匹配的任务"),
                            div()
                              .id("clear-filters")
                              .px(10)
                              .h(26)
                              .flex()
                              .items_center()
                              .rounded(6)
                              .bg(t.surface)
                              .border_1()
                              .border_color(t.border)
                              .text_size(11.5)
                              .text_color(t.muted)
                              .cursor_pointer()
                              .hover((s) => s.bg(t.hover).text_color(t.foreground))
                              .on_click((_e, cx) => {
                                this.filter = "all";
                                this.query = "";
                                this.searchInput.set_value("");
                                cx.notify();
                              })
                              .child("重置筛选"),
                          ])
                      : v_flex()
                          .flex_none()
                          .gap(10)
                          .children(visible.map((j) => this.jobCard(j, this.st?.jobs?.[j.id], t)))
                  )
              )
      )
      // Subtle footer
      .child(
        h_flex()
          .flex_none()
          .px(20)
          .py(8)
          .items_center()
          .justify_between()
          .border_t_1()
          .border_color(t.border)
          .text_size(11)
          .text_color(t.dim)
          .children([
            div().child(`${tilde(JOBS())} · 窗口关闭后仍由 herdr-core 后台运行`),
            div().child("点击卡片展开运行历史与日志"),
          ])
      );
  }
}
