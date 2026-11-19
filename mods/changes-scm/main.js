import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, props, openOverlay, closeOverlay, notify } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

// VSCode file-icon mapping: extension -> svg (stroke="currentColor" tinted per kind).
const FILE_ICONS = [
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|tiff?)$/i, ["mods/changes-scm/image.svg", "ansi4"]],
  [/\.(tsx?|jsx?|mjs|cjs|vue|svelte|py|rs|go|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|sh|zsh|bash|sql|lua)$/i, ["mods/changes-scm/code.svg", "ansi4"]],
  [/\.(css|scss|sass|less|styl)$/i, ["mods/changes-scm/hash.svg", "ansi5"]],
  [/\.(json|ya?ml|toml|xml|ini|cfg|conf|lock)$/i, ["mods/changes-scm/braces.svg", "ansi3"]],
  [/\.(md|mdx|txt|rst|adoc)$/i, ["mods/workspace-chrome/file-text.svg", "ansi6"]],
];
const fileIcon = (path) => {
  for (const [re, icon] of FILE_ICONS) if (re.test(path)) return icon;
  return ["mods/files/file.svg", "muted"];
};

export default class Changes extends View {
  init(_props, cx) {
    // Confirm dialog: discard is destructive, so ask before restore/clean.
    const confirm = props()?.confirm;
    if (confirm) {
      this.confirm = confirm; this.handle = cx.focus_handle(); this.handle.focus();
      return;
    }
    // Floating diff-window copy: own state, own reload loop, no panel lists.
    const d = props()?.diff;
    if (d) {
      this.diff = d; this.rows = []; this.diffWidth = 0; this.handle = cx.focus_handle();
      const reload = async () => { try { this.setLines(await this.diffLines(d)); } catch { this.setLines(["无法预览此差异（文件过大或不可读）"]); } cx.notify(); };
      cx.spawn(reload);
      cx.timer.every(10000, () => cx.spawn(reload));
      return;
    }
    this.files = []; this.staged = []; this.rows = []; this.diffWidth = 0; this.message = "";
    this.sCollapsed = false; this.uCollapsed = false;
    this.handle = cx.focus_handle();
    this.input = TextareaState.new({ placeholder: "消息 (⌘Enter 提交)", rows: 1 });
    this.input.set_auto_grow(1, 5);
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.repo = null; this.branch = null; this.ahead = 0; this.behind = 0;
      this.files = []; this.staged = []; this.open = null;
      if (this.diffWin) { closeOverlay(this.diffWin); this.diffWin = null; }
      this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false;
      this.repoMenu = false; this.commitMenu = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) {
          this.root = null; this.repo = null; this.branch = null; this.files = []; this.staged = [];
          this.open = null; this.error = "不是 Git 仓库";
          if (this.diffWin) { closeOverlay(this.diffWin); this.diffWin = null; }
          return;
        }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        // Index vs HEAD feeds the staged group, worktree vs index the changes group.
        const numstat = async (args) => {
          const r = await git(args), map = {};
          if (r.code !== 0) throw new Error(r.stderr);
          for (const entry of r.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            map[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
          }
          return map;
        };
        const stagedStats = await numstat(["diff", "--cached", "--numstat", "-z", "--no-renames"]);
        const workStats = await numstat(["diff", "--numstat", "-z", "--no-renames"]);
        const staged = [], files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), x = xy[0], y = xy[1], path = entry.slice(3);
          if (x === "U" || y === "U" || xy === "AA" || xy === "DD") { files.push({ path, status: "U", fresh: false, conflict: true, add: 0, del: 0 }); continue; }
          if (xy === "??") { files.push({ path, status: "?", fresh: true, add: 0, del: 0 }); continue; }
          if (x !== " " && x !== "?") staged.push({ path, status: x, ...(stagedStats[path] ?? { add: 0, del: 0 }) });
          if (y !== " " && y !== "?") files.push({ path, status: y, fresh: false, ...(workStats[path] ?? { add: 0, del: 0 }) });
        }
        const br = await git(["branch", "--show-current"]);
        const ab = await git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.staged = staged; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.repo = root.split("/").pop();
        this.branch = br.code === 0 && br.stdout.trim() ? br.stdout.trim() : "(detached)";
        if (ab.code === 0) { const [l, r] = ab.stdout.trim().split(/\s+/); this.behind = +l || 0; this.ahead = +r || 0; }
        else { this.ahead = 0; this.behind = 0; }
        this.watch(root, cx);
        const inList = (id) => id && (id.startsWith("s:") ? staged : files).some((f) => f.path === id.slice(2));
        if (this.open && !inList(this.open)) {
          this.open = null;
          if (this.diffWin) { closeOverlay(this.diffWin); this.diffWin = null; }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Self-contained diff loader: everything it needs rides in `d` (overlay props).
  async diffLines(d) {
    if (d.fresh) {
      const text = await readTextFile(`${d.root}/${d.path}`, { on: d.on }).catch(() => null);
      if (text === null) return ["无法预览此文件（二进制、过大或不可读）"];
      if (text.includes("\0")) return ["二进制文件 · 无文本差异"];
      const n = countLines(text); d.add = n;
      return [`@@ -0,0 +1,${n} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map((l) => `+${l.length > 4000 ? `${l.slice(0, 4000)}…` : l}`)];
    }
    // Staged rows show index vs HEAD; change rows show worktree vs index.
    const r = await exec("git", [...READ, "diff", ...(d.staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", d.path], { cwd: d.root, on: d.on });
    if (r.code !== 0) throw new Error(r.stderr);
    const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
    if (first < 0) return [d.binary ? "二进制文件已更改" : "无可用文本差异"];
    // Cap rows/line length so a huge diff cannot freeze the floating window.
    return all.slice(first, first + 1500).map((line) => line.length > 4000 ? `${line.slice(0, 4000)}… (line truncated)` : line);
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(path, staged, cx) {
    const id = `${staged ? "s" : "u"}:${path}`;
    if (this.open === id) {
      this.open = null;
      if (this.diffWin) { closeOverlay(this.diffWin); this.diffWin = null; }
    } else {
      this.open = id; this.note = null;
      const f = (staged ? this.staged : this.files).find((x) => x.path === path), parts = path.split("/");
      // Same key replaces the floating window in place; it also reopens where it was last dropped.
      this.diffWin = openOverlay({ mod: "changes-scm", kind: "window", key: "changes-diff", width: 780, height: 560,
        props: { diff: { path, name: parts.pop(), dir: parts.join("/"), staged, fresh: Boolean(f?.fresh), binary: Boolean(f?.binary), add: f?.add ?? 0, del: f?.del ?? 0, root: this.root, on: this.on ?? null } } });
    }
    cx.notify();
  }

  commit(cx, mode = "commit") {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    // Staged entries commit alone; with nothing staged the commit covers all changes.
    const steps = [...(this.staged?.length ? [] : [["add", "-A"]]), ["commit", "-m", message]];
    if (mode === "push") steps.push(["push"]);
    if (mode === "sync") steps.push(["pull", "--rebase", "--autostash"], ["push"]);
    this.busy = true; this.note = null; this.commitMenu = false;
    cx.spawn(async (cx) => {
      try {
        for (const args of steps) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `提交失败: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  gitOp(cx, label, argList) {
    if (!this.root || this.busy) return;
    const root = this.root, on = this.on, context = this.context;
    const network = ["获取", "拉取", "推送"].includes(label);
    this.busy = true; this.note = null; this.repoMenu = false; this.syncing = network;
    cx.spawn(async (cx) => {
      try {
        for (const args of argList) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
      } catch (e) { if (key() === context) this.note = `${label}失败: ${e}`; }
      finally { this.busy = false; this.syncing = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  stage(cx, path) { this.gitOp(cx, "暂存", [["add", "--", path]]); }
  stageAll(cx) { this.gitOp(cx, "暂存", [["add", "-A"]]); }
  unstage(cx, path) { this.gitOp(cx, "取消暂存", this.hasHead ? [["restore", "--staged", "--", path]] : [["rm", "-r", "--cached", "-q", "--", path]]); }
  unstageAll(cx) { this.gitOp(cx, "取消暂存", this.hasHead ? [["reset", "-q"]] : [["rm", "-r", "--cached", "-q", "--", "."]]); }

  // Minus on a staged row only unstages. Discard (restore/clean) is the × on Changes rows.
  // restore -- path discards worktree vs index (unstaged only); clean removes untracked.
  discardSteps({ path, fresh, all, hasHead }) {
    if (all) {
      const steps = [];
      if (hasHead) steps.push(["restore", "--", "."]);
      steps.push(["clean", "-fd", "--", "."]);
      return steps;
    }
    if (fresh) return [["clean", "-fd", "--", path]];
    if (!hasHead) return [];
    return [["restore", "--", path]];
  }

  askDiscard(cx, opts) {
    if (!this.root || this.busy) return;
    if (opts.all && !this.files.length) return;
    if (!opts.all && opts.conflict) {
      this.note = "冲突文件请先手动解决，不能直接丢弃";
      cx.notify();
      return;
    }
    const name = opts.all ? "全部未暂存更改" : opts.path.split("/").pop();
    openOverlay({
      mod: "changes-scm", kind: "dialog", modal: true, width: 440, height: 180,
      props: {
        confirm: {
          title: opts.all ? "丢弃全部更改？" : `丢弃对 ${name} 的更改？`,
          detail: opts.all
            ? "未暂存的修改将还原；未跟踪的文件/目录将被删除。已暂存的内容不受影响。通常不可撤销。"
            : opts.fresh
              ? "未跟踪的文件将被删除。通常不可撤销。"
              : "工作区修改将还原到索引中的内容，未暂存的改动会丢失。",
          all: Boolean(opts.all), path: opts.path ?? null, fresh: Boolean(opts.fresh),
          hasHead: Boolean(this.hasHead), root: this.root, on: this.on ?? null,
        },
      },
    });
  }

  confirmYes(cx) {
    const c = this.confirm;
    if (!c?.root || this.busy) return;
    const steps = this.discardSteps(c);
    if (!steps.length) {
      notify({ title: "丢弃失败", body: "仓库还没有提交，无法还原已跟踪文件" });
      closeOverlay(props().overlay);
      return;
    }
    this.busy = true;
    cx.spawn(async () => {
      const errors = [];
      try {
        // restore + clean for "all" must both attempt: a restore miss (nothing tracked) must not block clean.
        for (const args of steps) {
          const r = await exec("git", args, { cwd: c.root, on: c.on });
          if (r.code !== 0) errors.push((r.stderr || r.stdout).trim() || args.join(" "));
        }
        if (errors.length === steps.length) throw new Error(errors.join("; "));
        if (errors.length) notify({ title: "部分丢弃失败", body: errors.join("; "), level: "warning" });
      } catch (e) {
        notify({ title: "丢弃失败", body: String(e), level: "error" });
      } finally {
        closeOverlay(props().overlay);
      }
    });
    cx.notify();
  }

  confirmView(t) {
    const c = this.confirm;
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "discard-no" ? t.input : bg)
        .bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    return v_flex().id("discard-confirm").size_full().min_h(0).p(18).gap(12).rounded(8).bg(t.popover).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.confirmYes(cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(c.title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().text_color(t.muted).child(c.detail))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("discard-no", "取消", t.raised, t.foreground, () => closeOverlay(props().overlay)))
        .child(button("discard-yes", this.busy ? "丢弃中…" : "丢弃更改", t.solid, t.solid_foreground, (_e, cx) => this.confirmYes(cx))));
  }

  menuRows(items, t) {
    return v_flex().flex_none().border_b(1).border_color(t.border).py(4).children(items.map(([label, fn]) =>
      div().id(`mi-${label}`).h(26).mx(6).px(10).flex().items_center().rounded(6).text_size(12).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.repoMenu = false; this.commitMenu = false; fn(cx); })
        .child(label)));
  }

  groupHeader(id, label, files, collapsed, toggle, actions, t) {
    return h_flex().h(28).flex_none().mt(2).px(10).gap(6).items_center().cursor_pointer()
      .on_click((_e, cx) => { toggle(); cx.notify(); })
      .child(svg(`mods/workspace-chrome/chevron-${collapsed ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().text_size(11).font_semibold().text_color(t.dim).child(label))
      .child(div().px(5).py(1).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(files.length)))
      .child(div().flex_1())
      .children((actions || []).map((action, i) =>
        div().id(`ga-${id}-${i}`).size(18).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(action.tip)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); action.fn(cx); })
          .child(svg(`mods/workspace-chrome/${action.icon}`).size(13))));
  }

  fileRow(f, staged, t) {
    const parts = f.path.split("/"), name = parts.pop(), [icon, tint] = fileIcon(f.path), oid = `${staged ? "s" : "u"}:${f.path}`;
    return h_flex().id(`change-${oid}`).h(26).flex_none().px(8).gap(7).items_center().rounded(6).cursor_pointer()
      .when(this.open === oid, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(f.path, staged, cx))
      .child(svg(icon).size(14).flex_none().text_color(t[tint] ?? t.muted))
      .child(h_flex().flex_1().min_w(0).gap(5).items_baseline()
        .child(div().max_w(160).truncate().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(parts.join("/"))))
      // Staged − = unstage. Changes + = stage. Changes × = discard working-tree change.
      .when(!f.conflict, (e) => e.child(div().size(18).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(staged ? t.ansi1 : t.ansi2)).tooltip(staged ? "取消暂存" : "暂存")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); staged ? this.unstage(cx, f.path) : this.stage(cx, f.path); })
        .child(svg(`mods/workspace-chrome/${staged ? "minus" : "plus"}.svg`).size(12))))
      .when(!staged && !f.conflict, (e) => e.child(div().size(18).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.ansi1)).tooltip(f.fresh ? "删除未跟踪文件" : "丢弃更改")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.askDiscard(cx, { path: f.path, fresh: Boolean(f.fresh), conflict: Boolean(f.conflict) }); })
        .child(svg("mods/workspace-chrome/x.svg").size(12))))
      .child(div().w(14).flex_none().text_right().text_size(11).text_color(f.status === "A" || f.status === "?" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : f.status === "R" ? t.ansi4 : t.blocked).child(f.status));
  }

  fileList(id, files, staged, t) {
    // The staged group hugs its rows; the changes group takes the rest of the panel.
    return div().flex_1().min_h(30).max_h(staged ? files.length * 26 + 10 : 1e9).relative().border_b(1).border_color(t.border)
      .child(v_flex().id(`list-${id}`).absolute().inset_0().overflow_y_scroll().p(4).children(files.map((f) => this.fileRow(f, staged, t)))
        .when(!files.length && !staged, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "加载更改中…" : this.root ? "没有未提交的更改" : "无文件夹")))))
      .child(Scrollbar.vertical(`list-${id}`).absolute().inset_0());
  }

  diffView(t) {
    const d = this.diff, [icon, tint] = fileIcon(d.path);
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).track_focus(this.handle)
      .on_key_down((e, _cx) => { if (e.key === "escape") closeOverlay(props().overlay); })
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(icon).size(14).flex_none().text_color(t[tint] ?? t.muted))
        .child(div().font_semibold().flex_none().child(d.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(d.dir))
        .when(d.staged, (e) => e.child(div().px(5).py(1).flex_none().rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child("已暂存")))
        .when(d.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${d.add}`)))
        .when(d.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${d.del}`)))
        .child(div().size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, _cx) => closeOverlay(props().overlay))
          .child(svg("mods/pane/close.svg").size(13).text_color(t.dim))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("diff-float-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("diff-float", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("diff-float").viewport_from_layout().absolute().inset_0()));
  }

  render(cx) {
    const t = theme();
    if (this.confirm) return this.confirmView(t);
    if (this.diff) return this.diffView(t);
    if (key() !== this.context) this.refresh(cx);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.repoMenu || this.commitMenu) { this.repoMenu = false; this.commitMenu = false; cx.notify(); }
          else if (this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        }
        if ((e.key === "enter" || e.key === "return") && e.modifiers?.platform && this.typing) this.commit(cx);
      })
      // 存储库: repo name + branch chip + sync + more menu
      .child(h_flex().h(40).flex_none().px(12).gap(7).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/workspace-chrome/monitor.svg").size(15).flex_none().text_color(t.muted))
        .child(div().max_w(130).truncate().font_semibold().child(this.repo ?? "—"))
        .child(h_flex().h(20).px(6).gap(4).flex_none().items_center().rounded(5).bg(t.raised)
          .child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none().text_color(t.dim))
          .child(div().text_size(11).text_color(t.dim).max_w(76).truncate().child(this.branch ?? "—"))
          .when(this.ahead > 0 || this.behind > 0, (e) => e.child(div().text_size(10).text_color(t.muted).child(`${this.behind ? `↓${this.behind}` : ""}${this.ahead ? `↑${this.ahead}` : ""}`))))
        .child(div().flex_1())
        .child(div().id("repo-sync").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).tooltip("获取 (Fetch)")
          .on_click((_e, cx) => this.gitOp(cx, "获取", [["fetch", "--prune"]]))
          .child(svg("mods/changes-scm/sync.svg").size(14).text_color(t.muted).when(this.syncing, (e) => e.spin(900))))
        .child(div().id("repo-more").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.repoMenu = !this.repoMenu; this.commitMenu = false; cx.notify(); })
          .child(svg("mods/changes-scm/ellipsis.svg").size(14).text_color(t.muted))))
      // repo ⋯ menu (accordion, right under the repo row)
      .when(this.repoMenu, (e) => e.child(this.menuRows([
        ["获取 (Fetch)", (cx) => this.gitOp(cx, "获取", [["fetch", "--prune"]])],
        ["拉取 (Pull --ff-only)", (cx) => this.gitOp(cx, "拉取", [["pull", "--ff-only"]])],
        ["推送 (Push)", (cx) => this.gitOp(cx, "推送", [["push"]])],
        ["全部暂存", (cx) => this.stageAll(cx)],
        ["丢弃全部更改", (cx) => this.askDiscard(cx, { all: true })],
        ["刷新", (cx) => this.refresh(cx)],
      ], t)))
      // 提交信息 multiline input
      .child(div().flex_none().px(10).pt(10)
        .child(div().id("commit-message").px(10).py(7).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.input).text_size(12).text_color(t.foreground))))
      // ✓ 提交 split button
      .child(h_flex().h(32).flex_none().mx(10).mt(8).rounded(8).overflow_hidden()
        .child(div().id("commit").flex_1().h_full().flex().items_center().justify_center().gap(6)
          .bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12)
          .when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx))
          .child(svg("mods/workspace-chrome/check.svg").size(13)).child(this.busy ? "提交中…" : "提交"))
        .child(div().id("commit-more").w(30).h_full().flex().items_center().justify_center().border_l(1).border_color(t.border)
          .bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim)
          .cursor_pointer().on_click((_e, cx) => { this.commitMenu = !this.commitMenu; this.repoMenu = false; cx.notify(); })
          .child(svg("mods/workspace-chrome/chevron-down.svg").size(13))))
      // commit dropdown (accordion, right under the split button)
      .when(this.commitMenu, (e) => e.child(this.menuRows([
        ["提交", (cx) => this.commit(cx)],
        ["提交并推送", (cx) => this.commit(cx, "push")],
        ["提交并同步", (cx) => this.commit(cx, "sync")],
      ], t)))
      // 暂存的更改 group (only when anything is staged)
      .when(this.staged.length > 0, (e) => e
        .child(this.groupHeader("staged", "暂存的更改", this.staged, this.sCollapsed, () => { this.sCollapsed = !this.sCollapsed; },
          [{ icon: "minus.svg", tip: "全部取消暂存", fn: (cx) => this.unstageAll(cx) }], t))
        .when(!this.sCollapsed, (e) => e.child(this.fileList("staged", this.staged, true, t))))
      // 更改 group: × discard all, + stage all
      .child(this.groupHeader("changes", "更改", this.files, this.uCollapsed, () => { this.uCollapsed = !this.uCollapsed; },
        this.files.length ? [
          { icon: "x.svg", tip: "丢弃全部更改", fn: (cx) => this.askDiscard(cx, { all: true }) },
          { icon: "plus.svg", tip: "全部暂存", fn: (cx) => this.stageAll(cx) },
        ] : [], t))
      .when(!this.uCollapsed, (e) => e.child(this.fileList("changes", this.files, false, t)))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("仅显示前 1,000 个更改文件")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)));
  }
}
