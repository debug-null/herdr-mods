// Markdown Preview — 独立 Markdown 预览窗格，支持文件内实时内容搜索（⌘F）、关键词高亮跳转、预览/源码切换与自动热刷新。
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Editor, EditorState, InputState, Input } from "gpui-base";
import { checking, readTextFile, watchFolder, theme, settings, exec, window, props } from "herdr";

const MAX = 300000;
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, "") || "/";
const basename = (p) => p.split(/[\\/]/).pop();
const ICON = (name) => `mods/md-preview/${name}.svg`;

function resolve(file, href) {
  const target = decodeURI(href.split("#")[0]);
  if (!target) return null;
  const parts = (target.startsWith("/") ? target : `${dirname(file)}/${target}`).split("/");
  const out = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return "/" + out.join("/");
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
    const winStart = Math.max(0, col - 28);
    const winEnd = Math.min(rawLine.length, col + m[0].length + 72);
    const before = (winStart > 0 ? "…" : "") + rawLine.slice(winStart, col).replace(/^\s+/, winStart === 0 ? "" : " ");
    const hit = rawLine.slice(col, col + m[0].length);
    const after = rawLine.slice(col + m[0].length, winEnd) + (winEnd < rawLine.length ? "…" : "");
    matches.push({ line: li + 1, start: m.index, end: m.index + m[0].length, before, hit, after });
    if (matches.length >= 500) break;
  }
  return matches;
}

