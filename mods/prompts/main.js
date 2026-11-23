// Prompts — Raycast 风格的高频 Prompt 指令库（⌘⇧Y 随时呼出）。
// 持久化在 ~/.config/herdr-app/prompts.json，支持分类筛选、实时搜索、键盘 ↑/↓ + Enter 一键直发当前 Agent、
// 原生剪贴板复制，以及行内新建/编辑/置顶/删除。
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import {
  agents,
  appHome,
  checking,
  closeOverlay,
  focused,
  hc,
  notify,
  props,
  readTextFile,
  theme,
  writeTextFile,
} from "herdr";

const FILE = () => `${appHome()}/prompts.json`;
const ICON = (name) => `mods/prompts/icons/${name}.svg`;
const CATEGORIES = ["全部", "审查", "调试", "开发", "汇报", "其他"];

function uid() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

async function savePromptsAtomic(mutate) {
  const path = FILE();
  for (let attempt = 0; attempt < 3; attempt++) {
    const old = await readTextFile(path).catch(() => null);
    let data;
    try {
      data = JSON.parse(old || '{"version":1,"items":[]}');
      if (!Array.isArray(data.items)) data.items = [];
    } catch {
      data = { version: 1, items: [] };
    }
    mutate(data.items);
    const next = JSON.stringify(data, null, 2) + "\n";
    try {
      await writeTextFile(path, next, old);
      return { ok: true, items: data.items };
    } catch {}
  }
  return { ok: false };
}

