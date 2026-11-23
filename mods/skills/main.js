// Skills — 全中文技能管理面板（同时自适应右侧独立侧栏 & 宽屏弹窗/标签页）。
// 扫描 ~/.agents/skills、~/.claude/skills、~/.cursor/skills、~/.codex/skills 及当前项目技能，
// 支持搜索筛选、三端软链同步状态检查与一键同步、完整 SKILL.md 渲染预览、以及一键发给当前 Agent 调用。
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextView } from "gpui-base";
import {
  agents,
  appHome,
  checking,
  closeOverlay,
  exec,
  focused,
  hc,
  notify,
  openOverlay,
  panes,
  props,
  readTextFile,
  spaces,
  theme,
} from "herdr";

const SCAN_PY = () => `${appHome()}/mods/skills/scan.py`;
const ICON = (name) => `mods/skills/icons/${name}.svg`;

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "agents", label: "全局通用" },
  { id: "unsynced", label: "待同步" },
  { id: "project", label: "当前项目" },
];

const SOURCE_LABELS = {
  agents: "全局通用 (~/.agents)",
  claude: "仅 Claude 可用",
  cursor: "仅 Cursor 可用",
  codex: "仅 Codex 可用",
  project: "当前项目专属",
};

function tilde(p) {
  return p ? String(p).replace(/^\/Users\/[^/]+/, "~") : "";
}