export default class MarkdownPreview extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.on = p.on ?? null;
    this.history = [];
    this.mode = "preview";
    this.handle = cx.focus_handle();

    this.findQuery = "";
    this.findFocused = false;
    this.findCase = false;
    this.findRegex = false;
    this.findMatches = [];
    this.findIdx = 0;
    this.findInput = InputState.new({ placeholder: "搜索文档内容… (⌘F)" });
    this.findInput.on("focus", (_e, cx) => { this.findFocused = true; cx.notify(); });
    this.findInput.on("blur", (_e, cx) => { this.findFocused = false; cx.notify(); });
    this.findInput.on("change", (_e, cx) => {
      this.findQuery = this.findInput.value();
      this.recomputeFind(cx, { select: this.mode === "source" });
    });
    this.findInput.on("submit", (_e, cx) => this.stepFind(1, cx));

    if (checking()) return;
    this.open(p.file ?? p.props?.file ?? null, cx);
    if (this.on) cx.timer.every(3000, (cx) => this.load(cx));
  }

  open(file, cx) {
    this.file = file;
    this.text = null;
    this.error = null;
    this.source?.release();
    this.source = null;
    this.findMatches = [];
    this.findIdx = 0;
    this.load(cx);
    this.watch(cx);
  }

  watch(cx) {
    if (this.on || !this.file) return;
    const dir = dirname(this.file);
    const file = this.file;
    if (this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          const changed = await watchFolder(dir);
          if (this.watched === dir && this.file === file && changed.some((p) => p === file || basename(p) === basename(file))) {
            this.load(cx);
          }
        }
      } catch {
        if (this.watched === dir) this.watched = null;
      }
    });
  }

  load(cx) {
    const file = this.file;
    if (!file) {
      this.error = "未提供文件（props.file）";
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file, { on: this.on });
        if (this.file !== file) return;
        if (text === null) {
          this.error = "此文件已不存在";
          this.text = null;
        } else if (text !== this.text) {
          this.text = text.length > MAX ? text.slice(0, MAX) + "\n\n…（文件已截断）" : text;
          this.error = null;
          this.version = (this.version ?? 0) + 1;
          this.source?.release();
          this.source = null;
          this.ensureSource();
          if (this.findQuery.trim()) this.recomputeFind(cx);
        }
      } catch (e) {
        if (this.file === file) this.error = `无法读取此文件：${e}`;
      }
      cx.notify();
    });
  }

  recomputeFind(cx, { select = false } = {}) {
    const q = this.findQuery.trim();
    if (!q || !this.text) {
      this.findMatches = [];
      this.findIdx = 0;
      cx.notify();
      return;
    }
    this.findMatches = findInText(this.text, q, {
      caseSensitive: this.findCase,
      regex: this.findRegex,
    });
    this.findIdx = 0;
    if (select && this.findMatches.length > 0) this.applySelection(this.findMatches[0]);
    cx.notify();
  }

  applySelection(hit) {
    if (!hit) return;
    this.ensureSource(true);
    if (!this.source) return;
    try {
      this.source.set_selected_range({ start: hit.start, end: hit.end });
    } catch {}
  }

  stepFind(delta, cx) {
    if (!this.findMatches.length) return;
    this.findIdx = (this.findIdx + delta + this.findMatches.length) % this.findMatches.length;
    this.mode = "source";
    this.applySelection(this.findMatches[this.findIdx]);
    cx.notify();
  }

  jumpToMatch(idx, cx) {
    if (idx < 0 || idx >= this.findMatches.length) return;
    this.findIdx = idx;
    this.mode = "source";
    this.applySelection(this.findMatches[idx]);
    cx.notify();
  }

  follow(href, cx) {
    if (/^(https?|mailto):/i.test(href)) {
      const w = window()?.platform;
      exec(w === "windows" ? "explorer" : w === "macos" ? "open" : "xdg-open", [href]).catch(() => null);
      return;
    }
    const target = resolve(this.file, href);
    if (!target) return;
    if (/\.(md|markdown|mdx)$/i.test(target)) {
      this.history.push(this.file);
      this.open(target, cx);
    }
  }

  ensureSource(force = false) {
    if (this.source || this.text === null || (!force && this.mode !== "source")) return;
    const t = theme();
    this.source = EditorState.new({
      language: "markdown",
      readonly: true,
      value: this.text,
      font_family: settings().font_family,
      font_size: 12.5,
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
  }

  sourceView(t) {
    return this.source ? Editor.new(this.source).flex_1().min_h(0) : div().p(16).text_color(t.dim).child("加载中…");
  }

  button(id, label, on, t, action) {
    return div()
      .id(id)
      .h(24)
      .px(9)
      .flex()
      .flex_none()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(11.5)
      .bg(on ? t.selected : t.background)
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click(action)
      .child(label);
  }

  renderFindStrip(t) {
    const mono = settings().font_family || "JetBrains Mono";
    const count = this.findMatches.length;
    const hasQ = Boolean(this.findQuery.trim());
    if (!hasQ) return null;

    return v_flex()
      .flex_none()
      .border_b_1()
      .border_color(t.border)
      .bg(t.chrome)
      .when(count === 0, (el) =>
        el.child(div().px(14).py(7).text_size(11.5).text_color(t.dim).child(`未在当前文档中找到「${this.findQuery.trim()}」`))
      )
      .when(count > 0, (el) =>
        el.child(
          div()
            .id("md-hits-scroll")
            .max_h(140)
            .w_full()
            .overflow_y_scrollbar()
            .child(
              v_flex()
                .w_full()
                .py(4)
                .children(
                  this.findMatches.slice(0, 60).map((m, idx) => {
                    const active = idx === this.findIdx;
                    return h_flex()
                      .id(`md-hit-${idx}`)
                      .px(14)
                      .py(4)
                      .gap(10)
                      .items_center()
                      .cursor_pointer()
                      .when(active, (e) => e.bg(t.selected))
                      .when(!active, (e) => e.hover((s) => s.bg(t.hover)))
                      .on_click((_e, cx) => this.jumpToMatch(idx, cx))
                      .children([
                        div()
                          .w(32)
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
                          .text_size(11.5)
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

  render() {
    const t = theme();
    const preview = this.mode === "preview";
    const count = this.findMatches.length;
    const hasQ = Boolean(this.findQuery.trim());

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

    const strip = this.renderFindStrip(t);

    return v_flex()
      .id("md-preview")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-f" || e.keystroke === "ctrl-f") {
          this.findInput.focus();
          cx.stop_propagation();
        }
      })
      .child(
        h_flex()
          .h(40)
          .flex_none()
          .px(12)
          .gap(6)
          .items_center()
          .border_b_1()
          .border_color(t.border)
          .when(this.history.length > 0, (el) =>
            el.child(this.button("md-back", "←", false, t, (_e, cx) => this.open(this.history.pop(), cx)))
          )
          .child(div().font_semibold().flex_none().child(this.file ? basename(this.file) : "Markdown"))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.file ? dirname(this.file) : ""))
          // Inline search box right inside the header
          .when(this.text !== null, (el) =>
            el.children([
              h_flex()
                .w(210)
                .h(26)
                .px(7)
                .gap(4)
                .flex_none()
                .items_center()
                .rounded(6)
                .bg(t.surface)
                .border_1()
                .border_color(this.findFocused ? t.accent : t.border)
                .children([
                  svg(ICON("search")).size(11.5).flex_none().text_color(this.findFocused ? t.accent : t.dim),
                  Input.new(this.findInput).flex_1().min_w(0).h_full().text_size(11.5).text_color(t.foreground),
                  optBtn("md-opt-cs", "Aa", this.findCase, "区分大小写", (_e, cx) => {
                    this.findCase = !this.findCase;
                    this.recomputeFind(cx, { select: this.mode === "source" });
                  }),
                  optBtn("md-opt-rx", ".*", this.findRegex, "正则表达式", (_e, cx) => {
                    this.findRegex = !this.findRegex;
                    this.recomputeFind(cx, { select: this.mode === "source" });
                  }),
                  ...(hasQ
                    ? [
                        div()
                          .id("md-find-clr")
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
              ...(hasQ
                ? [
                    div()
                      .flex_none()
                      .text_size(10.5)
                      .text_color(count > 0 ? t.muted : t.blocked)
                      .child(count > 0 ? `${this.findIdx + 1}/${count}` : "0"),
                    navBtn("md-prev", "arrow-up", "上一处", count > 0, (cx) => this.stepFind(-1, cx)),
                    navBtn("md-next", "arrow-down", "下一处", count > 0, (cx) => this.stepFind(1, cx)),
                  ]
                : []),
            ])
          )
          .child(this.button("md-mode-preview", "预览", preview, t, (_e, cx) => { this.mode = "preview"; cx.notify(); }))
          .child(this.button("md-mode-source", "源码", !preview, t, (_e, cx) => { this.mode = "source"; this.ensureSource(true); cx.notify(); }))
      )
      .when(Boolean(strip), (el) => el.child(strip))
      .when(this.text === null, (el) =>
        el.child(div().p(16).text_color(this.error ? t.ansi1 : t.dim).child(this.error ?? "加载中…"))
      )
      .when(this.text !== null && !preview, (el) => el.child(this.sourceView(t)))
      .when(this.text !== null && preview, (el) =>
        el.child(
          div()
            .id("md-scroll")
            .flex_1()
            .min_h(0)
            .w_full()
            .overflow_y_scrollbar()
            .child(
              h_flex()
                .w_full()
                .justify_center()
                .px(24)
                .py(18)
                .child(
                  div()
                    .w_full()
                    .max_w(880)
                    .text_size(14)
                    .child(
                      TextView.markdown(`md-${this.version}`, this.text)
                        .selectable()
                        .on_link_click((url, cx) => this.follow(url, cx))
                    )
                )
            )
        )
      );
  }
}
