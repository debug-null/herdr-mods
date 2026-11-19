// Saved shell actions for the current workspace: persisted to
// ~/.config/herdr-app/actions.json (and mirrored in shared) so they survive
// restarts and sync. Click runs in a new tab at the active space's cwd, or
// pastes into the focused terminal when mode is "send".

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  spaces, panes, focused, theme, run, notify, shared, setShared,
  appHome, readTextFile, writeTextFile, hc, checking,
} from "herdr";

const STORE = "actions.items";
const FILE = () => `${appHome()}/actions.json`;

function uid() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function loadShared() {
  const value = shared(STORE);
  return Array.isArray(value) ? value : null;
}

function cwdOfActive() {
  const space = spaces().find((s) => s.active);
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return (b.at || 0) - (a.at || 0);
  });
}

export default class Actions extends View {
  init(_props, cx) {
    this.items = loadShared() ?? [];
    this.draft = null; // { id?, title, command, mode } while adding/editing
    this.titleInput = null;
    this.cmdInput = null;
    this.error = null;
    this.saving = false;
    if (checking()) return;
    cx.spawn(async (cx) => {
      await this.reload();
      cx.notify();
    });
  }

  async reload() {
    try {
      const raw = await readTextFile(FILE());
      if (raw == null) {
        if (this.items.length) await this.persist(this.items);
        return;
      }
      const data = JSON.parse(raw);
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      this.items = items;
      setShared(STORE, items);
    } catch (e) {
      this.error = String(e);
    }
  }

  async persist(items) {
    this.items = items;
    setShared(STORE, items);
    const path = FILE();
    const prev = await readTextFile(path).catch(() => null);
    const body = `${JSON.stringify({ version: 1, items }, null, 2)}\n`;
    await writeTextFile(path, body, prev);
  }

  beginAdd(cx) {
    this.draft = { title: "", command: "", mode: "tab" };
    this.bindDraftInputs(cx);
    cx.notify();
  }

  beginEdit(item, cx) {
    this.draft = {
      id: item.id,
      title: item.title || "",
      command: item.command || "",
      mode: item.mode === "send" ? "send" : "tab",
    };
    this.bindDraftInputs(cx);
    cx.notify();
  }

  bindDraftInputs(cx) {
    this.titleInput = InputState.new({ value: this.draft.title });
    this.cmdInput = InputState.new({ value: this.draft.command });
    this.titleInput.on("change", (_e, cx) => {
      this.draft.title = this.titleInput.value();
      cx.notify();
    });
    this.cmdInput.on("change", (_e, cx) => {
      this.draft.command = this.cmdInput.value();
      cx.notify();
    });
    cx.timer.after(50, () => this.titleInput.focus());
  }

  cancelDraft(cx) {
    this.draft = null;
    this.titleInput = null;
    this.cmdInput = null;
    cx.notify();
  }

  async saveDraft(cx) {
    if (this.saving || !this.draft) return;
    const title = (this.draft.title || "").trim();
    const command = (this.draft.command || "").trim();
    if (!title || !command) {
      notify({ title: "动作", body: "名称和命令都要填", level: "error", timeout: 2500 });
      return;
    }
    this.saving = true;
    cx.notify();
    try {
      const mode = this.draft.mode === "send" ? "send" : "tab";
      let next;
      if (this.draft.id) {
        next = this.items.map((it) => (
          it.id === this.draft.id
            ? { ...it, title, command, mode, at: Date.now() }
            : it
        ));
      } else {
        next = [
          { id: uid(), title, command, mode, pinned: false, at: Date.now() },
          ...this.items,
        ];
      }
      await this.persist(next);
      this.cancelDraft(cx);
      notify({ title: "动作", body: "已保存到 actions.json", level: "success", timeout: 2000 });
    } catch (e) {
      notify({ title: "动作", body: String(e), level: "error", timeout: 4000 });
    } finally {
      this.saving = false;
      cx.notify();
    }
  }

  async remove(item, cx) {
    try {
      await this.persist(this.items.filter((it) => it.id !== item.id));
      if (this.draft?.id === item.id) this.cancelDraft(cx);
      cx.notify();
    } catch (e) {
      notify({ title: "动作", body: String(e), level: "error", timeout: 4000 });
    }
  }

  async togglePin(item, cx) {
    try {
      await this.persist(this.items.map((it) => (
        it.id === item.id ? { ...it, pinned: !it.pinned, at: Date.now() } : it
      )));
      cx.notify();
    } catch (e) {
      notify({ title: "动作", body: String(e), level: "error", timeout: 4000 });
    }
  }

  async runItem(item) {
    const command = (item.command || "").trim();
    if (!command) return;
    const cwd = cwdOfActive();
    const mode = item.mode === "send" ? "send" : "tab";
    try {
      if (mode === "send") {
        const term = focused()?.terminal;
        if (!term) {
          notify({ title: "动作", body: "没有聚焦的终端，改用新标签执行", level: "info", timeout: 2500 });
          run("tab.new", {
            name: item.title,
            ...(cwd ? { folder: cwd } : {}),
            argv: ["sh", "-lc", command],
          });
          return;
        }
        const r = await hc(["send", term, command]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || `exit ${r.code}`);
      } else {
        run("tab.new", {
          name: item.title,
          ...(cwd ? { folder: cwd } : {}),
          argv: ["sh", "-lc", command],
        });
      }
      // Touch for recency among unpinned.
      const next = this.items.map((it) => (it.id === item.id ? { ...it, at: Date.now() } : it));
      await this.persist(next);
    } catch (e) {
      notify({ title: "动作", body: String(e), level: "error", timeout: 4000 });
    }
  }

