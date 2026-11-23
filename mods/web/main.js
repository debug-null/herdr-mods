// Web — 开发网页预览 & Chromium 浏览器中控面板。
// 修复 localhost:port 解析 Bug，支持前进/后退、书签收藏、本机端口探测、SPA 识别、
// 以及与 herdr-web-browser（真 Chromium 视图 & 发送页面/截图给 Agent）的深度联动。
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import {
  agents,
  checking,
  exec,
  focused,
  home,
  notify,
  props as blockProps,
  run,
  shared,
  setShared,
  theme,
} from "herdr";

const MAX_HTML = 500_000;
const BOOKMARKS_KEY = "web.bookmarks";
const RECENT_KEY = "web.recent";
const DEV_PROCS = /^(node|bun|deno|vite|next|nuxt|python|python3|uvicorn|gunicorn|ruby|rails|go|cargo|air|php|caddy|nginx|http-serve|esbuild|webpack|turbo|pnpm|yarn|npm)/i;
const ICON = (name) => `mods/web/${name}.svg`;

function normalize(raw, base = null) {
  let u = String(raw ?? "").trim();
  if (!u) return null;
  if (/^:\d{2,5}(\/.*)?$/.test(u)) return `http://localhost${u}`;
  if (/^https?:\/\//i.test(u)) return u;
  // Relative link navigation when a current page is open
  if (base && (/^(\/|\.\.?\/|\?|#)/.test(u) || !u.includes("."))) {
    try {
      const resolved = new URL(u, base).toString();
      if (/^https?:\/\//i.test(resolved)) return resolved;
    } catch {}
  }
  // Localhost / loopback / LAN hosts default to http:// (fixes localhost:3000 bug)
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?(\/.*)?$/i.test(u)) {
    return `http://${u}`;
  }
  if (/^[a-zA-Z0-9.-]+:\d{2,5}(\/.*)?$/.test(u)) {
    return `http://${u}`;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) {
    return /^https?:\/\//i.test(u) ? u : null;
  }
  return `https://${u}`;
}

function shortHost(u) {
  try {
    const parsed = new URL(u);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const label = `${parsed.host}${path}`;
    return label.length > 34 ? label.slice(0, 33) + "…" : label;
  } catch {
    return String(u || "");
  }
}

function extractTitle(html, fallbackUrl) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m && m[1]) {
    const clean = m[1].replace(/\s+/g, " ").trim();
    if (clean) return clean.slice(0, 60);
  }
  return shortHost(fallbackUrl);
}

function detectSpaShell(html) {
  const s = String(html || "");
  if (!s) return false;
  const hasAppRoot =
    /id=["'](?:root|app|__next|__nuxt)["']/i.test(s) ||
    /<script[^>]+type=["']module["']/i.test(s);
  if (!hasAppRoot) return false;
  const stripped = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length < 140;
}

function loadList(key) {
  const v = shared(key);
  return Array.isArray(v) ? v : [];
}

function focusedAgent() {
  const f = focused();
  const list = agents();
  return (
    list.find((a) => a.address === f?.terminal) ||
    list.find((a) => a.address === f?.agent) ||
    list[0] ||
    null
  );
}

export default class Web extends View {
  init(_props, cx) {
    this.urlFocused = false;
    this.url = InputState.new({ placeholder: "输入网址或端口，如 localhost:3000 或 :5173" });
    this.url.on("focus", (_e, cx) => {
      this.urlFocused = true;
      cx.notify();
    });
    this.url.on("blur", (_e, cx) => {
      this.urlFocused = false;
      cx.notify();
    });
    this.url.on("submit", (_e, cx) => this.go(this.url.value(), cx));

    this.html = null;
    this.title = null;
    this.error = null;
    this.loading = false;
    this.statusCode = null;
    this.elapsedMs = null;
    this.isSpa = false;
    this.version = 0;
    this.current = null;

    this.stack = [];
    this.cursor = -1;
    this.ports = [];
    this.scanningPorts = false;
    this.browserBin = null;
    this.browserBusy = null;

    const p = blockProps();
    if (p && p.url) this.go(p.url, cx);

    if (checking()) return;
    this.detectBrowserBin(cx);
    this.scanPorts(cx);
    cx.timer.every(15000, (cx) => this.scanPorts(cx));
  }

  detectBrowserBin(cx) {
    cx.spawn(async (cx) => {
      const cmd =
        'for p in "$HOME/.local/bin/herdr-web-browser" "$HOME"/.config/herdr/plugins/github/herdr-web-browser-*/target/release/herdr-web-browser; do [ -x "$p" ] && echo "$p" && break; done';
      const r = await exec("/bin/sh", ["-c", cmd]).catch(() => null);
      const bin = r?.stdout?.trim() || null;
      if (bin !== this.browserBin) {
        this.browserBin = bin;
        cx.notify();
      }
    });
  }

  scanPorts(cx) {
    if (this.scanningPorts) return;
    this.scanningPorts = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "cn"]).catch(() => null);
        if (!r || r.code !== 0) return;
        const found = [];
        const seen = new Set();
        let proc = "";
        for (const line of (r.stdout || "").split("\n")) {
          if (line.startsWith("c")) {
            proc = line.slice(1);
          } else if (line.startsWith("n")) {
            const addr = line.slice(1);
            const m = addr.match(/:(\d+)$/);
            if (!m) continue;
            const port = Number(m[1]);
            if (port < 1024 || port > 20000 || seen.has(port)) continue;
            const commonPort =
              (port >= 3000 && port <= 3010) ||
              (port >= 4000 && port <= 4321) ||
              (port >= 5173 && port <= 5180) ||
              (port >= 8000 && port <= 8090) ||
              port === 8888 ||
              port === 9000;
            if (!commonPort && !DEV_PROCS.test(proc)) continue;
            seen.add(port);
            found.push({ port, proc: proc || "server", url: `http://localhost:${port}` });
          }
        }
        found.sort((a, b) => a.port - b.port);
        this.ports = found.slice(0, 8);
        cx.notify();
      } finally {
        this.scanningPorts = false;
      }
    });
  }

  go(raw, cx, { push = true, base = null } = {}) {
    const u = normalize(raw, base);
    if (!u) {
      this.error = "请输入有效网址（支持 localhost:3000、:5173 或 https://...）";
      cx.notify();
      return;
    }
    if (push && u !== this.current) {
      this.stack = this.stack.slice(0, this.cursor + 1);
      this.stack.push(u);
      this.cursor = this.stack.length - 1;
    }
    this.current = u;
    if (this.url.value() !== u) this.url.set_value(u);
    this.load(cx);
  }

  canBack() {
    return this.cursor > 0;
  }

  canForward() {
    return this.cursor >= 0 && this.cursor < this.stack.length - 1;
  }

  back(cx) {
    if (!this.canBack()) return;
    this.cursor -= 1;
    this.go(this.stack[this.cursor], cx, { push: false });
  }

  forward(cx) {
    if (!this.canForward()) return;
    this.cursor += 1;
    this.go(this.stack[this.cursor], cx, { push: false });
  }

  goHome(cx) {
    this.current = null;
    this.html = null;
    this.title = null;
    this.error = null;
    this.isSpa = false;
    this.statusCode = null;
    this.elapsedMs = null;
    this.url.set_value("");
    this.scanPorts(cx);
    cx.notify();
  }

  recordRecent(url, title) {
    const list = loadList(RECENT_KEY).filter((x) => x.url !== url);
    list.unshift({ url, title: title || shortHost(url), at: Date.now() });
    setShared(RECENT_KEY, list.slice(0, 8));
  }

  isBookmarked(url) {
    if (!url) return false;
    return loadList(BOOKMARKS_KEY).some((b) => b.url === url);
  }

  toggleBookmark(cx) {
    if (!this.current) return;
    const list = loadList(BOOKMARKS_KEY);
    const exists = list.some((b) => b.url === this.current);
    const next = exists
      ? list.filter((b) => b.url !== this.current)
      : [{ url: this.current, title: this.title || shortHost(this.current) }, ...list].slice(0, 12);
    setShared(BOOKMARKS_KEY, next);
    notify({
      title: "网页",
      body: exists ? "已取消收藏" : `已收藏 ${shortHost(this.current)}`,
      level: "info",
      timeout: 1800,
    });
    cx.notify();
  }

  load(cx) {
    const u = this.current;
    if (!u) return;
    const started = Date.now();
    this.loading = true;
    this.error = null;
    this.isSpa = false;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(u);
        const text = await res.text();
        if (this.current !== u) return;
        this.statusCode = res.status;
        this.elapsedMs = Date.now() - started;
        if (!res.ok) {
          this.error = `HTTP ${res.status} ${res.statusText || ""}`.trim();
          this.html = null;
          this.title = shortHost(u);
        } else {
          this.html = text.length > MAX_HTML ? text.slice(0, MAX_HTML) : text;
          this.title = extractTitle(this.html, u);
          this.isSpa = detectSpaShell(this.html);
          this.version += 1;
          this.recordRecent(u, this.title);
        }
      } catch (e) {
        if (this.current === u) {
          this.statusCode = null;
          this.elapsedMs = Date.now() - started;
          this.error = String(e?.message || e);
          this.html = null;
        }
      }
      if (this.current === u) this.loading = false;
      cx.notify();
    });
  }

  runChromium(label, args, cx, thenShow = false) {
    if (!this.browserBin) {
      notify({ title: "网页", body: "未检测到 herdr-web-browser 插件", level: "error", timeout: 2500 });
      return;
    }
    if (this.browserBusy) return;
    this.browserBusy = label;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(this.browserBin, args, { timeout: 30000 }).catch((e) => ({
          code: 1,
          stdout: "",
          stderr: String(e),
        }));
        if (r.code !== 0) {
          notify({
            title: "Chromium 浏览器",
            body: (r.stderr || r.stdout || `${label} 失败`).trim().slice(0, 200),
            level: "error",
          });
          return;
        }
        if (thenShow) {
          const ag = focusedAgent();
          const showArgs = ag ? ["--owner", ag.address, "show"] : ["show"];
          await exec(this.browserBin, showArgs, { timeout: 15000 }).catch(() => null);
        }
        notify({
          title: "Chromium 浏览器",
          body: (r.stdout || `${label}已完成`).trim().slice(0, 160),
          level: "success",
          timeout: 2200,
        });
      } finally {
        this.browserBusy = null;
        cx.notify();
      }
    });
  }

  openInChromium(url, cx) {
    const target = normalize(url || this.current || this.url.value());
    if (!target) return;
    const ag = focusedAgent();
    const owner = ag ? ["--owner", ag.address] : [];
    this.runChromium("打开实时视图", [...owner, "open", target], cx, true);
  }

  sendToAgent(kind, cx) {
    const ag = focusedAgent();
    if (!ag) {
      notify({ title: "网页", body: "当前没有可发送的运行中 Agent", level: "warning", timeout: 2200 });
      return;
    }
    const label = kind === "screenshot" ? "发送截图给 Agent" : "发送页面给 Agent";
    this.runChromium(label, ["--owner", ag.address, "send", kind, "--agent", ag.address], cx, false);
  }

  iconBtn(id, name, tip, enabled, onClick, t, opts = {}) {
    const accent = Boolean(opts.accent);
    const spinning = Boolean(opts.spinning);
    return div()
      .id(id)
      .size(24)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .when(enabled, (el) =>
        el
          .cursor_pointer()
          .text_color(accent ? t.accent : t.muted)
          .hover((s) => s.bg(t.hover).text_color(accent ? t.accent : t.foreground))
      )
      .when(!enabled, (el) => el.text_color(t.border))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (enabled) onClick(cx);
      })
      .child(svg(ICON(name)).size(13.5).when(spinning, (el) => el.spin(900)))
      .tooltip(tip);
  }

  actionPill(id, icon, label, tip, onClick, t, primary = false) {
    return h_flex()
      .id(id)
      .h(24)
      .px(8)
      .gap(4)
      .flex_none()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(11)
      .border_1()
      .when(primary, (el) =>
        el
          .bg(t.selected)
          .border_color(t.accent)
          .text_color(t.foreground)
          .font_medium()
          .hover((s) => s.bg(t.hover))
      )
      .when(!primary, (el) =>
        el
          .bg(t.surface)
          .border_color(t.border)
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
      )
      .tooltip(tip)
      .on_click(onClick)
      .children([svg(ICON(icon)).size(11.5).flex_none(), label]);
  }

  renderHome(t, cx) {
    const bookmarks = loadList(BOOKMARKS_KEY);
    const recent = loadList(RECENT_KEY);

    return div()
      .id("web-home-scroll")
      .flex_1()
      .min_h(0)
      .w_full()
      .overflow_y_scrollbar()
      .child(
        v_flex()
          .w_full()
          .p(14)
          .gap(16)
          // Local dev servers
          .child(
            v_flex()
              .flex_none()
              .gap(7)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .children([
                    h_flex()
                      .gap(6)
                      .items_center()
                      .children([
                        svg(ICON("server")).size(12.5).text_color(t.done),
                        div().text_size(11.5).font_medium().text_color(t.muted).child("本机监听服务"),
                      ]),
                    this.iconBtn(
                      "web-rescan",
                      "refresh",
                      "重新扫描本机端口",
                      !this.scanningPorts,
                      (cx) => this.scanPorts(cx),
                      t,
                      { spinning: this.scanningPorts }
                    ),
                  ])
              )
              .child(
                this.ports.length > 0
                  ? v_flex()
                      .flex_none()
                      .gap(5)
                      .children(
                        this.ports.map((p) =>
                          h_flex()
                            .id(`port-${p.port}`)
                            .flex_none()
                            .px(10)
                            .py(7)
                            .gap(8)
                            .items_center()
                            .rounded(8)
                            .bg(t.surface)
                            .border_1()
                            .border_color(t.border)
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover).border_color(t.input))
                            .on_click((_e, cx) => this.go(p.url, cx))
                            .children([
                              div().size(6).flex_none().rounded_full().bg(t.done),
                              v_flex()
                                .flex_1()
                                .min_w(0)
                                .gap(1)
                                .children([
                                  div().text_size(12).font_medium().text_color(t.foreground).child(`localhost:${p.port}`),
                                  div().text_size(10.5).text_color(t.dim).truncate().child(p.proc),
                                ]),
                              ...(this.browserBin
                                ? [
                                    div()
                                      .id(`port-chr-${p.port}`)
                                      .h(22)
                                      .px(7)
                                      .flex()
                                      .items_center()
                                      .rounded(5)
                                      .bg(t.raised)
                                      .text_size(10.5)
                                      .text_color(t.muted)
                                      .tooltip("用真 Chromium 实时视图打开")
                                      .hover((s) => s.bg(t.selected).text_color(t.foreground))
                                      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                                      .on_click((_e, cx) => {
                                        cx.stop_propagation();
                                        this.openInChromium(p.url, cx);
                                      })
                                      .child("Chromium"),
                                  ]
                                : []),
                            ])
                        )
                      )
                  : div()
                      .px(10)
                      .py(8)
                      .rounded(8)
                      .bg(t.surface)
                      .border_1()
                      .border_color(t.border)
                      .text_size(11.5)
                      .text_color(t.dim)
                      .child("暂未检测到本地开发端口（支持直接输入 :3000 访问）")
              )
          )
          // Bookmarks
          .when(bookmarks.length > 0, (el) =>
            el.child(
              v_flex()
                .flex_none()
                .gap(7)
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .children([
                      svg(ICON("star-filled")).size(12).text_color(t.accent),
                      div().text_size(11.5).font_medium().text_color(t.muted).child("收藏书签"),
                    ])
                )
                .child(
                  v_flex()
                    .flex_none()
                    .gap(4)
                    .children(
                      bookmarks.map((b, i) =>
                        h_flex()
                          .id(`bm-${i}`)
                          .flex_none()
                          .px(10)
                          .py(7)
                          .gap(8)
                          .items_center()
                          .rounded(8)
                          .bg(t.surface)
                          .border_1()
                          .border_color(t.border)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => this.go(b.url, cx))
                          .children([
                            svg(ICON("globe")).size(13).flex_none().text_color(t.muted),
                            v_flex()
                              .flex_1()
                              .min_w(0)
                              .gap(1)
                              .children([
                                div().truncate().text_size(12).font_medium().text_color(t.foreground).child(b.title || shortHost(b.url)),
                                div().truncate().text_size(10.5).text_color(t.dim).child(b.url),
                              ]),
                          ])
                      )
                    )
                )
            )
          )
          // Recent visits
          .when(recent.length > 0, (el) =>
            el.child(
              v_flex()
                .flex_none()
                .gap(7)
                .child(div().text_size(11.5).font_medium().text_color(t.muted).child("最近访问"))
                .child(
                  v_flex()
                    .flex_none()
                    .gap(3)
                    .children(
                      recent.map((r, i) =>
                        h_flex()
                          .id(`rec-${i}`)
                          .flex_none()
                          .px(9)
                          .py(6)
                          .gap(8)
                          .items_center()
                          .rounded(7)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => this.go(r.url, cx))
                          .children([
                            svg(ICON("globe")).size(12.5).flex_none().text_color(t.dim),
                            div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(r.title || shortHost(r.url)),
                            div().flex_none().text_size(10.5).text_color(t.dim).child(shortHost(r.url)),
                          ])
                      )
                    )
                )
            )
          )
      );
  }

  render(cx) {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const hasPage = this.html !== null;
    const bookmarked = this.isBookmarked(this.current);
    const ag = focusedAgent();

    return v_flex()
      .id("web")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      // Top navigation bar
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(8)
          .gap(4)
          .items_center()
          .border_b_1()
          .border_color(t.border)
          .children([
            this.iconBtn("web-back", "arrow-left", "后退", this.canBack(), (cx) => this.back(cx), t),
            this.iconBtn("web-fwd", "arrow-right", "前进", this.canForward(), (cx) => this.forward(cx), t),
            this.iconBtn(
              "web-reload",
              "refresh",
              this.current ? "刷新页面" : "扫描本地端口",
              !this.loading,
              (cx) => (this.current ? this.load(cx) : this.scanPorts(cx)),
              t,
              { spinning: this.loading }
            ),
            // Address bar
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
              .border_color(this.urlFocused ? t.accent : t.border)
              .children([
                svg(ICON("globe"))
                  .size(13)
                  .flex_none()
                  .text_color(this.current ? t.accent : t.dim),
                Input.new(this.url)
                  .flex_1()
                  .min_w(0)
                  .h_full()
                  .text_size(12)
                  .text_color(t.foreground),
                ...(this.current
                  ? [
                      div()
                        .id("web-home-btn")
                        .size(18)
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .rounded(4)
                        .cursor_pointer()
                        .text_color(t.dim)
                        .tooltip("返回起始页（端口与书签）")
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .on_click((_e, cx) => this.goHome(cx))
                        .child(svg(ICON("x")).size(11)),
                    ]
                  : []),
              ]),
            this.iconBtn(
              "web-star",
              bookmarked ? "star-filled" : "star",
              bookmarked ? "取消收藏" : "收藏当前网址",
              Boolean(this.current),
              (cx) => this.toggleBookmark(cx),
              t,
              { accent: bookmarked }
            ),
            this.iconBtn(
              "web-browser",
              "external",
              "在系统浏览器打开",
              Boolean(this.current),
              (cx) => {
                if (this.current) cx.open_url(this.current);
              },
              t
            ),
            this.iconBtn(
              "web-expand",
              "expand",
              "在独立窗格打开",
              Boolean(this.current || this.url.value()),
              () => {
                const u = normalize(this.current || this.url.value());
                if (u) run("pane.split", { direction: "right", mod: "web", props: { url: u } });
              },
              t
            ),
          ])
      )
      // Chromium & Agent bridge bar (when herdr-web-browser is installed)
      .when(Boolean(this.browserBin), (el) =>
        el.child(
          h_flex()
            .flex_none()
            .px(10)
            .py(6)
            .gap(6)
            .items_center()
            .bg(t.chrome)
            .border_b_1()
            .border_color(t.border)
            .overflow_x_scroll()
            .children([
              this.actionPill(
                "web-chr-view",
                "monitor",
                this.browserBusy ? `${this.browserBusy}…` : "实时视图",
                "用真 Chromium (herdr-web-browser) 打开并支持 JS / SPA 交互",
                (_e, cx) => this.openInChromium(this.current || this.url.value() || this.ports[0]?.url, cx),
                t,
                this.isSpa
              ),
              this.actionPill(
                "web-chr-send-page",
                "send",
                "发页面给 Agent",
                ag ? `发送当前浏览器页面正文给 ${ag.address} (${ag.program?.name || "Agent"})` : "无活跃 Agent",
                (_e, cx) => this.sendToAgent("page", cx),
                t
              ),
              this.actionPill(
                "web-chr-send-shot",
                "camera",
                "发截图",
                ag ? `发送当前浏览器截图给 ${ag.address}` : "无活跃 Agent",
                (_e, cx) => this.sendToAgent("screenshot", cx),
                t
              ),
              ...(ag
                ? [
                    div().flex_1(),
                    div()
                      .flex_none()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(`→ ${ag.address}`),
                  ]
                : []),
            ])
        )
      )
      // SPA notice banner when static fetch only gets an empty JS shell
      .when(hasPage && this.isSpa, (el) =>
        el.child(
          h_flex()
            .flex_none()
            .px(12)
            .py(7)
            .gap(8)
            .items_center()
            .justify_between()
            .bg(t.raised)
            .border_b_1()
            .border_color(t.border)
            .children([
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11.5)
                .text_color(t.muted)
                .child("检测到动态 SPA 页面，静态文本预览可能不完整"),
              ...(this.browserBin
                ? [
                    div()
                      .id("web-spa-open")
                      .flex_none()
                      .px(8)
                      .h(22)
                      .flex()
                      .items_center()
                      .rounded(5)
                      .bg(t.solid)
                      .text_color(t.solid_foreground)
                      .text_size(11)
                      .cursor_pointer()
                      .on_click((_e, cx) => this.openInChromium(this.current, cx))
                      .child("用 Chromium 打开"),
                  ]
                : []),
            ])
        )
      )
      // Main content
      .child(
        !hasPage && !this.error && !this.loading
          ? this.renderHome(t, cx)
          : this.loading && !hasPage
          ? v_flex()
              .flex_1()
              .min_h(0)
              .items_center()
              .justify_center()
              .gap(8)
              .text_color(t.dim)
              .children([
                svg(ICON("refresh")).size(20).text_color(t.accent).spin(900),
                div().text_size(12).child(`正在加载 ${shortHost(this.current)}…`),
              ])
          : Boolean(this.error) && !hasPage
          ? v_flex()
              .flex_1()
              .min_h(0)
              .items_center()
              .justify_center()
              .gap(10)
              .p(18)
              .children([
                div().text_size(12.5).font_medium().text_color(t.blocked).child("页面加载失败"),
                div().text_size(11.5).text_color(t.muted).whitespace_normal().child(this.error),
                h_flex()
                  .gap(8)
                  .children([
                    div()
                      .id("web-retry")
                      .h(28)
                      .px(12)
                      .flex()
                      .items_center()
                      .rounded(6)
                      .border_1()
                      .border_color(t.border)
                      .bg(t.surface)
                      .text_size(12)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_mouse_down("left", stop)
                      .on_click((_e, cx) => this.load(cx))
                      .child("重试"),
                    ...(this.browserBin
                      ? [
                          div()
                            .id("web-err-chr")
                            .h(28)
                            .px(12)
                            .flex()
                            .items_center()
                            .rounded(6)
                            .bg(t.solid)
                            .text_color(t.solid_foreground)
                            .text_size(12)
                            .cursor_pointer()
                            .on_click((_e, cx) => this.openInChromium(this.current, cx))
                            .child("改用 Chromium 打开"),
                        ]
                      : []),
                  ]),
              ])
          : div()
              .id("web-scroll")
              .flex_1()
              .min_h(0)
              .w_full()
              .overflow_y_scrollbar()
              .child(
                v_flex()
                  .w_full()
                  .px(14)
                  .py(12)
                  .child(
                    TextView.html(`web-${this.version}`, this.html)
                      .selectable()
                      .on_link_click((url, cx) => this.go(url, cx, { base: this.current }))
                  )
              )
      )
      // Subtle status footer when a page is loaded
      .when(Boolean(this.current), (el) =>
        el.child(
          h_flex()
            .flex_none()
            .px(10)
            .py(5)
            .gap(8)
            .items_center()
            .justify_between()
            .border_t_1()
            .border_color(t.border)
            .bg(t.chrome)
            .text_size(10.5)
            .text_color(t.dim)
            .children([
              div().flex_1().min_w(0).truncate().child(this.title || shortHost(this.current)),
              div()
                .flex_none()
                .child(
                  [
                    this.statusCode ? `HTTP ${this.statusCode}` : null,
                    this.elapsedMs != null ? `${this.elapsedMs}ms` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                ),
            ])
        )
      );
  }
}