function activeLocalCwd() {
  const sp = spaces().find((s) => s.active);
  if (!sp || sp.machine) return "";
  const tabs = new Set((sp.tabs || []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || sp.folder || "";
}

function isFullySynced(skill) {
  if (!skill.sync) return true;
  return Boolean(skill.sync.claude && skill.sync.cursor && skill.sync.codex);
}

export default class Skills extends View {
  init(p, cx) {
    const myProps = p || props() || {};
    this.isOverlay = Boolean(myProps.overlay);
    this.size = { width: this.isOverlay ? 820 : 368, height: 600 };

    this.items = [];
    this.loading = true;
    this.error = null;
    this.filter = "all";
    this.query = "";
    this.searchFocused = false;
    this.selected = null;
    this.detailOpen = false; // used in narrow side-panel drill-down mode
    this.mdText = null;
    this.mdVersion = 0;
    this.mdLoading = false;
    this.syncing = false;
    this.copiedPath = false;

    this.targetAddr = this.resolveTargetAddr();
    this.handle = cx.focus_handle();
    this.searchInput = InputState.new({ placeholder: "搜索技能名称或触发词…" });
    this.searchInput.on("focus", (_e, cx) => { this.searchFocused = true; cx.notify(); });
    this.searchInput.on("blur", (_e, cx) => { this.searchFocused = false; cx.notify(); });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value().trim().toLowerCase();
      cx.notify();
    });

    if (checking()) return;
    this.reload(cx, myProps.initialSkillId || null);
    if (this.isOverlay) cx.timer.after(40, () => this.searchInput.focus());
  }

  resolveTargetAddr() {
    const f = focused();
    const live = agents();
    const hit =
      live.find((a) => a.address === f?.terminal) ||
      live.find((a) => a.address === f?.agent) ||
      live[0] ||
      null;
    return f?.terminal || hit?.address || null;
  }

  isWide() {
    return (this.size?.width || 368) >= 620;
  }

  reload(cx, pickId = null) {
    this.loading = true;
    this.error = null;
    cx.notify();
    const cwd = activeLocalCwd();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [SCAN_PY(), cwd || ""], { timeout: 15000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim());
        const list = JSON.parse(r.stdout || "[]");
        this.items = Array.isArray(list) ? list : [];
        if (pickId) {
          const hit = this.items.find((x) => x.id === pickId);
          if (hit) this.select(hit, cx, { openDetail: true });
        } else if (this.selected) {
          const updated = this.items.find((x) => x.id === this.selected.id);
          if (updated) this.selected = updated;
          else if (this.items.length && this.isWide()) this.select(this.items[0], cx, { openDetail: false });
        } else if (this.items.length && this.isWide()) {
          this.select(this.items[0], cx, { openDetail: false });
        }
      } catch (e) {
        this.error = String(e?.message || e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  select(skill, cx, { openDetail = true } = {}) {
    this.selected = skill;
    if (openDetail) this.detailOpen = true;
    this.mdText = null;
    this.mdLoading = true;
    this.copiedPath = false;
    cx.notify();
    const id = skill.id;
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(skill.path).catch(() => null);
        if (this.selected?.id !== id) return;
        this.mdText = raw
          ? raw.length > 150000
            ? raw.slice(0, 150000) + "\n\n…（文档过长已截断）"
            : raw
          : "（无法读取 SKILL.md）";
        this.mdVersion++;
      } finally {
        if (this.selected?.id === id) {
          this.mdLoading = false;
          cx.notify();
        }
      }
    });
  }

  syncThreeClients(skill, cx) {
    if (!skill?.canSync || this.syncing) return;
    this.syncing = true;
    cx.notify();
    const name = skill.name;
    const script = `
      set -e
      mkdir -p "$HOME/.claude/skills" "$HOME/.cursor/skills" "$HOME/.codex/skills"
      [ -e "$HOME/.claude/skills/$1" ] || ln -s "../../.agents/skills/$1" "$HOME/.claude/skills/$1"
      [ -e "$HOME/.cursor/skills/$1" ] || ln -s "../../.agents/skills/$1" "$HOME/.cursor/skills/$1"
      [ -e "$HOME/.codex/skills/$1" ]  || ln -s "../../.agents/skills/$1" "$HOME/.codex/skills/$1"
    `;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", script, "sync-skill", name], { timeout: 10000 });
        if (r.code === 0) {
          notify({ title: "技能同步成功", body: `${name} 已同步到 Claude / Cursor / Codex`, level: "success", timeout: 2200 });
          this.reload(cx);
        } else {
          notify({ title: "同步失败", body: (r.stderr || r.stdout || "").slice(0, 160), level: "error" });
        }
      } finally {
        this.syncing = false;
        cx.notify();
      }
    });
  }

  invokeOnAgent(skill, cx) {
    const addr = this.targetAddr || this.resolveTargetAddr();
    const text = `请先读取技能 ${skill.name}（${tilde(skill.path)}），并按照其中的步骤帮我处理当前任务。`;
    if (!addr) {
      cx.write_to_clipboard(text);
      notify({ title: "已复制调用指令", body: "无聚焦终端，已复制到剪贴板", level: "info", timeout: 2000 });
      return;
    }
    cx.spawn(async () => {
      const r = await hc(["send", addr, text]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) {
        notify({ title: `已发送到 ${addr}`, body: `调用技能：${skill.name}`, level: "success", timeout: 2000 });
        if (props()?.overlay) closeOverlay(props().overlay);
      } else {
        notify({ title: "发送失败", body: (r.stderr || r.stdout || "").slice(0, 160), level: "error" });
      }
    });
  }

  openWideModal() {
    openOverlay({
      mod: "skills",
      props: { initialSkillId: this.selected?.id || null },
      kind: "dialog",
      width: 840,
      height: 620,
    });
  }

  filtered() {
    return this.items.filter((s) => {
      if (this.filter === "agents" && s.source !== "agents") return false;
      if (this.filter === "project" && s.source !== "project") return false;
      if (this.filter === "unsynced" && (!s.canSync || isFullySynced(s))) return false;
      if (this.query) {
        const hay = `${s.name} ${s.display} ${s.desc} ${s.source}`.toLowerCase();
        if (!hay.includes(this.query)) return false;
      }
      return true;
    });
  }

  syncBadge(label, state, t) {
    const ok = state === "ok" || state === "dir";
    const broken = state === "broken";
    return h_flex()
      .h(18)
      .px(6)
      .gap(4)
      .items_center()
      .rounded(4)
      .bg(t.raised)
      .text_size(10)
      .text_color(broken ? t.blocked : ok ? t.foreground : t.dim)
      .children([
        div().size(5.5).rounded_full().bg(broken ? t.blocked : ok ? t.done : t.border),
        label,
      ]);
  }

  // ---- reusable list pane -------------------------------------------------

  renderListPane(list, t, wide) {
    const sel = this.selected;
    return v_flex()
      .when(wide, (el) => el.w(280).flex_none().border_r_1().border_color(t.border).bg(t.chrome))
      .when(!wide, (el) => el.flex_1().min_w(0).bg(t.background))
      .h_full()
      .min_h(0)
      .child(
        v_flex()
          .flex_none()
          .p(10)
          .gap(7)
          .border_b_1()
          .border_color(t.border)
          .child(
            h_flex()
              .h(30)
              .px(8)
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
                        .id("sk-clr")
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
              ])
          )
          .child(
            h_flex()
              .gap(3)
              .children(
                FILTERS.map((f) => {
                  const on = this.filter === f.id;
                  return div()
                    .id(`skf-${f.id}`)
                    .h(22)
                    .px(7)
                    .flex()
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .text_size(11)
                    .when(on, (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
                    .when(!on, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
                    .on_click((_e, cx) => { this.filter = f.id; cx.notify(); })
                    .child(f.label);
                })
              )
          )
      )
      .child(
        div()
          .id("sk-list-scroll")
          .flex_1()
          .min_h(0)
          .w_full()
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .w_full()
              .p(6)
              .gap(3)
              .when(this.error, (el) => el.child(div().p(10).text_size(11.5).text_color(t.blocked).child(this.error)))
              .when(!this.error && list.length === 0, (el) =>
                el.child(div().p(14).text_size(12).text_color(t.dim).child(this.loading ? "正在扫描技能…" : "没有匹配的技能"))
              )
              .children(
                list.map((sk) => {
                  const on = wide && sel?.id === sk.id;
                  return v_flex()
                    .id(`sk-item-${sk.id}`)
                    .flex_none()
                    .px(9)
                    .py(7)
                    .gap(3)
                    .rounded(7)
                    .cursor_pointer()
                    .when(on, (e) => e.bg(t.selected))
                    .when(!on, (e) => e.hover((s) => s.bg(t.hover)))
                    .on_click((_e, cx) => this.select(sk, cx, { openDetail: true }))
                    .child(
                      h_flex()
                        .gap(6)
                        .items_center()
                        .children([
                          div()
                            .flex_1()
                            .min_w(0)
                            .truncate()
                            .text_size(12.5)
                            .font_medium()
                            .text_color(t.foreground)
                            .child(sk.name),
                          ...(sk.sync
                            ? [
                                h_flex()
                                  .gap(3)
                                  .flex_none()
                                  .items_center()
                                  .tooltip("同步状态：Claude / Cursor / Codex")
                                  .children([
                                    div().size(5).rounded_full().bg(sk.sync.claude ? t.done : t.border),
                                    div().size(5).rounded_full().bg(sk.sync.cursor ? t.done : t.border),
                                    div().size(5).rounded_full().bg(sk.sync.codex ? t.done : t.border),
                                  ]),
                              ]
                            : [div().text_size(10).text_color(t.accent).child("项目")]),
                        ])
                    )
                    .when(Boolean(sk.desc), (el) =>
                      el.child(div().truncate().text_size(11).text_color(t.dim).child(sk.desc))
                    );
                })
              )
          )
      );
  }

  // ---- reusable detail pane -----------------------------------------------

  renderDetailPane(sel, t, wide) {
    if (!sel) {
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .text_size(12.5)
        .text_color(t.dim)
        .child("在左侧选择一个技能查看详情");
    }
    const liveAgents = agents();
    if (!this.targetAddr && liveAgents.length) this.targetAddr = liveAgents[0].address;

    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(0)
      .h_full()
      .bg(t.background)
      // Metadata header
      .child(
        v_flex()
          .flex_none()
          .px(12)
          .py(10)
          .gap(7)
          .border_b_1()
          .border_color(t.border)
          .bg(t.surface)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .justify_between()
              .children([
                h_flex()
                  .flex_1()
                  .min_w(0)
                  .gap(6)
                  .items_center()
                  .children([
                    div().font_semibold().text_size(13.5).text_color(t.foreground).truncate().child(sel.name),
                    div()
                      .px(5.5)
                      .h(18)
                      .flex()
                      .flex_none()
                      .items_center()
                      .rounded(4)
                      .bg(t.raised)
                      .text_size(10)
                      .text_color(t.muted)
                      .child(SOURCE_LABELS[sel.source] || sel.source),
                  ]),
                h_flex()
                  .id("sk-copy-path")
                  .h(22)
                  .px(7)
                  .gap(4)
                  .flex_none()
                  .items_center()
                  .rounded(5)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.background)
                  .text_size(10.5)
                  .text_color(this.copiedPath ? t.done : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    cx.write_to_clipboard(sel.path);
                    this.copiedPath = true;
                    notify({ title: "已复制路径", body: tilde(sel.path), level: "success", timeout: 1600 });
                    cx.notify();
                  })
                  .children([svg(ICON(this.copiedPath ? "check" : "copy")).size(10.5), this.copiedPath ? "已复制" : "路径"]),
              ])
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .justify_between()
              .children([
                ...(sel.sync
                  ? [
                      h_flex()
                        .gap(4)
                        .flex_none()
                        .children([
                          this.syncBadge("Claude", sel.sync.claude, t),
                          this.syncBadge("Cursor", sel.sync.cursor, t),
                          this.syncBadge("Codex", sel.sync.codex, t),
                        ]),
                    ]
                  : [div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(tilde(sel.path))]),
                ...(sel.canSync && !isFullySynced(sel)
                  ? [
                      h_flex()
                        .id("sk-sync-btn")
                        .h(22)
                        .px(8)
                        .gap(4)
                        .flex_none()
                        .items_center()
                        .rounded(5)
                        .bg(t.selected)
                        .border_1()
                        .border_color(t.accent)
                        .text_size(10.5)
                        .font_medium()
                        .text_color(t.foreground)
                        .cursor_pointer()
                        .on_click((_e, cx) => this.syncThreeClients(sel, cx))
                        .children([svg(ICON("refresh")).size(10.5), this.syncing ? "同步中…" : "同步到全部 Agent"]),
                    ]
                  : []),
              ])
          )
      )
      // Rendered SKILL.md
      .child(
        div()
          .id("sk-md-scroll")
          .flex_1()
          .min_h(0)
          .w_full()
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .w_full()
              .px(wide ? 18 : 13)
              .py(12)
              .child(
                this.mdLoading
                  ? div().text_size(12).text_color(t.dim).child("正在加载 SKILL.md…")
                  : TextView.markdown(`sk-md-${this.mdVersion}`, this.mdText || "").selectable()
              )
          )
      )
      // Footer invoke bar
      .child(
        h_flex()
          .flex_none()
          .px(12)
          .py(9)
          .gap(6)
          .items_center()
          .justify_between()
          .border_t_1()
          .border_color(t.border)
          .bg(t.surface)
          .children([
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11)
              .text_color(t.dim)
              .child(
                this.targetAddr ? `目标：${this.targetAddr}` : "无活跃 Agent（将复制）"
              ),
            h_flex()
              .id("sk-invoke")
              .h(26)
              .px(10)
              .gap(5)
              .flex_none()
              .items_center()
              .rounded(6)
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .text_size(11.5)
              .font_medium()
              .cursor_pointer()
              .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
              .on_click((_e, cx) => this.invokeOnAgent(sel, cx))
              .children([svg(ICON("send")).size(11), "让 Agent 调用"]),
          ])
      );
  }

  render() {
    const t = theme();
    const list = this.filtered();
    const wide = this.isWide();
    const showDetailOnly = !wide && this.detailOpen && Boolean(this.selected);
    const unsyncedCount = this.items.filter((s) => s.canSync && !isFullySynced(s)).length;

    return v_flex()
      .id("skills-root")
      .size_full()
      .min_h(0)
      .when(!this.isOverlay, (el) => el.rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border))
      .when(this.isOverlay, (el) => el.bg(t.popover))
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        if (Math.abs((this.size?.width || 0) - size.width) > 10) {
          this.size = size;
          if (this.isWide() && !this.selected && this.items.length) {
            this.select(this.items[0], cx, { openDetail: false });
          } else {
            cx.notify();
          }
        }
      })
      // Header
      .child(
        h_flex()
          .flex_none()
          .h(42)
          .px(12)
          .gap(7)
          .items_center()
          .justify_between()
          .border_b_1()
          .border_color(t.border)
          .children([
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(7)
              .items_center()
              .children([
                ...(showDetailOnly
                  ? [
                      h_flex()
                        .id("sk-back")
                        .size(24)
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .rounded(6)
                        .cursor_pointer()
                        .text_color(t.muted)
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .tooltip("返回技能列表")
                        .on_click((_e, cx) => { this.detailOpen = false; cx.notify(); })
                        .child(svg(ICON("arrow-left")).size(14)),
                    ]
                  : [svg(ICON("layers")).size(14.5).flex_none().text_color(t.accent)]),
                div().font_semibold().text_size(13.5).text_color(t.foreground).child("技能"),
                div()
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .border_1()
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(t.muted)
                  .child(`${this.items.length}`),
                ...(wide && unsyncedCount > 0
                  ? [div().text_size(11).text_color(t.working).child(`· ${unsyncedCount} 个待同步`)]
                  : []),
              ]),
            h_flex()
              .gap(4)
              .flex_none()
              .items_center()
              .children([
                h_flex()
                  .id("sk-refresh")
                  .size(24)
                  .rounded(6)
                  .items_center()
                  .justify_center()
                  .cursor_pointer()
                  .text_color(t.muted)
                  .tooltip("重新扫描本地技能")
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.reload(cx))
                  .child(svg(ICON("refresh")).size(13).when(this.loading, (e) => e.spin(900))),
                ...(!this.isOverlay
                  ? [
                      h_flex()
                        .id("sk-expand")
                        .size(24)
                        .rounded(6)
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .text_color(t.muted)
                        .tooltip("大窗口双栏浏览")
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .on_click(() => this.openWideModal())
                        .child(svg(ICON("external")).size(13)),
                    ]
                  : [
                      h_flex()
                        .id("sk-close")
                        .size(24)
                        .rounded(6)
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .text_color(t.dim)
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .on_click(() => closeOverlay(props().overlay))
                        .child(svg(ICON("x")).size(14)),
                    ]),
              ]),
          ])
      )
      // Body: dual-pane when wide, drill-down when narrow right side-panel
      .child(
        wide
          ? h_flex()
              .flex_1()
              .min_h(0)
              .w_full()
              .child(this.renderListPane(list, t, true))
              .child(this.renderDetailPane(this.selected, t, true))
          : showDetailOnly
          ? this.renderDetailPane(this.selected, t, false)
          : this.renderListPane(list, t, false)
      );
  }
}
