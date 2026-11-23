// Actions — 工作区快捷动作面板。
// 持久化到 ~/.config/herdr-app/actions.json，支持全局/项目级动作、新标签/右侧分屏/当前终端三种执行方式、
// 实时搜索过滤、二次确认删除，以及自动探测当前项目的 package.json / Makefile / justfile 脚本。

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import {
  appHome,
  checking,
  exec,
  focused,
  hc,
  notify,
  panes,
  readTextFile,
  run,
  settings,
  shared,
  setShared,
  spaces,
  theme,
  writeTextFile,
} from "herdr";

const STORE = "actions.items";
const FILE = () => `${appHome()}/actions.json`;
const ICON = (name) => `mods/actions/icons/${name}.svg`;

const MODES = [
  { id: "tab", label: "新标签", badge: "标签", hint: "在当前目录开新标签运行" },
  { id: "split", label: "右侧分屏", badge: "分屏", hint: "在当前窗格右侧分屏运行" },
  { id: "send", label: "当前终端", badge: "终端", hint: "发送到当前聚焦终端并回车（有 Agent 时注意）" },
];

const SCOPE_FILTERS = [
  { id: "all", label: "全部" },
  { id: "here", label: "本目录" },
  { id: "global", label: "全局" },
];

function uid() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function tilde(p) {
  return p ? String(p).replace(/^\/Users\/[^/]+/, "~") : "";
}

function baseName(p) {
  return p ? String(p).replace(/\/+$/, "").split("/").pop() || p : "";
}

function loadShared() {
  const value = shared(STORE);
  return Array.isArray(value) ? value : null;
}

function activeLocation() {
  const space = spaces().find((s) => s.active);
  if (!space) return { cwd: null, machine: null };
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  const f = focused();
  const mine = panes().filter((p) => tabs.has(p.tab));
  const fp = mine.find((p) => p.focused) || mine.find((p) => p.cwd);
  const cwd =
    fp?.cwd ||
    (f?.pane && mine.some((p) => p.pane === f.pane) ? f.cwd : null) ||
    space.folder ||
    null;
  return { cwd, machine: space.machine || null };
}

function sameDirOrChild(cwd, bound) {
  if (!cwd || !bound) return false;
  const a = cwd.replace(/\/+$/, "");
  const b = bound.replace(/\/+$/, "");
  return a === b || a.startsWith(b + "/");
}

function sortItems(items, cwd) {
  return [...items].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const aLocal = a.cwd && sameDirOrChild(cwd, a.cwd) ? 1 : 0;
    const bLocal = b.cwd && sameDirOrChild(cwd, b.cwd) ? 1 : 0;
    if (aLocal !== bLocal) return bLocal - aLocal;
    return (b.at || 0) - (a.at || 0);
  });
}

function parseMakeTargets(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*):(?!=)/);
    if (!m) continue;
    const name = m[1];
    if (name.startsWith(".") || seen.has(name)) continue;
    seen.add(name);
    out.push({ title: name, command: `make ${name}`, source: "Makefile" });
    if (out.length >= 12) break;
  }
  return out;
}

function parseJustTargets(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || "").split("\n")) {
    if (/^\s|#|^alias\s|^set\s|^export\s/.test(line)) continue;
    const m = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)[^:=]*:/);
    if (!m) continue;
    const name = m[1];
    if (name.startsWith("_") || seen.has(name)) continue;
    seen.add(name);
    out.push({ title: name, command: `just ${name}`, source: "justfile" });
    if (out.length >= 12) break;
  }
  return out;
}