export default class Prompts extends View {
  init(_props, cx) {
    this.items = [];
    this.loading = true;
    this.query = "";
    this.category = "全部";
    this.selectedIdx = 0;
    this.searchFocused = false;
    this.copiedId = null;
    this.confirmDel = null; // { id, until }
    this.sendingId = null;

    // Target terminal (defaults to focused terminal/agent)
    const f = focused();
    const live = agents();
    const matched =
      live.find((a) => a.address === f?.terminal) ||
      live.find((a) => a.address === f?.agent) ||
      live[0] ||
      null;
    this.targetAddr = f?.terminal || matched?.address || null;

    // Editor mode state
    this.editing = null; // null | { id?, title, category, content }
    this.focusedField = null;
    this.f_title = null;
    this.f_content = null;

    this.handle = cx.focus_handle();
    this.searchInput = InputState.new({ placeholder: "搜索指令标题或内容… (↑↓ 选择 · ↵ 发送 · Esc 关闭)" });
    this.searchInput.on("focus", (_e, cx) => { this.searchFocused = true; cx.notify(); });
    this.searchInput.on("blur", (_e, cx) => { this.searchFocused = false; cx.notify(); });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value().trim().toLowerCase();
      this.selectedIdx = 0;
      cx.notify();
    });
    this.searchInput.on("submit", (_e, cx) => {
      const list = this.filtered();
      const item = list[this.selectedIdx];
      if (item) this.sendItem(item, cx);
    });

    if (checking()) return;
    this.load(cx);
    cx.timer.after(40, () => this.searchInput.focus());
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(FILE()).catch(() => null);
        const data = JSON.parse(raw || '{"version":1,"items":[]}');
        this.items = Array.isArray(data.items) ? data.items : [];
      } catch {
        this.items = [];
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  filtered() {
    return [...this.items]
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return (b.at || 0) - (a.at || 0);
      })
      .filter((it) => {
        if (this.category !== "全部" && (it.category || "其他") !== this.category) return false;
        if (this.query) {
          const hay = `${it.title || ""} ${it.content || ""} ${it.category || ""}`.toLowerCase();
          if (!hay.includes(this.query)) return false;
        }
        return true;
      });
  }

  sendItem(item, cx) {
    if (!item?.content || this.sendingId) return;
    const addr = this.targetAddr;
    if (!addr) {
      cx.write_to_clipboard(item.content);
      notify({ title: "已复制到剪贴板", body: "当前无聚焦终端，已改为复制该指令", level: "info", timeout: 2200 });
      closeOverlay(props().overlay);
      return;
    }
    this.sendingId = item.id;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["send", addr, item.content]).catch((e) => ({ code: 1, stderr: String(e) }));
      this.sendingId = null;
      if (r.code === 0) {
        await savePromptsAtomic((list) => {
          const hit = list.find((x) => x.id === item.id);
          if (hit) hit.at = Date.now();
        });
        notify({ title: `已发送到 ${addr}`, body: item.title, level: "success", timeout: 1800 });
        closeOverlay(props().overlay);
      } else {
        notify({
          title: "发送失败",
          body: (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 160),
          level: "error",
        });
        cx.notify();
      }
    });
  }

  copyItem(item, cx) {
    if (!item?.content) return;
    cx.write_to_clipboard(item.content);
    this.copiedId = item.id;
    notify({ title: "已复制到剪贴板", body: item.title, level: "success", timeout: 1600 });
    cx.notify();
    cx.timer.after(1600, (cx) => {
      if (this.copiedId === item.id) {
        this.copiedId = null;
        cx.notify();
      }
    });
  }

  togglePin(item, cx) {
    cx.spawn(async (cx) => {
      const res = await savePromptsAtomic((list) => {
        const hit = list.find((x) => x.id === item.id);
        if (hit) hit.pinned = !hit.pinned;
      });
      if (res.ok) this.items = res.items;
      cx.notify();
    });
  }

  removeItem(item, cx) {
    this.confirmDel = null;
    cx.spawn(async (cx) => {
      const res = await savePromptsAtomic((list) => {
        const i = list.findIndex((x) => x.id === item.id);
        if (i >= 0) list.splice(i, 1);
      });
      if (res.ok) this.items = res.items;
      cx.notify();
    });
  }

  // ---- editor form --------------------------------------------------------

  openEditor(item, cx) {
    this.editing = {
      id: item?.id || null,
      title: item?.title || "",
      category: item?.category || "开发",
      content: item?.content || "",
    };
    this.f_title = InputState.new({ value: this.editing.title, placeholder: "简短指令名称，例如：边界风险 Review" });
    this.f_content = TextareaState.new({ value: this.editing.content, placeholder: "输入完整 Prompt 内容…", rows: 7 });
    this.f_title.on("focus", (_e, cx) => { this.focusedField = "title"; cx.notify(); });
    this.f_title.on("blur", (_e, cx) => { if (this.focusedField === "title") { this.focusedField = null; cx.notify(); } });
    this.f_content.on("focus", (_e, cx) => { this.focusedField = "content"; cx.notify(); });
    this.f_content.on("blur", (_e, cx) => { if (this.focusedField === "content") { this.focusedField = null; cx.notify(); } });
    cx.notify();
    cx.timer.after(30, () => this.f_title?.focus());
  }

  saveEditor(cx) {
    if (!this.editing) return;
    const title = this.f_title.value().trim();
    const content = this.f_content.value().trim();
    if (!title || !content) {
      notify({ title: "指令库", body: "标题和内容都需要填写", level: "error", timeout: 2200 });
      return;
    }
    const id = this.editing.id || uid();
    const cat = this.editing.category || "开发";
    const now = Date.now();
    cx.spawn(async (cx) => {
      const res = await savePromptsAtomic((list) => {
        const idx = list.findIndex((x) => x.id === id);
        if (idx >= 0) {
          list[idx] = { ...list[idx], title, category: cat, content, at: now };
        } else {
          list.unshift({ id, title, category: cat, content, pinned: false, at: now });
        }
      });
      if (res.ok) {
        this.items = res.items;
        this.editing = null;
        notify({ title: "指令库", body: `已保存「${title}」`, level: "success", timeout: 1800 });
        cx.notify();
        cx.timer.after(30, () => this.searchInput.focus());
      }
    });
  }

  renderEditor(t) {
    const cats = CATEGORIES.filter((c) => c !== "全部");
    return v_flex()
      .id("prompts-editor")
      .size_full()
      .bg(t.popover)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") this.saveEditor(cx);
        else if (e.key === "escape") {
          this.editing = null;
          cx.notify();
          cx.stop_propagation();
        }
      })
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
            div().font_semibold().text_size(14.5).text_color(t.foreground).child(this.editing.id ? "编辑指令模板" : "新建指令模板"),
            h_flex()
              .id("pe-back")
              .h(26)
              .px(9)
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .text_size(11.5)
              .text_color(t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => { this.editing = null; cx.notify(); })
              .child("返回列表"),
          ])
      )
      .child(
        div()
          .id("pe-scroll")
          .flex_1()
          .min_h(0)
          .w_full()
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .w_full()
              .px(18)
              .py(14)
              .gap(13)
              .child(
                v_flex()
                  .flex_none()
                  .gap(5)
                  .child(div().text_size(11.5).font_medium().text_color(t.muted).child("指令名称"))
                  .child(
                    h_flex()
                      .h(34)
                      .px(10)
                      .items_center()
                      .rounded(7)
                      .bg(t.background)
                      .border_1()
                      .border_color(this.focusedField === "title" ? t.accent : t.input)
                      .child(Input.new(this.f_title).flex_1().min_w(0).h_full().text_size(13).text_color(t.foreground))
                  )
              )
              .child(
                v_flex()
                  .flex_none()
                  .gap(6)
                  .child(div().text_size(11.5).font_medium().text_color(t.muted).child("分类"))
                  .child(
                    h_flex()
                      .gap(6)
                      .children(
                        cats.map((c) => {
                          const on = this.editing.category === c;
                          return div()
                            .id(`pe-cat-${c}`)
                            .h(26)
                            .px(11)
                            .flex()
                            .items_center()
                            .rounded(6)
                            .cursor_pointer()
                            .border_1()
                            .text_size(11.5)
                            .when(on, (e) => e.bg(t.selected).border_color(t.accent).text_color(t.foreground).font_medium())
                            .when(!on, (e) => e.bg(t.surface).border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover)))
                            .on_click((_e, cx) => { this.editing.category = c; cx.notify(); })
                            .child(c);
                        })
                      )
                  )
              )
              .child(
                v_flex()
                  .flex_none()
                  .gap(5)
                  .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Prompt 内容"))
                  .child(
                    Textarea.new(this.f_content)
                      .h(210)
                      .px(11)
                      .py(8)
                      .rounded(8)
                      .bg(t.background)
                      .border_1()
                      .border_color(this.focusedField === "content" ? t.accent : t.input)
                      .text_size(12.5)
                      .text_color(t.foreground)
                  )
              )
          )
      )
      .child(
        h_flex()
          .flex_none()
          .px(18)
          .py(12)
          .items_center()
          .justify_between()
          .border_t_1()
          .border_color(t.border)
          .children([
            div().text_size(11).text_color(t.dim).child("⌘Enter 保存 · Esc 返回"),
            h_flex()
              .gap(8)
              .children([
                div()
                  .id("pe-cancel")
                  .h(30)
                  .px(12)
                  .flex()
                  .items_center()
                  .rounded(7)
                  .cursor_pointer()
                  .text_size(12)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => { this.editing = null; cx.notify(); })
                  .child("取消"),
                div()
                  .id("pe-save")
                  .h(30)
                  .px(15)
                  .flex()
                  .items_center()
                  .rounded(7)
                  .cursor_pointer()
                  .bg(t.solid)
                  .text_color(t.solid_foreground)
                  .text_size(12)
                  .font_medium()
                  .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
                  .on_click((_e, cx) => this.saveEditor(cx))
                  .child("保存指令"),
              ]),
          ])
      );
  }

  // ---- main snippet picker ------------------------------------------------

  render() {
    const t = theme();
    if (this.editing) return this.renderEditor(t);

    const list = this.filtered();
    const sel = Math.min(this.selectedIdx, Math.max(0, list.length - 1));
    const liveAgents = agents();
    const now = Date.now();
    if (this.confirmDel && now > this.confirmDel.until) this.confirmDel = null;

    return v_flex()
      .id("prompts-dialog")
      .size_full()
      .bg(t.popover)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "down") {
          if (list.length) this.selectedIdx = (sel + 1) % list.length;
          cx.notify();
          cx.stop_propagation();
        } else if (e.key === "up") {
          if (list.length) this.selectedIdx = (sel - 1 + list.length) % list.length;
          cx.notify();
          cx.stop_propagation();
        } else if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") {
          const item = list[sel];
          if (item) this.sendItem(item, cx);
          cx.stop_propagation();
        }
      })
      // Top search & new bar
      .child(
        h_flex()
          .flex_none()
          .px(16)
          .py(12)
          .gap(8)
          .items_center()
          .border_b_1()
          .border_color(t.border)
          .children([
            h_flex()
              .flex_1()
              .min_w(0)
              .h(34)
              .px(10)
              .gap(7)
              .items_center()
              .rounded(8)
              .bg(t.background)
              .border_1()
              .border_color(this.searchFocused ? t.accent : t.border)
              .children([
                svg(ICON("search")).size(14).flex_none().text_color(this.searchFocused ? t.accent : t.dim),
                Input.new(this.searchInput).flex_1().min_w(0).h_full().text_size(12.5).text_color(t.foreground),
                ...(this.query
                  ? [
                      div()
                        .id("pr-clr")
                        .size(18)
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .rounded(4)
                        .cursor_pointer()
                        .text_color(t.dim)
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .on_click((_e, cx) => {
                          this.searchInput.set_value("");
                          this.query = "";
                          this.selectedIdx = 0;
                          cx.notify();
                        })
                        .child(svg(ICON("x")).size(11)),
                    ]
                  : []),
              ]),
            h_flex()
              .id("pr-new")
              .h(34)
              .px(11)
              .gap(5)
              .flex_none()
              .items_center()
              .rounded(8)
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .text_size(12)
              .font_medium()
              .cursor_pointer()
              .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
              .on_click((_e, cx) => this.openEditor(null, cx))
              .children([svg(ICON("plus")).size(13), "新建"]),
          ])
      )
      // Category tabs + Target terminal picker
      .child(
        h_flex()
          .flex_none()
          .px(16)
          .py(8)
          .gap(8)
          .items_center()
          .justify_between()
          .border_b_1()
          .border_color(t.border)
          .bg(t.chrome)
          .children([
            h_flex()
              .gap(3)
              .children(
                CATEGORIES.map((c) => {
                  const on = this.category === c;
                  return div()
                    .id(`pcat-${c}`)
                    .h(22)
                    .px(8)
                    .flex()
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .text_size(11.5)
                    .when(on, (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
                    .when(!on, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
                    .on_click((_e, cx) => {
                      this.category = c;
                      this.selectedIdx = 0;
                      cx.notify();
                    })
                    .child(c);
                })
              ),
            // Active target terminal selector
            h_flex()
              .gap(5)
              .items_center()
              .children([
                div().text_size(10.5).text_color(t.dim).child("发送到:"),
                ...(liveAgents.length > 0
                  ? liveAgents.slice(0, 3).map((ag) => {
                      const on = this.targetAddr === ag.address;
                      return h_flex()
                        .id(`ptgt-${ag.address}`)
                        .h(22)
                        .px(7)
                        .gap(4)
                        .items_center()
                        .rounded(5)
                        .cursor_pointer()
                        .border_1()
                        .text_size(10.5)
                        .when(on, (e) => e.bg(t.selected).border_color(t.accent).text_color(t.foreground).font_medium())
                        .when(!on, (e) => e.bg(t.surface).border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover)))
                        .on_click((_e, cx) => { this.targetAddr = ag.address; cx.notify(); })
                        .children([
                          div().size(5.5).rounded_full().bg(t[ag.status] || t.dim),
                          `${ag.address} · ${ag.space_name || ag.program?.name || "Agent"}`,
                        ]);
                    })
                  : [
                      div()
                        .text_size(10.5)
                        .text_color(t.dim)
                        .child(this.targetAddr ? this.targetAddr : "仅复制（无聚焦终端）"),
                    ]),
              ]),
          ])
      )
      // Snippet cards list
      .child(
        div()
          .id("prompts-scroll")
          .flex_1()
          .min_h(0)
          .w_full()
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .w_full()
              .p(12)
              .gap(8)
              .when(list.length === 0, (el) =>
                el.child(
                  v_flex()
                    .py(36)
                    .items_center()
                    .gap(6)
                    .children([
                      div().text_size(13).text_color(t.muted).child(this.loading ? "加载中…" : "没有匹配的指令模板"),
                      div().text_size(11.5).text_color(t.dim).child("点右上角「新建」添加你的专属高频 Prompt"),
                    ])
                )
              )
              .children(
                list.map((item, idx) => {
                  const active = idx === sel;
                  const copied = this.copiedId === item.id;
                  const confirming = this.confirmDel?.id === item.id;
                  const stop = (_e, cx) => cx.stop_propagation();
                  return v_flex()
                    .id(`pitem-${item.id}`)
                    .flex_none()
                    .p(11)
                    .gap(6)
                    .rounded(9)
                    .bg(active ? t.selected : t.surface)
                    .border_1()
                    .border_color(active ? t.accent : t.border)
                    .cursor_pointer()
                    .hover((s) => (active ? s : s.bg(t.hover)))
                    .on_click((_e, cx) => {
                      this.selectedIdx = idx;
                      cx.notify();
                    })
                    .child(
                      h_flex()
                        .gap(7)
                        .items_center()
                        .children([
                          div()
                            .id(`ppin-${item.id}`)
                            .size(20)
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .rounded(4)
                            .cursor_pointer()
                            .text_color(item.pinned ? t.accent : t.dim)
                            .hover((s) => s.bg(t.hover))
                            .on_mouse_down("left", stop)
                            .on_click((_e, cx) => { cx.stop_propagation(); this.togglePin(item, cx); })
                            .child(svg(ICON(item.pinned ? "star-filled" : "star")).size(12)),
                          div().flex_1().min_w(0).truncate().font_semibold().text_size(13).text_color(t.foreground).child(item.title),
                          div()
                            .px(6)
                            .h(18)
                            .flex()
                            .flex_none()
                            .items_center()
                            .rounded(4)
                            .bg(t.raised)
                            .text_size(10)
                            .text_color(t.muted)
                            .child(item.category || "其他"),
                          div()
                            .id(`pedit-${item.id}`)
                            .size(22)
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .rounded(5)
                            .cursor_pointer()
                            .text_color(t.dim)
                            .hover((s) => s.bg(t.hover).text_color(t.foreground))
                            .tooltip("编辑")
                            .on_mouse_down("left", stop)
                            .on_click((_e, cx) => { cx.stop_propagation(); this.openEditor(item, cx); })
                            .child(svg(ICON("edit")).size(12)),
                          confirming
                            ? div()
                                .id(`pdel-c-${item.id}`)
                                .h(22)
                                .px(7)
                                .flex()
                                .flex_none()
                                .items_center()
                                .rounded(5)
                                .bg(t.blocked)
                                .text_color("#ffffff")
                                .text_size(10.5)
                                .cursor_pointer()
                                .on_mouse_down("left", stop)
                                .on_click((_e, cx) => { cx.stop_propagation(); this.removeItem(item, cx); })
                                .child("确认")
                            : div()
                                .id(`pdel-${item.id}`)
                                .size(22)
                                .flex()
                                .flex_none()
                                .items_center()
                                .justify_center()
                                .rounded(5)
                                .cursor_pointer()
                                .text_color(t.dim)
                                .hover((s) => s.bg(t.hover).text_color(t.blocked))
                                .tooltip("删除")
                                .on_mouse_down("left", stop)
                                .on_click((_e, cx) => {
                                  cx.stop_propagation();
                                  this.confirmDel = { id: item.id, until: Date.now() + 4000 };
                                  cx.notify();
                                })
                                .child(svg(ICON("trash")).size(12)),
                        ])
                    )
                    .child(
                      div()
                        .pl(27)
                        .text_size(11.5)
                        .text_color(t.muted)
                        .whitespace_normal()
                        .child(item.content.length > 180 ? item.content.slice(0, 179) + "…" : item.content)
                    )
                    .child(
                      h_flex()
                        .pl(27)
                        .pt(2)
                        .gap(6)
                        .justify_end()
                        .children([
                          h_flex()
                            .id(`pcopy-${item.id}`)
                            .h(24)
                            .px(9)
                            .gap(4)
                            .items_center()
                            .rounded(6)
                            .border_1()
                            .border_color(t.border)
                            .bg(t.background)
                            .text_size(11)
                            .text_color(copied ? t.done : t.muted)
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover).text_color(copied ? t.done : t.foreground))
                            .on_mouse_down("left", stop)
                            .on_click((_e, cx) => { cx.stop_propagation(); this.copyItem(item, cx); })
                            .children([svg(ICON(copied ? "check" : "copy")).size(11.5), copied ? "已复制" : "复制"]),
                          h_flex()
                            .id(`psend-${item.id}`)
                            .h(24)
                            .px(10)
                            .gap(4)
                            .items_center()
                            .rounded(6)
                            .bg(t.solid)
                            .text_color(t.solid_foreground)
                            .text_size(11)
                            .font_medium()
                            .cursor_pointer()
                            .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
                            .on_mouse_down("left", stop)
                            .on_click((_e, cx) => { cx.stop_propagation(); this.sendItem(item, cx); })
                            .children([
                              svg(ICON("send")).size(11),
                              this.sendingId === item.id ? "发送中…" : this.targetAddr ? "发送给 Agent" : "复制使用",
                            ]),
                        ])
                    );
                })
              )
          )
      )
      // Footer hint
      .child(
        h_flex()
          .flex_none()
          .px(16)
          .py(8)
          .items_center()
          .justify_between()
          .border_t_1()
          .border_color(t.border)
          .text_size(11)
          .text_color(t.dim)
          .children([
            div().child("~/.config/herdr-app/prompts.json"),
            div().child("↑↓ 选择 · ↵ 发送 · Esc 关闭"),
          ])
      );
  }
}
