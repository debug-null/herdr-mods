// Files — 懒加载文件浏览器 + 全文内容/文件名搜索 + 文件内查找高亮 + Markdown 预览。
// 兼容本机（rg 优先）与远程机器（无 rg 自动降级 grep），支持点击搜索命中行直接定位高亮。
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, InputState, Input } from "gpui-base";
import {
  checking,
  spaces,
  panes,
  focused,
  exec,
  readTextFile,
  watchFolder,
  theme,
  settings,
  window,
  run,
} from "herdr";

function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on =
    f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}

const key = () => JSON.stringify(location());
const LANG = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js",
  toml: "yaml", jsonc: "json", svelte: "html", vue: "html",
};
const PER_FOLDER = 500;
const TOTAL = 5000;
const MAX_SEARCH_LINES = 200;
const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path ?? "");
const ICON = (name) => `mods/files-md/${name}.svg`;

function splitPath(rel) {
  const clean = String(rel || "").replace(/^\.\//, "");
  const idx = clean.lastIndexOf("/");
  if (idx < 0) return { name: clean, dir: "" };
  return { name: clean.slice(idx + 1), dir: clean.slice(0, idx) };
}

function lineOffset(text, lineNumber) {
  if (!text || lineNumber <= 1) return 0;
  let line = 1;
  let pos = 0;
  while (line < lineNumber && pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) return text.length;
    pos = nl + 1;
    line++;
  }
  return pos;
}

function findInText(text, query, { caseSensitive = false, regex = false } = {}) {
  const matches = [];
  if (!text || !query) return matches;
  let re;
  try {
    const src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(src, caseSensitive ? "g" : "gi");
  } catch {
    return matches;
  }
  // Build line start index for fast line number lookup
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineAt = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid] <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return Math.max(0, hi);
  };

  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const li = lineAt(m.index);
    const lStart = lineStarts[li];
    const lEnd = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : text.length;
    const rawLine = text.slice(lStart, lEnd).replace(/\r$/, "");
    const col = m.index - lStart;
    // Build a window around the match so long lines always show the matched term
    const winStart = Math.max(0, col - 26);
    const winEnd = Math.min(rawLine.length, col + m[0].length + 60);
    const before = (winStart > 0 ? "…" : "") + rawLine.slice(winStart, col).replace(/^\s+/, winStart === 0 ? "" : " ");
    const hitText = rawLine.slice(col, col + m[0].length);
    const after = rawLine.slice(col + m[0].length, winEnd) + (winEnd < rawLine.length ? "…" : "");
    matches.push({
      line: li + 1,
      start: m.index,
      end: m.index + m[0].length,
      before,
      hit: hitText,
      after,
      preview: rawLine.trim().slice(0, 140),
    });
    if (matches.length >= 500) break;
  }
  return matches;
}

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", [
      "-NoProfile",
      "-Command",
      "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress } '" +
        path.replaceAll("'", "''") +
        "'",
    ]);
    if (r.code !== 0) throw new Error(r.stderr || "无法列出此文件夹");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script =
    'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "无法列出此文件夹");
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  }
  return out;
}