export default class Actions extends View {
  init(_props, cx) {
    this.items = loadShared() ?? [];
    this.draft = null;
    this.titleInput = null;
    this.cmdInput = null;
    this.focusedField = null;
    this.error = null;
    this.saving = false;
    this.confirmDel = null; // { id, until }
    this.scopeFilter = "all";
    this.query = "";
    this.searchFocused = false;
    this.scripts = [];
    this.scriptsFor = null;
    this.scriptsCollapsed = false;
    this.handle = cx.focus_handle();

    this.searchInput = InputState.new({ placeholder: "搜索动作名称、命令…" });
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
    cx.spawn(async (cx) => {
      await this.reload();
      cx.notify();
    });
    this.syncScripts(cx);
    cx.timer.every(5000, (cx) => {
      if (this.confirmDel && Date.now() > this.confirmDel.until) {
        this.confirmDel = null;
        cx.notify();
      }
      this.syncScripts(cx);
    });
  }

  syncScripts(cx) {
    const { cwd, machine } = activeLocation();
    const key = `${machine || "local"}\0${cwd || ""}`;
    if (key === this.scriptsFor) return;
    this.scriptsFor = key;
    this.scripts = [];
    if (!cwd) return;
    cx.spawn(async (cx) => {
      const opts = machine ? { on: machine } : {};
      const detected = [];
      // 1. package.json
      const pkgRaw = await readTextFile(`${cwd}/package.json`, opts).catch(() => null);
      if (pkgRaw) {
        try {
          const pkg = JSON.parse(pkgRaw);
          const scripts = pkg?.scripts;
          if (scripts && typeof scripts === "object") {
            const [hasPnpm, hasBun, hasYarn] = await Promise.all([
              readTextFile(`${cwd}/pnpm-lock.yaml`, opts).then((v) => v != null).catch(() => false),
              readTextFile(`${cwd}/bun.lock`, opts).then((v) => v != null).catch(() => false),
              readTextFile(`${cwd}/yarn.lock`, opts).then((v) => v != null).catch(() => false),
            ]);
            const runner = hasPnpm ? "pnpm run" : hasBun ? "bun run" : hasYarn ? "yarn" : "npm run";
            const keys = Object.keys(scripts);
            // Put dev/start/build/test/lint first
            const prio = ["dev", "start", "build", "test", "lint", "typecheck", "check"];
            keys.sort((a, b) => {
              const ia = prio.indexOf(a);
              const ib = prio.indexOf(b);
              if (ia >= 0 && ib >= 0) return ia - ib;
              if (ia >= 0) return -1;
              if (ib >= 0) return 1;
              return a.localeCompare(b);
            });
            for (const name of keys.slice(0, 12)) {
              detected.push({
                title: name,
                command: `${runner} ${name}`,
                raw: String(scripts[name] || ""),
                source: "package.json",
              });
            }
          }
        } catch {}
      }
      // 2. justfile / Makefile if no package.json scripts
      if (!detected.length) {
        const justRaw = await readTextFile(`${cwd}/justfile`, opts).catch(() => null);
        if (justRaw) detected.push(...parseJustTargets(justRaw));
      }
      if (!detected.length) {
        const makeRaw = await readTextFile(`${cwd}/Makefile`, opts).catch(() => null);
        if (makeRaw) detected.push(...parseMakeTargets(makeRaw));
      }
      if (this.scriptsFor === key) {
        this.scripts = detected;
        cx.notify();
      }
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

  beginAdd(cx, preset = null) {
    const { cwd } = activeLocation();
    this.draft = {
      title: preset?.title || "",
      command: preset?.command || "",
      mode: preset?.mode || "tab",
      scoped: Boolean(preset?.scoped),
      cwd: preset?.cwd || cwd || "",
    };
    this.bindDraftInputs(cx);
    cx.notify();
  }

  beginEdit(item, cx) {
    const { cwd } = activeLocation();
    this.draft = {
      id: item.id,
      title: item.title || "",
      command: item.command || "",
      mode: MODES.some((m) => m.id === item.mode) ? item.mode : "tab",
      scoped: Boolean(item.cwd),
      cwd: item.cwd || cwd || "",
    };
    this.bindDraftInputs(cx);
    cx.notify();
  }

  bindDraftInputs(cx) {
    this.titleInput = InputState.new({ value: this.draft.title, placeholder: "例如：启动开发服务、跑单测" });
    this.cmdInput = TextareaState.new({ value: this.draft.command, placeholder: "例如：pnpm dev 或 git status -s", rows: 3 });
    this.titleInput.on("focus", (_e, cx) => { this.focusedField = "title"; cx.notify(); });
    this.titleInput.on("blur", (_e, cx) => { if (this.focusedField === "title") { this.focusedField = null; cx.notify(); } });
    this.cmdInput.on("focus", (_e, cx) => { this.focusedField = "cmd"; cx.notify(); });
    this.cmdInput.on("blur", (_e, cx) => { if (this.focusedField === "cmd") { this.focusedField = null; cx.notify(); } });
    this.titleInput.on("change", (_e, cx) => {
      if (this.draft) this.draft.title = this.titleInput.value();
      cx.notify();
    });
    this.cmdInput.on("change", (_e, cx) => {
      if (this.draft) this.draft.command = this.cmdInput.value();
      cx.notify();
    });
    cx.timer.after(40, () => this.titleInput?.focus());
  }

  cancelDraft(cx) {
    this.draft = null;
    this.titleInput = null;
    this.cmdInput = null;
    this.focusedField = null;
    cx.notify();
  }

  async saveDraft(cx) {
    if (this.saving || !this.draft) return;
    const title = (this.draft.title || "").trim();
    const command = (this.draft.command || "").trim();
    if (!title || !command) {
      notify({ title: "动作", body: "名称和命令都要填写", level: "error", timeout: 2400 });
      return;
    }
    this.saving = true;
    cx.notify();
    try {
      const mode = MODES.some((m) => m.id === this.draft.mode) ? this.draft.mode : "tab";
      const boundCwd = this.draft.scoped && this.draft.cwd ? this.draft.cwd : null;
      let next;
      if (this.draft.id) {
        next = this.items.map((it) => {
          if (it.id !== this.draft.id) return it;
          const updated = { ...it, title, command, mode, at: Date.now() };
          if (boundCwd) updated.cwd = boundCwd;
          else delete updated.cwd;
          return updated;
        });
      } else {
        const rec = { id: uid(), title, command, mode, pinned: false, at: Date.now() };
        if (boundCwd) rec.cwd = boundCwd;
        next = [rec, ...this.items];
      }
      await this.persist(next);
      this.cancelDraft(cx);
      notify({ title: "动作", body: `已保存「${title}」`, level: "success", timeout: 1800 });
    } catch (e) {
      notify({ title: "动作", body: String(e), level: "error", timeout: 4000 });
    } finally {
      this.saving = false;
      cx.notify();
    }
  }

  async remove(item, cx) {
    try {
      this.confirmDel = null;
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

  copyCommand(cmd, label, cx) {
    cx.write_to_clipboard(cmd);
    notify({ title: "已复制命令", body: label || cmd, level: "success", timeout: 1800 });
  }

  async runCommand(title, command, mode = "tab", explicitCwd = null, itemId = null) {
    const cmd = (command || "").trim();
    if (!cmd) return;
    const { cwd: activeCwd } = activeLocation();
    const cwd = explicitCwd || activeCwd;
    try {
      if (mode === "send") {
        const term = focused()?.terminal;
        if (!term) {
          notify({ title: "动作", body: "没有聚焦的终端，已改用新标签执行", level: "info", timeout: 2400 });
          run("tab.new", {
            name: title,
            ...(cwd ? { folder: cwd } : {}),
            argv: ["sh", "-lc", cmd],
          });
        } else {
          const r = await hc(["send", term, cmd]);
          if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || `exit ${r.code}`);
        }
      } else if (mode === "split") {
        const hasPane = Boolean(focused()?.pane);
        if (hasPane) {
          run("pane.split", { direction: "right", argv: ["sh", "-lc", cmd] });
        } else {
          run("tab.new", {
            name: title,
            ...(cwd ? { folder: cwd } : {}),
            argv: ["sh", "-lc", cmd],
          });
        }
      } else {
        run("tab.new", {
          name: title,
          ...(cwd ? { folder: cwd } : {}),
          argv: ["sh", "-lc", cmd],
        });
      }
      if (itemId) {
        const next = this.items.map((it) => (it.id === itemId ? { ...it, at: Date.now() } : it));
        await this.persist(next);
      }
    } catch (e) {
      notify({ title: "动作", body: String(e), level: "error", timeout: 4000 });
    }
  }

  saveDetectedScript(sc, cx) {
    const { cwd } = activeLocation();
    cx.spawn(async (cx) => {
      const rec = {
        id: uid(),
        title: `${baseName(cwd)} · ${sc.title}`,
        command: sc.command,
        mode: "tab",
        pinned: false,
        at: Date.now(),
        ...(cwd ? { cwd } : {}),
      };
      await this.persist([rec, ...this.items]);
      notify({ title: "已收藏动作", body: sc.command, level: "success", timeout: 2000 });
      cx.notify();
    });
  }

  // ---- UI pieces ----------------------------------------------------------

  iconBtn(id, name, tip, onClick, t, opts = {}) {
    const accent = Boolean(opts.accent);
    const danger = Boolean(opts.danger);
    return div()
      .id(id)
      .size(24)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .cursor_pointer()
      .text_color(danger ? t.blocked : accent ? t.accent : t.dim)
      .hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : accent ? t.accent : t.foreground))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(svg(ICON(name)).size(13));
  }

  draftForm(t) {
    const d = this.draft;
    const { cwd } = activeLocation();
    const activeMode = MODES.find((m) => m.id === d.mode) || MODES[0];

    return v_flex()
      .id("action-draft-form")
      .flex_none()
      .m(10)
      .p(12)
      .gap(10)
      .rounded(10)
      .border_1()
      .border_color(t.accent)
      .bg(t.surface)
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") {
          this.saveDraft(cx);
        } else if (e.key === "escape") {
          this.cancelDraft(cx);
        }
      })
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .children([
            div().text_size(12.5).font_semibold().text_color(t.foreground).child(d.id ? "编辑动作" : "新建动作"),
            this.iconBtn("act-close-x", "x", "取消", (cx) => this.cancelDraft(cx), t),
          ])
      )
      .child(
        v_flex()
          .gap(4)
          .child(div().text_size(11).font_medium().text_color(t.muted).child("名称"))
          .child(
            h_flex()
              .h(30)
              .px(9)
              .items_center()
              .rounded(7)
              .bg(t.background)
              .border_1()
              .border_color(this.focusedField === "title" ? t.accent : t.input)
              .child(Input.new(this.titleInput).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
          )
      )
      .child(
        v_flex()
          .gap(4)
          .child(div().text_size(11).font_medium().text_color(t.muted).child("命令"))
          .child(
            Textarea.new(this.cmdInput)
              .h(64)
              .px(9)
              .py(6)
              .rounded(7)
              .bg(t.background)
              .border_1()
              .border_color(this.focusedField === "cmd" ? t.accent : t.input)
              .text_size(12)
              .text_color(t.foreground)
          )
      )
      .child(
        v_flex()
          .gap(5)
          .child(div().text_size(11).font_medium().text_color(t.muted).child("执行方式"))
          .child(
            h_flex()
              .p(2)
              .gap(2)
              .rounded(7)
              .bg(t.raised)
              .children(
                MODES.map((m) => {
                  const on = d.mode === m.id;
                  return div()
                    .id(`mode-${m.id}`)
                    .flex_1()
                    .h(24)
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(5)
                    .cursor_pointer()
                    .text_size(11)
                    .when(on, (el) => el.bg(t.surface).text_color(t.foreground).font_medium())
                    .when(!on, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
                    .on_click((_e, cx) => {
                      this.draft.mode = m.id;
                      cx.notify();
                    })
                    .child(m.label);
                })
              )
          )
          .child(div().text_size(10.5).text_color(t.dim).child(activeMode.hint))
      )
      .when(Boolean(cwd), (el) =>
        el.child(
          h_flex()
            .id("act-scope-toggle")
            .gap(7)
            .items_center()
            .cursor_pointer()
            .on_click((_e, cx) => {
              this.draft.scoped = !this.draft.scoped;
              if (this.draft.scoped && !this.draft.cwd) this.draft.cwd = cwd;
              cx.notify();
            })
            .children([
              h_flex()
                .w(14)
                .h(14)
                .rounded(4)
                .border_1()
                .border_color(d.scoped ? t.accent : t.input)
                .bg(d.scoped ? t.accent : t.background)
                .items_center()
                .justify_center()
                .text_size(9.5)
                .text_color(t.accent_foreground)
                .child(d.scoped ? "✓" : ""),
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11.5)
                .text_color(t.muted)
                .child(`绑定到当前目录（${baseName(d.cwd || cwd)}）`),
            ])
        )
      )
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .pt(2)
          .children([
            div().text_size(10.5).text_color(t.dim).child("⌘Enter 保存"),
            h_flex()
              .gap(6)
              .children([
                div()
                  .id("act-cancel")
                  .h(26)
                  .px(10)
                  .flex()
                  .items_center()
                  .rounded(6)
                  .cursor_pointer()
                  .text_size(11.5)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.cancelDraft(cx))
                  .child("取消"),
                div()
                  .id("act-save")
                  .h(26)
                  .px(12)
                  .flex()
                  .items_center()
                  .rounded(6)
                  .cursor_pointer()
                  .text_size(11.5)
                  .font_medium()
                  .bg(t.solid)
                  .text_color(t.solid_foreground)
                  .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
                  .on_click((_e, cx) => this.saveDraft(cx))
                  .child(this.saving ? "保存中…" : "保存"),
              ]),
          ])
      );
  }

  actionCard(item, t) {
    const mono = settings().font_family || "JetBrains Mono";
    const modeInfo = MODES.find((m) => m.id === item.mode) || MODES[0];
    const confirming = this.confirmDel?.id === item.id;

    return v_flex()
      .id(`action-${item.id}`)
      .flex_none()
      .p(10)
      .gap(7)
      .rounded(9)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(
        h_flex()
          .gap(7)
          .items_center()
          .children([
            this.iconBtn(
              `pin-${item.id}`,
              item.pinned ? "star-filled" : "star",
              item.pinned ? "取消置顶" : "置顶动作",
              (cx) => this.togglePin(item, cx),
              t,
              { accent: item.pinned }
            ),
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .font_medium()
              .text_size(12.5)
              .text_color(t.foreground)
              .child(item.title),
            ...(item.cwd
              ? [
                  div()
                    .px(5)
                    .h(17)
                    .flex()
                    .flex_none()
                    .items_center()
                    .rounded(4)
                    .bg(t.raised)
                    .text_size(10)
                    .text_color(t.muted)
                    .tooltip(`绑定目录：${tilde(item.cwd)}`)
                    .child(baseName(item.cwd)),
                ]
              : []),
            div()
              .px(5)
              .h(17)
              .flex()
              .flex_none()
              .items_center()
              .rounded(4)
              .bg(t.raised)
              .text_size(10)
              .text_color(t.dim)
              .child(modeInfo.badge),
          ])
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .children([
            div()
              .flex_1()
              .min_w(0)
              .px(8)
              .py(4)
              .rounded(6)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .font_family(mono)
              .text_size(11)
              .text_color(t.muted)
              .truncate()
              .child(item.command),
            h_flex()
              .id(`run-${item.id}`)
              .h(24)
              .px(9)
              .gap(4)
              .flex_none()
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .text_size(11)
              .font_medium()
              .tooltip(`运行（${modeInfo.label}）`)
              .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
              .on_click(() => this.runCommand(item.title, item.command, item.mode, item.cwd, item.id))
              .children([svg(ICON("play")).size(10.5), "运行"]),
            this.iconBtn(`copy-${item.id}`, "copy", "复制命令", (cx) => this.copyCommand(item.command, item.title, cx), t),
            this.iconBtn(`edit-${item.id}`, "edit", "编辑动作", (cx) => this.beginEdit(item, cx), t),
            confirming
              ? div()
                  .id(`del-cfm-${item.id}`)
                  .h(24)
                  .px(7)
                  .flex()
                  .flex_none()
                  .items_center()
                  .rounded(5)
                  .bg(t.blocked)
                  .text_color("#ffffff")
                  .text_size(10.5)
                  .font_medium()
                  .cursor_pointer()
                  .on_click((_e, cx) => this.remove(item, cx))
                  .child("确认")
              : this.iconBtn(
                  `del-${item.id}`,
                  "trash",
                  "删除动作",
                  (cx) => {
                    this.confirmDel = { id: item.id, until: Date.now() + 4000 };
                    cx.notify();
                  },
                  t
                ),
          ])
      );
  }

  projectScriptsSection(t, cwd) {
    const mono = settings().font_family || "JetBrains Mono";
    const list = this.scripts.filter((sc) => {
      if (!this.query) return true;
      return `${sc.title} ${sc.command} ${sc.raw || ""}`.toLowerCase().includes(this.query);
    });
    if (!list.length) return null;

    return v_flex()
      .flex_none()
      .pt(6)
      .gap(6)
      .child(
        h_flex()
          .id("scripts-hdr")
          .px(4)
          .items_center()
          .justify_between()
          .cursor_pointer()
          .on_click((_e, cx) => {
            this.scriptsCollapsed = !this.scriptsCollapsed;
            cx.notify();
          })
          .children([
            h_flex()
              .gap(5)
              .items_center()
              .children([
                svg(ICON("zap")).size(12).text_color(t.accent),
                div()
                  .text_size(11)
                  .font_medium()
                  .text_color(t.muted)
                  .child(`项目脚本 · ${list[0].source} (${list.length})`),
              ]),
            div()
              .text_size(10.5)
              .text_color(t.dim)
              .child(this.scriptsCollapsed ? "展开" : "收起"),
          ])
      )
      .when(!this.scriptsCollapsed, (el) =>
        el.child(
          v_flex()
            .flex_none()
            .gap(4)
            .children(
              list.map((sc, i) =>
                h_flex()
                  .id(`proj-sc-${i}`)
                  .flex_none()
                  .px(9)
                  .py(6)
                  .gap(7)
                  .items_center()
                  .rounded(8)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .hover((s) => s.bg(t.hover))
                  .children([
                    v_flex()
                      .flex_1()
                      .min_w(0)
                      .gap(1)
                      .children([
                        div().truncate().text_size(12).font_medium().text_color(t.foreground).child(sc.title),
                        div().truncate().font_family(mono).text_size(10.5).text_color(t.dim).child(sc.raw || sc.command),
                      ]),
                    this.iconBtn(
                      `sc-run-${i}`,
                      "play",
                      `运行：${sc.command}`,
                      () => this.runCommand(sc.title, sc.command, "tab", cwd, null),
                      t,
                      { accent: true }
                    ),
                    this.iconBtn(
                      `sc-save-${i}`,
                      "star",
                      "收藏到我的动作",
                      (cx) => this.saveDetectedScript(sc, cx),
                      t
                    ),
                  ])
              )
            )
        )
      );
  }

  render(cx) {
    this.syncScripts(cx);
    const t = theme();
    const { cwd } = activeLocation();

    const visible = sortItems(this.items, cwd).filter((it) => {
      if (this.scopeFilter === "here" && !(it.cwd && sameDirOrChild(cwd, it.cwd))) return false;
      if (this.scopeFilter === "global" && Boolean(it.cwd)) return false;
      if (this.query) {
        const hay = `${it.title || ""} ${it.command || ""} ${it.cwd || ""}`.toLowerCase();
        if (!hay.includes(this.query)) return false;
      }
      return true;
    });

    const scriptsBlock = this.projectScriptsSection(t, cwd);

    return v_flex()
      .id("actions")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      // Header
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .border_b_1()
          .border_color(t.border)
          .children([
            div().font_semibold().child("动作"),
            div()
              .px(5)
              .py(1)
              .rounded(4)
              .border_1()
              .border_color(t.border)
              .text_size(10)
              .text_color(t.muted)
              .child(`${this.items.length}`),
            div().flex_1(),
            h_flex()
              .id("action-add")
              .h(26)
              .px(9)
              .gap(4)
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .text_size(11.5)
              .font_medium()
              .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
              .on_click((_e, cx) => this.beginAdd(cx))
              .children([svg(ICON("plus")).size(12.5), "新建"]),
          ])
      )
      // Active workspace bar
      .child(
        h_flex()
          .flex_none()
          .px(12)
          .py(6)
          .gap(6)
          .items_center()
          .border_b_1()
          .border_color(t.border)
          .bg(t.chrome)
          .children([
            svg(ICON("folder")).size(12).flex_none().text_color(t.dim),
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11)
              .text_color(t.dim)
              .child(cwd ? tilde(cwd) : "无当前目录（将在主目录执行）"),
          ])
      )
      // Search & scope filter
      .child(
        v_flex()
          .flex_none()
          .px(10)
          .pt(9)
          .pb(8)
          .gap(7)
          .border_b_1()
          .border_color(t.border)
          .child(
            h_flex()
              .id("actions-search")
              .h(28)
              .px(8)
              .gap(6)
              .items_center()
              .rounded(7)
              .bg(t.surface)
              .border_1()
              .border_color(this.searchFocused ? t.accent : t.border)
              .children([
                svg(ICON("search")).size(12).flex_none().text_color(this.searchFocused ? t.accent : t.dim),
                Input.new(this.searchInput).flex_1().min_w(0).h_full().text_size(11.5).text_color(t.foreground),
                ...(this.query
                  ? [
                      div()
                        .id("actions-search-clear")
                        .size(16)
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
                          cx.notify();
                        })
                        .child(svg(ICON("x")).size(10.5)),
                    ]
                  : []),
              ])
          )
          .child(
            h_flex()
              .gap(4)
              .children(
                SCOPE_FILTERS.map((f) => {
                  const on = this.scopeFilter === f.id;
                  return div()
                    .id(`ascope-${f.id}`)
                    .h(22)
                    .px(8)
                    .flex()
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .text_size(11)
                    .when(on, (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
                    .when(!on, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
                    .on_click((_e, cx) => {
                      this.scopeFilter = f.id;
                      cx.notify();
                    })
                    .child(f.label);
                })
              )
          )
      )
      // Inline draft form
      .when(Boolean(this.draft), (el) => el.child(this.draftForm(t)))
      // Error banner
      .when(Boolean(this.error), (el) =>
        el.child(div().flex_none().px(12).py(7).text_size(11.5).text_color(t.blocked).child(this.error))
      )
      // Scrollable body
      .child(
        div()
          .id("actions-scroll")
          .flex_1()
          .min_h(0)
          .w_full()
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .w_full()
              .p(10)
              .gap(8)
              .when(visible.length > 0, (el) => el.children(visible.map((it) => this.actionCard(it, t))))
              .when(visible.length === 0 && !this.draft, (el) =>
                el.child(
                  v_flex()
                    .flex_none()
                    .py(18)
                    .px(10)
                    .items_center()
                    .gap(6)
                    .rounded(9)
                    .bg(t.surface)
                    .border_1()
                    .border_color(t.border)
                    .children([
                      div()
                        .text_size(12.5)
                        .font_medium()
                        .text_color(t.muted)
                        .child(this.query || this.scopeFilter !== "all" ? "没有匹配的保存动作" : "还没有保存的动作"),
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child("点右上角「新建」保存常用命令，或直接运行下方项目脚本"),
                    ])
                )
              )
              .when(Boolean(scriptsBlock), (el) => el.child(scriptsBlock))
          )
      );
  }
}