  draftForm(t) {
    const d = this.draft;
    const field = (label, input, focused) => v_flex().gap(5).flex_none()
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(Input.new(input).h(label === "命令" ? 72 : 34).px(10).py(label === "命令" ? 8 : 0)
        .rounded(8).border_1().border_color(t.border).bg(t.background)
        .text_size(12.5).text_color(t.foreground)
        .when(label === "命令", (el) => el.flex_none()));
    const modeChip = (id, label, on) => h_flex().id(id).h(26).px(9).items_center().rounded(6).cursor_pointer()
      .text_size(11.5).bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.draft.mode = id === "mode-send" ? "send" : "tab"; cx.notify(); })
      .child(label);
    return v_flex().flex_none().mx(10).mb(10).p(10).gap(10).rounded(10).border_1().border_color(t.border).bg(t.raised)
      .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(d.id ? "编辑动作" : "新建动作"))
      .child(field("名称", this.titleInput))
      .child(field("命令", this.cmdInput))
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(11).text_color(t.dim).child("执行"))
        .child(modeChip("mode-tab", "新标签", d.mode !== "send"))
        .child(modeChip("mode-send", "当前终端", d.mode === "send")))
      .child(div().text_size(11).text_color(t.dim).child(
        d.mode === "send"
          ? "粘贴到聚焦终端并回车（有 agent 时请小心）"
          : "在当前 space 目录开新标签执行，保存到 ~/.config/herdr-app/actions.json",
      ))
      .child(h_flex().gap(8).justify_end()
        .child(h_flex().id("act-cancel").h(28).px(12).items_center().rounded(7).cursor_pointer()
          .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.cancelDraft(cx)).child("取消"))
        .child(h_flex().id("act-save").h(28).px(12).items_center().rounded(7).cursor_pointer()
          .text_size(12).bg(t.solid).text_color(t.solid_foreground)
          .hover((s) => s.opacity(0.9))
          .on_click((_e, cx) => this.saveDraft(cx))
          .child(this.saving ? "保存中…" : "保存")));
  }

  row(item, t) {
    return v_flex().id(`action-${item.id}`).flex_none().mx(8).mb(6).p(10).gap(6).rounded(10)
      .border_1().border_color(t.border).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(div().id(`pin-${item.id}`).size(22).flex_none().flex().items_center().justify_center().rounded(5)
          .cursor_pointer().text_color(item.pinned ? t.accent : t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(item.pinned ? "取消置顶" : "置顶（仍会保存）")
          .on_click((_e, cx) => this.togglePin(item, cx))
          .child(item.pinned ? "★" : "☆"))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(13).text_color(t.foreground).child(item.title))
          .child(div().truncate().text_size(11).text_color(t.dim).child(item.command)))
        .child(div().flex_none().px(5).h(18).flex().items_center().rounded(4).text_size(10)
          .bg(t.raised).text_color(t.dim).child(item.mode === "send" ? "终端" : "标签")))
      .child(h_flex().gap(6).justify_end()
        .child(h_flex().id(`run-${item.id}`).h(26).px(10).items_center().rounded(6).cursor_pointer()
          .text_size(11.5).bg(t.solid).text_color(t.solid_foreground)
          .hover((s) => s.opacity(0.9))
          .on_click((_e, cx) => { cx.stop_propagation(); this.runItem(item); })
          .child("运行"))
        .child(h_flex().id(`edit-${item.id}`).h(26).px(9).items_center().rounded(6).cursor_pointer()
          .text_size(11.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.beginEdit(item, cx); })
          .child("编辑"))
        .child(h_flex().id(`del-${item.id}`).h(26).px(9).items_center().rounded(6).cursor_pointer()
          .text_size(11.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.blocked))
          .on_click((_e, cx) => { cx.stop_propagation(); this.remove(item, cx); })
          .child("删除")));
  }

  render() {
    const t = theme();
    const cwd = cwdOfActive();
    const items = sortItems(this.items);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(41).px(14).pt(14).pb(5).flex_none().items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("动作"))
        .child(h_flex().id("action-add").h(26).px(9).gap(4).items_center().rounded(6).cursor_pointer()
          .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.beginAdd(cx))
          .child("+").child("新建")))
      .child(div().px(14).pb(8).flex_none().text_size(11).text_color(t.dim)
        .child(cwd ? `工作区 · ${cwd}` : "工作区 · （无 cwd，将在默认目录执行）")
        .child(div().pt(2).child("保存位置 ~/.config/herdr-app/actions.json")))
      .when(Boolean(this.draft), (el) => el.child(this.draftForm(t)))
      .when(Boolean(this.error), (el) => el.child(div().px(14).pb(8).text_size(12).text_color(t.blocked).child(this.error)))
      .when(items.length === 0 && !this.draft, (el) => el.child(
        v_flex().flex_1().px(16).pt(24).gap(8)
          .child(div().text_size(13).text_color(t.foreground).child("还没有保存的动作"))
          .child(div().text_size(12).text_color(t.dim).child("新建后会写入 actions.json，重启仍在。例如：devin --resume tidy-mare")),
      ))
      .when(items.length > 0, (el) => el.child(
        v_flex().flex_1().min_h(0).overflow_y_scrollbar().mode("always")
          .children(items.map((item) => this.row(item, t))),
      ));
  }
}