async function searchProjectContent(root, on, query, { caseSensitive, regex }) {
  const script = [
    'set -f',
    'Q="$1"; CS="$2"; RX="$3"',
    'RG=""',
    'for p in /opt/homebrew/bin/rg /usr/local/bin/rg "$(command -v rg 2>/dev/null)"; do [ -n "$p" ] && [ -x "$p" ] && RG="$p" && break; done',
    'if [ -n "$RG" ]; then',
    '  ARGS="--line-number --no-heading --color=never --max-count=8 --max-filesize=512K --max-columns=240 --max-columns-preview -g !.git/** -g !node_modules/** -g !dist/** -g !build/** -g !.next/** -g !target/** -g !.venv/** -g !*.min.js -g !*.map"',
    '  [ "$CS" = "0" ] && ARGS="$ARGS -i"',
    '  [ "$RX" = "0" ] && ARGS="$ARGS -F"',
    '  "$RG" $ARGS -- "$Q" . 2>/dev/null | head -n ' + MAX_SEARCH_LINES,
    'else',
    '  ARGS="-rnI --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next --exclude-dir=build --exclude-dir=target --exclude-dir=.venv"',
    '  [ "$CS" = "0" ] && ARGS="$ARGS -i"',
    '  [ "$RX" = "0" ] && ARGS="$ARGS -F"',
    '  grep $ARGS -- "$Q" . 2>/dev/null | head -n ' + MAX_SEARCH_LINES,
    'fi',
  ].join("\n");
  const r = await exec(
    "sh",
    ["-c", script, "files-search", query, caseSensitive ? "1" : "0", regex ? "1" : "0"],
    { cwd: root, on, timeout: 25000 }
  );
  // rg/grep return 1 when no matches, piped through head returns 0
  const lines = (r.stdout || "").split("\n").filter(Boolean);
  const groups = new Map();
  let totalHits = 0;
  for (const raw of lines) {
    const m = raw.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const rel = m[1].replace(/^\.\//, "");
    const line = Number(m[2]);
    const text = m[3].trim().slice(0, 180);
    if (!groups.has(rel)) groups.set(rel, []);
    groups.get(rel).push({ line, text });
    totalHits++;
  }
  return {
    groups: [...groups.entries()].map(([path, hits]) => ({ path, hits })),
    totalHits,
    truncated: lines.length >= MAX_SEARCH_LINES,
  };
}

async function searchProjectNames(root, on, query) {
  const script = [
    'Q="$1"',
    'RG=""',
    'for p in /opt/homebrew/bin/rg /usr/local/bin/rg "$(command -v rg 2>/dev/null)"; do [ -n "$p" ] && [ -x "$p" ] && RG="$p" && break; done',
    'if [ -n "$RG" ]; then',
    '  "$RG" --files -g "!.git/**" -g "!node_modules/**" -g "!dist/**" -g "!build/**" -g "!.next/**" -g "!target/**" . 2>/dev/null | grep -iF -- "$Q" | head -n 120',
    'else',
    '  find . -maxdepth 6 \\( -name .git -o -name node_modules -o -name dist -o -name build -o -name .next -o -name target \\) -prune -o -type f -print 2>/dev/null | grep -iF -- "$Q" | head -n 120',
    'fi',
  ].join("\n");
  const r = await exec("sh", ["-c", script, "files-name-search", query], {
    cwd: root,
    on,
    timeout: 15000,
  });
  const paths = (r.stdout || "")
    .split("\n")
    .map((s) => s.trim().replace(/^\.\//, ""))
    .filter(Boolean);
  return { paths, truncated: paths.length >= 120 };
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};

    // Project-wide search state
    this.searchMode = "content"; // "content" | "name"
    this.searchQuery = "";
    this.searchFocused = false;
    this.caseSensitive = false;
    this.useRegex = false;
    this.searching = false;
    this.searchResults = null; // content: { groups, totalHits, truncated } | name: { paths, truncated }
    this.searchError = null;
    this.collapsedResults = new Set();
    this._searchGen = 0;
    this._debounceGen = 0;

    this.searchInput = InputState.new({ placeholder: "搜索文件内容…" });
    this.searchInput.on("focus", (_e, cx) => { this.searchFocused = true; cx.notify(); });
    this.searchInput.on("blur", (_e, cx) => { this.searchFocused = false; cx.notify(); });
    this.searchInput.on("change", (_e, cx) => {
      this.searchQuery = this.searchInput.value();
      this.scheduleSearch(cx);
      cx.notify();
    });
    this.searchInput.on("submit", (_e, cx) => this.runProjectSearch(cx));

    // In-file find state (always ready once a file is opened)
    this.handle = cx.focus_handle();
    this.rawText = null;
    this.showFind = true;
    this.findQuery = "";
    this.findFocused = false;
    this.findCase = false;
    this.findRegex = false;
    this.findMatches = [];
    this.findIdx = 0;
    this.findInput = InputState.new({ placeholder: "搜索当前文件内容… (⌘F)" });
    this.findInput.on("focus", (_e, cx) => { this.findFocused = true; cx.notify(); });
    this.findInput.on("blur", (_e, cx) => { this.findFocused = false; cx.notify(); });
    this.findInput.on("change", (_e, cx) => {
      this.findQuery = this.findInput.value();
      this.recomputeFind(0, cx, { select: true });
    });
    this.findInput.on("submit", (_e, cx) => this.stepFind(1, cx));

    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        while (this.context === context) {
          await watchFolder(root);
          if (this.current(context)) this.refresh(cx);
        }
      } catch {
        if (this.context === context) this.watched = null;
      }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()]
      .filter(([p]) => p !== path)
      .reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(
      path,
      entries
        .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    );
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location();
    const next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on };
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.folders = new Set(saved?.folders);
      this.pending = new Set();
      this.marks = {};
      this.show(null);
      this.watched = null;
      this.error = null;
      this.limited = false;
      this.loading = false;
      this.searchResults = null;
      this.searchError = null;
      this.searching = false;
      this._searchGen++;
      if (saved?.file) this.show(saved.file, cx);
      else if (this.searchQuery.trim()) this.scheduleSearch(cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec(
            "git",
            [
              "--no-optional-locks",
              "-c", "core.fsmonitor=false",
              "status", "--porcelain=v1", "-z",
              "--no-renames", "--untracked-files=normal",
            ],
            { cwd, on }
          ).catch(() => null);
          if (status?.code === 0) {
            for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
              const xy = entry.slice(0, 2);
              marks[`${top.stdout.trim()}/${entry.slice(3)}`] =
                xy === "??" || xy.includes("A")
                  ? "A"
                  : xy.includes("U")
                  ? "U"
                  : xy.includes("D")
                  ? "D"
                  : "M";
            }
          }
        }
        if (!this.current(context)) return;
        this.marks = marks;
        this.error = null;
        this.watch(cwd, cx);
      } catch (e) {
        if (this.current(context)) this.error = String(e);
      } finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  // ---- project-wide search ------------------------------------------------

  scheduleSearch(cx) {
    const q = this.searchQuery.trim();
    if (!q) {
      this._searchGen++;
      this.searching = false;
      this.searchResults = null;
      this.searchError = null;
      return;
    }
    const gen = ++this._debounceGen;
    cx.timer.after(260, (cx) => {
      if (gen === this._debounceGen) this.runProjectSearch(cx);
    });
  }

  runProjectSearch(cx) {
    const q = this.searchQuery.trim();
    if (!q || !this.root) {
      this.searchResults = null;
      this.searching = false;
      cx.notify();
      return;
    }
    const gen = ++this._searchGen;
    const context = this.context;
    const mode = this.searchMode;
    this.searching = true;
    this.searchError = null;
    this.collapsedResults = new Set();
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res =
          mode === "content"
            ? await searchProjectContent(this.root, this.on, q, {
                caseSensitive: this.caseSensitive,
                regex: this.useRegex,
              })
            : await searchProjectNames(this.root, this.on, q);
        if (gen !== this._searchGen || !this.current(context)) return;
        this.searchResults = { mode, ...res };
      } catch (e) {
        if (gen !== this._searchGen || !this.current(context)) return;
        this.searchError = String(e?.message || e);
        this.searchResults = null;
      } finally {
        if (gen === this._searchGen && this.current(context)) {
          this.searching = false;
          cx.notify();
        }
      }
    });
  }

  clearSearch(cx) {
    this._searchGen++;
    this._debounceGen++;
    this.searchQuery = "";
    this.searchInput.set_value("");
    this.searchResults = null;
    this.searchError = null;
    this.searching = false;
    cx.notify();
  }

  // ---- in-file find -------------------------------------------------------

  recomputeFind(preferLine, cx, { select = false } = {}) {
    const q = this.findQuery.trim();
    if (!q || !this.rawText) {
      this.findMatches = [];
      this.findIdx = 0;
      cx.notify();
      return;
    }
    this.findMatches = findInText(this.rawText, q, {
      caseSensitive: this.findCase,
      regex: this.findRegex,
    });
    if (preferLine > 0 && this.findMatches.length > 0) {
      const idx = this.findMatches.findIndex((m) => m.line >= preferLine);
      this.findIdx = idx >= 0 ? idx : 0;
    } else {
      this.findIdx = 0;
    }
    if (select && this.findMatches.length > 0) {
      this.applySelection(this.findMatches[this.findIdx]);
    }
    cx.notify();
  }

  applySelection(hit) {
    if (!hit || !this.code) return;
    try {
      this.code.set_selected_range({ start: hit.start, end: hit.end });
    } catch {}
  }

  stepFind(delta, cx) {
    if (!this.findMatches.length) return;
    this.findIdx = (this.findIdx + delta + this.findMatches.length) % this.findMatches.length;
    const hit = this.findMatches[this.findIdx];
    if (isMarkdown(this.file) && !this.mdSource) this.mdSource = true;
    this.applySelection(hit);
    cx.notify();
  }

  jumpToMatch(idx, cx) {
    if (idx < 0 || idx >= this.findMatches.length) return;
    this.findIdx = idx;
    if (isMarkdown(this.file) && !this.mdSource) this.mdSource = true;
    this.applySelection(this.findMatches[idx]);
    cx.notify();
  }

  // ---- file tree & preview ------------------------------------------------

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) {
        if (folder === path || folder.startsWith(path + "/")) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try {
            await this.loadFolder(path, context);
          } catch (e) {
            if (this.current(context)) this.error = String(e);
          } finally {
            if (this.context === context) this.pending.delete(path);
            cx.notify();
          }
        });
      }
    }
    cx.notify();
  }

  show(path, cx, opts = {}) {
    this.code?.release();
    this.code = null;
    this.file = path;
    this.fileError = null;
    this.markdown = null;
    this.rawText = null;
    this.mdSource = Boolean(opts.source);
    this.findMatches = [];
    this.findIdx = 0;

    if (!path || !cx) {
      this.showFind = false;
      this.findQuery = "";
      this.findInput?.set_value("");
      return;
    }

    const highlightQuery = (opts.query || "").trim();
    const targetLine = opts.line || 0;
    this.showFind = true;
    if (highlightQuery) {
      this.findQuery = highlightQuery;
      this.findInput.set_value(highlightQuery);
    } else {
      this.findQuery = "";
      this.findInput.set_value("");
    }

    const context = this.context;
    const root = this.root;
    const on = this.on;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) {
          this.fileError = "此文件已不存在";
          return;
        }
        if (text.includes("\0")) {
          this.fileError = "二进制文件 · 无文本预览";
          return;
        }
        const bounded =
          text.length > 400000 ? text.slice(0, 400000) + "\n…（文件已截断）" : text;
        this.rawText = bounded;
        if (isMarkdown(path)) {
          this.markdown =
            text.length > 300000 ? text.slice(0, 300000) + "\n\n…（文件已截断）" : text;
          this.mdVersion = (this.mdVersion ?? 0) + 1;
        }
        const t = theme();
        const ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: true,
          value: bounded,
          font_family: settings().font_family,
          font_size: 12,
          syntax: {
            keyword: t.ansi5,
            string: t.ansi2,
            comment: t.dim,
            function: t.ansi4,
            type: t.ansi3,
            number: t.ansi1,
            constant: t.ansi6,
          },
        });

        if (highlightQuery) {
          this.recomputeFind(targetLine, cx, { select: true });
        } else if (targetLine > 0) {
          const start = lineOffset(bounded, targetLine);
          const nextNl = bounded.indexOf("\n", start);
          const end = nextNl >= 0 ? nextNl : bounded.length;
          this.applySelection({ start, end });
        }
      } catch {
        if (this.file === path && this.current(context)) {
          this.fileError = "无法预览此文件（二进制、过大或不可读）";
        }
      } finally {
        cx.notify();
      }
    });
  }

  followLink(url, cx) {
    if (/^(https?|mailto):/i.test(url)) {
      const w = window()?.platform;
      exec(w === "windows" ? "explorer" : w === "macos" ? "open" : "xdg-open", [url]).catch(() => null);
      return;
    }
    const target = decodeURI(url.split("#")[0]);
    if (!target || target.startsWith("/") || !isMarkdown(target)) return;
    const parts = [...this.file.split("/").slice(0, -1), ...target.split("/")];
    const out = [];
    for (const part of parts) {
      if (part === "..") out.pop();
      else if (part && part !== ".") out.push(part);
    }
    this.show(out.join("/"), cx);
    cx.notify();
  }

  openPane() {
    if (!this.file) return;
    run("pane.split", {
      direction: "right",
      mod: "md-preview",
      props: { file: `${this.root}/${this.file}`, on: this.on ?? null },
    });
  }

  // ---- renderers ----------------------------------------------------------

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = this.folders.has(path);
      const absPath = `${this.root}/${path}`;
      const mark = this.marks[absPath];
      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(28)
          .flex_none()
          .pl(8 + depth * 18)
          .pr(8)
          .gap(7)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .drag_paths([absPath], { on: this.on ?? null })
          .on_click((_e, cx) => (entry.dir ? this.toggle(path, cx) : this.show(path, cx)))
          .child(
            entry.dir
              ? svg(ICON(`chevron-${open ? "down" : "right"}`)).size(12).flex_none().text_color(t.dim)
              : div().w(12).flex_none()
          )
          .child(svg(ICON(entry.dir ? "folder" : "file")).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(entry.name))
          .when(Boolean(mark), (el) =>
            el.child(
              div()
                .text_size(11)
                .text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked)
                .child(mark)
            )
          )
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  renderSearchBar(t) {
    const modeChip = (id, label) => {
      const on = this.searchMode === id;
      return div()
        .id(`smode-${id}`)
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
          if (this.searchMode === id) return;
          this.searchMode = id;
          this.searchResults = null;
          if (this.searchQuery.trim()) this.runProjectSearch(cx);
          else cx.notify();
        })
        .child(label);
    };

    const optBtn = (id, label, on, tip, fn) =>
      div()
        .id(id)
        .h(20)
        .px(5)
        .flex()
        .flex_none()
        .items_center()
        .rounded(4)
        .cursor_pointer()
        .text_size(10.5)
        .font_medium()
        .tooltip(tip)
        .when(on, (e) => e.bg(t.selected).text_color(t.accent))
        .when(!on, (e) => e.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click(fn)
        .child(label);

    return v_flex()
      .flex_none()
      .px(10)
      .pt(9)
      .pb(8)
      .gap(6)
      .border_b_1()
      .border_color(t.border)
      .child(
        h_flex()
          .id("files-search-box")
          .h(30)
          .px(8)
          .gap(5)
          .items_center()
          .rounded(8)
          .bg(t.surface)
          .border_1()
          .border_color(this.searchFocused ? t.accent : t.border)
          .children([
            svg(ICON(this.searching ? "spinner" : "search"))
              .size(12.5)
              .flex_none()
              .text_color(this.searching || this.searchFocused ? t.accent : t.dim)
              .when(this.searching, (el) => el.spin(900)),
            Input.new(this.searchInput)
              .flex_1()
              .min_w(0)
              .h_full()
              .text_size(12)
              .text_color(t.foreground),
            ...(this.searchMode === "content"
              ? [
                  optBtn("sopt-cs", "Aa", this.caseSensitive, "区分大小写", (_e, cx) => {
                    this.caseSensitive = !this.caseSensitive;
                    if (this.searchQuery.trim()) this.runProjectSearch(cx);
                    else cx.notify();
                  }),
                  optBtn("sopt-rx", ".*", this.useRegex, "正则表达式", (_e, cx) => {
                    this.useRegex = !this.useRegex;
                    if (this.searchQuery.trim()) this.runProjectSearch(cx);
                    else cx.notify();
                  }),
                ]
              : []),
            ...(this.searchQuery
              ? [
                  div()
                    .id("files-search-clr")
                    .size(18)
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .cursor_pointer()
                    .text_color(t.dim)
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => this.clearSearch(cx))
                    .child(svg(ICON("x")).size(11)),
                ]
              : []),
          ])
      )
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .children([
            h_flex()
              .gap(3)
              .children([
                modeChip("content", "搜内容"),
                modeChip("name", "搜文件名"),
              ]),
            ...(this.searchResults
              ? [
                  div()
                    .text_size(10.5)
                    .text_color(t.dim)
                    .child(
                      this.searchResults.mode === "content"
                        ? `${this.searchResults.totalHits}${this.searchResults.truncated ? "+" : ""} 处 · ${this.searchResults.groups.length} 文件`
                        : `${this.searchResults.paths.length}${this.searchResults.truncated ? "+" : ""} 个文件`
                    ),
                ]
              : []),
          ])
      );
  }

  renderSearchResults(t) {
    const mono = settings().font_family || "JetBrains Mono";
    const q = this.searchQuery.trim();

    if (this.searchError) {
      return div().p(12).text_size(12).text_color(t.blocked).child(`搜索失败：${this.searchError}`);
    }
    if (this.searching && !this.searchResults) {
      return h_flex()
        .p(16)
        .gap(8)
        .items_center()
        .text_size(12)
        .text_color(t.dim)
        .children([svg(ICON("spinner")).size(13).text_color(t.accent).spin(900), "正在搜索…"]);
    }
    if (!this.searchResults) return div();

    // Name search results
    if (this.searchResults.mode === "name") {
      const paths = this.searchResults.paths || [];
      if (!paths.length) {
        return div().p(14).text_size(12).text_color(t.dim).child(`未找到包含「${q}」的文件`);
      }
      return v_flex()
        .w_full()
        .p(6)
        .gap(2)
        .children(
          paths.map((rel, idx) => {
            const { name, dir } = splitPath(rel);
            return h_flex()
              .id(`sr-file-${idx}`)
              .flex_none()
              .px(8)
              .py(6)
              .gap(7)
              .items_center()
              .rounded(7)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.show(rel, cx))
              .children([
                svg(ICON("file")).size(13.5).flex_none().text_color(t.muted),
                v_flex()
                  .flex_1()
                  .min_w(0)
                  .gap(1)
                  .children([
                    div().truncate().text_size(12.5).text_color(t.foreground).child(name),
                    ...(dir ? [div().truncate().text_size(10.5).text_color(t.dim).child(dir)] : []),
                  ]),
              ]);
          })
        );
    }

    // Full-text content search results grouped by file
    const groups = this.searchResults.groups || [];
    if (!groups.length) {
      return div().p(14).text_size(12).text_color(t.dim).child(`未在文件内容中找到「${q}」`);
    }

    return v_flex()
      .w_full()
      .p(6)
      .gap(6)
      .children(
        groups.map((grp, gIdx) => {
          const { name, dir } = splitPath(grp.path);
          const collapsed = this.collapsedResults.has(grp.path);
          return v_flex()
            .id(`sr-grp-${gIdx}`)
            .flex_none()
            .rounded(8)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .overflow_hidden()
            .child(
              h_flex()
                .id(`sr-ghdr-${gIdx}`)
                .px(8)
                .py(6)
                .gap(6)
                .items_center()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  if (collapsed) this.collapsedResults.delete(grp.path);
                  else this.collapsedResults.add(grp.path);
                  cx.notify();
                })
                .children([
                  svg(ICON(collapsed ? "chevron-right" : "chevron-down")).size(11.5).flex_none().text_color(t.dim),
                  svg(ICON("file")).size(13).flex_none().text_color(t.accent),
                  div().font_medium().text_size(12).text_color(t.foreground).truncate().child(name),
                  ...(dir
                    ? [div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(dir)]
                    : [div().flex_1()]),
                  div()
                    .px(5)
                    .h(16)
                    .flex()
                    .flex_none()
                    .items_center()
                    .rounded(8)
                    .bg(t.raised)
                    .text_size(10)
                    .text_color(t.muted)
                    .child(`${grp.hits.length}`),
                ])
            )
            .when(!collapsed, (el) =>
              el.child(
                v_flex()
                  .border_t_1()
                  .border_color(t.border)
                  .children(
                    grp.hits.map((hit, hIdx) =>
                      h_flex()
                        .id(`sr-hit-${gIdx}-${hIdx}`)
                        .px(9)
                        .py(5)
                        .gap(8)
                        .items_center()
                        .cursor_pointer()
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) =>
                          this.show(grp.path, cx, {
                            query: q,
                            line: hit.line,
                            source: true,
                          })
                        )
                        .children([
                          div()
                            .w(30)
                            .flex_none()
                            .text_right()
                            .font_family(mono)
                            .text_size(10.5)
                            .text_color(t.dim)
                            .child(`${hit.line}`),
                          div()
                            .flex_1()
                            .min_w(0)
                            .truncate()
                            .font_family(mono)
                            .text_size(11)
                            .text_color(t.foreground)
                            .child(hit.text),
                        ])
                    )
                  )
              )
            );
        })
      );
  }

  renderInFileFindBar(t) {
    const mono = settings().font_family || "JetBrains Mono";
    const count = this.findMatches.length;
    const hasQ = Boolean(this.findQuery.trim());
    const countText = hasQ ? (count > 0 ? `${this.findIdx + 1}/${count}` : "无匹配") : "";

    const optBtn = (id, label, on, tip, fn) =>
      div()
        .id(id)
        .h(20)
        .px(5)
        .flex()
        .flex_none()
        .items_center()
        .rounded(4)
        .cursor_pointer()
        .text_size(10.5)
        .font_medium()
        .tooltip(tip)
        .when(on, (e) => e.bg(t.selected).text_color(t.accent))
        .when(!on, (e) => e.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click(fn)
        .child(label);

    const navBtn = (id, icon, tip, enabled, fn) =>
      div()
        .id(id)
        .size(22)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(5)
        .when(enabled, (e) => e.cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .when(!enabled, (e) => e.text_color(t.border))
        .tooltip(tip)
        .on_click((_e, cx) => { if (enabled) fn(cx); })
        .child(svg(ICON(icon)).size(12));

    return v_flex()
      .flex_none()
      .border_b_1()
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        h_flex()
          .px(10)
          .py(6)
          .gap(4)
          .items_center()
          .children([
            h_flex()
              .flex_1()
              .min_w(0)
              .h(28)
              .px(8)
              .gap(5)
              .items_center()
              .rounded(7)
              .bg(t.surface)
              .border_1()
              .border_color(this.findFocused ? t.accent : t.border)
              .children([
                svg(ICON("search")).size(12).flex_none().text_color(this.findFocused ? t.accent : t.dim),
                Input.new(this.findInput).flex_1().min_w(0).h_full().text_size(11.5).text_color(t.foreground),
                optBtn("fopt-cs", "Aa", this.findCase, "区分大小写", (_e, cx) => {
                  this.findCase = !this.findCase;
                  this.recomputeFind(0, cx, { select: true });
                }),
                optBtn("fopt-rx", ".*", this.findRegex, "正则表达式", (_e, cx) => {
                  this.findRegex = !this.findRegex;
                  this.recomputeFind(0, cx, { select: true });
                }),
                ...(hasQ
                  ? [
                      div()
                        .id("find-clr")
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
                          this.findQuery = "";
                          this.findInput.set_value("");
                          this.findMatches = [];
                          this.findIdx = 0;
                          cx.notify();
                        })
                        .child(svg(ICON("x")).size(10)),
                    ]
                  : []),
              ]),
            ...(countText
              ? [
                  div()
                    .flex_none()
                    .px(3)
                    .text_size(10.5)
                    .text_color(count > 0 ? t.muted : t.blocked)
                    .child(countText),
                ]
              : []),
            navBtn("find-prev", "arrow-up", "上一处", count > 0, (cx) => this.stepFind(-1, cx)),
            navBtn("find-next", "arrow-down", "下一处", count > 0, (cx) => this.stepFind(1, cx)),
          ])
      )
      // Highlighted match list (click any row to jump & highlight in source)
      .when(count > 0, (el) =>
        el.child(
          div()
            .id("find-hits-scroll")
            .max_h(136)
            .w_full()
            .overflow_y_scrollbar()
            .border_t_1()
            .border_color(t.border)
            .child(
              v_flex()
                .w_full()
                .py(3)
                .children(
                  this.findMatches.slice(0, 60).map((m, idx) => {
                    const active = idx === this.findIdx;
                    return h_flex()
                      .id(`fhit-${idx}`)
                      .px(10)
                      .py(4)
                      .gap(8)
                      .items_center()
                      .cursor_pointer()
                      .when(active, (e) => e.bg(t.selected))
                      .when(!active, (e) => e.hover((s) => s.bg(t.hover)))
                      .on_click((_e, cx) => this.jumpToMatch(idx, cx))
                      .children([
                        div()
                          .w(28)
                          .flex_none()
                          .text_right()
                          .font_family(mono)
                          .text_size(10.5)
                          .text_color(active ? t.accent : t.dim)
                          .child(`${m.line}`),
                        h_flex()
                          .flex_1()
                          .min_w(0)
                          .overflow_hidden()
                          .items_center()
                          .font_family(mono)
                          .text_size(11)
                          .children([
                            ...(m.before ? [div().flex_none().text_color(t.muted).child(m.before)] : []),
                            div()
                              .flex_none()
                              .px(2)
                              .rounded(3)
                              .bg(t.accent)
                              .text_color(t.accent_foreground)
                              .font_medium()
                              .child(m.hit),
                            ...(m.after ? [div().flex_1().min_w(0).truncate().text_color(t.muted).child(m.after)] : []),
                          ]),
                      ]);
                  })
                )
            )
        )
      );
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const hasSearch = Boolean(this.searchQuery.trim());

    return v_flex()
      .id("files")
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
      .on_key_down((e, cx) => {
        if ((e.keystroke === "cmd-f" || e.keystroke === "ctrl-f") && this.file && this.rawText) {
          this.showFind = true;
          cx.notify();
          cx.timer.after(20, () => this.findInput.focus());
          cx.stop_propagation();
        }
      })
      // Header
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(12)
          .gap(7)
          .items_center()
          .border_b_1()
          .border_color(t.border)
          .when(Boolean(this.file), (el) =>
            el.child(
              h_flex()
                .id("files-back")
                .size(24)
                .flex_none()
                .items_center()
                .justify_center()
                .rounded(6)
                .cursor_pointer()
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .tooltip("返回文件列表")
                .on_click((_e, cx) => {
                  this.show(null);
                  cx.notify();
                })
                .child(svg(ICON("arrow-left")).size(14))
            )
          )
          .child(div().font_semibold().child("文件"))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_right()
              .text_size(11.5)
              .text_color(t.dim)
              .child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")
          )
          .when(Boolean(this.file) && Boolean(this.rawText), (el) =>
            el.child(
              h_flex()
                .id("files-toggle-find")
                .size(24)
                .flex_none()
                .items_center()
                .justify_center()
                .rounded(6)
                .cursor_pointer()
                .tooltip("在当前文件中查找内容")
                .when(this.showFind, (e) => e.bg(t.selected).text_color(t.accent))
                .when(!this.showFind, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
                .on_click((_e, cx) => {
                  this.showFind = !this.showFind;
                  cx.notify();
                  if (this.showFind) cx.timer.after(30, () => this.findInput.focus());
                })
                .child(svg(ICON("search")).size(13))
            )
          )
          .when(isMarkdown(this.file), (el) => {
            const chip = (id, label, on, action) =>
              div()
                .id(id)
                .h(22)
                .px(7)
                .flex()
                .flex_none()
                .items_center()
                .rounded(5)
                .cursor_pointer()
                .text_size(11)
                .bg(on ? t.selected : t.background)
                .text_color(on ? t.foreground : t.muted)
                .hover((s) => s.bg(t.hover))
                .on_click(action)
                .child(label);
            return el
              .child(chip("md-preview", "预览", !this.mdSource, (_e, cx) => { this.mdSource = false; cx.notify(); }))
              .child(chip("md-source", "源码", this.mdSource, (_e, cx) => { this.mdSource = true; cx.notify(); }))
              .child(
                h_flex()
                  .id("md-pane")
                  .size(24)
                  .flex_none()
                  .items_center()
                  .justify_center()
                  .rounded(5)
                  .cursor_pointer()
                  .text_color(t.muted)
                  .tooltip("在独立窗格预览 Markdown")
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click(() => this.openPane())
                  .child(svg(ICON("external")).size(12.5))
              );
          })
      )
      // Directory view: Search bar + (Search results OR File tree)
      .when(!this.file, (el) =>
        el
          .child(this.renderSearchBar(t))
          .child(
            div()
              .id("files-tree")
              .flex_1()
              .min_h(0)
              .w_full()
              .overflow_y_scrollbar()
              .child(
                hasSearch
                  ? this.renderSearchResults(t)
                  : v_flex()
                      .w_full()
                      .p(6)
                      .children(this.rows("", 0, [], t))
                      .when(Boolean(this.error) || !this.entries.get("")?.length, (e) =>
                        e.child(
                          div()
                            .p(8)
                            .text_size(12)
                            .text_color(t.dim)
                            .child(this.error || (this.loading ? "正在加载文件…" : this.root ? "无文件" : "无文件夹"))
                        )
                      )
                      .when(this.limited, (e) =>
                        e.child(
                          div()
                            .p(8)
                            .text_size(11)
                            .text_color(t.dim)
                            .child("文件列表已截断：每个文件夹最多 500 项，总计 5000 项")
                        )
                      )
              )
          )
      )
      // File view: in-file Find bar (visible by default once file loads) + Markdown preview or Code editor
      .when(Boolean(this.file) && Boolean(this.rawText) && this.showFind, (el) => el.child(this.renderInFileFindBar(t)))
      .when(Boolean(this.file) && this.markdown !== null && !this.mdSource, (el) =>
        el.child(
          div()
            .id("files-md-scroll")
            .flex_1()
            .min_h(0)
            .w_full()
            .overflow_y_scrollbar()
            .child(
              v_flex()
                .w_full()
                .px(16)
                .py(12)
                .child(
                  TextView.markdown(`files-md-${this.mdVersion}`, this.markdown)
                    .selectable()
                    .on_link_click((url, cx) => this.followLink(url, cx))
                )
            )
        )
      )
      .when(Boolean(this.file) && (this.markdown === null || this.mdSource), (el) =>
        el.child(
          this.code
            ? Editor.new(this.code).flex_1().min_h(0)
            : div().p(12).text_color(t.dim).child(this.fileError || "正在加载文件…")
        )
      );
  }
}
