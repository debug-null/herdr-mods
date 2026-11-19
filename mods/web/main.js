// A small web preview: type a URL, see the page rendered as rich text inside
// Herdr. Links navigate in place; buttons reload, open the real browser, or
// pop the page out into its own pane.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { theme, run, props as blockProps } from "herdr";

const MAX = 500000;

const normalize = (raw) => {
  let u = String(raw ?? "").trim();
  if (!u) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) u = "https://" + u;
  return /^https?:\/\//i.test(u) ? u : null;
};

export default class Web extends View {
  init(_props, cx) {
    this.url = InputState.new({ placeholder: "输入网址，如 localhost:3000" });
    this.url.on("submit", (_e, cx) => this.go(this.url.value(), cx));
    this.html = null; this.error = null; this.loading = false;
    this.version = 0; this.current = null;
    const p = blockProps();
    if (p && p.url) this.go(p.url, cx);
  }

  go(raw, cx) {
    const u = normalize(raw);
    if (!u) { this.error = "请输入 http/https 网址"; cx.notify(); return; }
    this.current = u;
    if (this.url.value() !== u) this.url.set_value(u);
    this.load(cx);
  }

  load(cx) {
    const u = this.current;
    if (!u) return;
    this.loading = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(u);
        const text = await res.text();
        if (this.current !== u) return;
        if (!res.ok) { this.error = `HTTP ${res.status}`; this.html = null; }
        else { this.html = text.length > MAX ? text.slice(0, MAX) : text; this.version += 1; }
      } catch (e) {
        if (this.current === u) { this.error = String(e && e.message ? e.message : e); this.html = null; }
      }
      if (this.current === u) this.loading = false;
      cx.notify();
    });
  }

  iconBtn(id, name, tip, enabled, onClick, t) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .cursor_pointer().text_color(enabled ? t.muted : t.border)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (enabled) onClick(cx); })
      .child(svg(`mods/web/${name}.svg`).size(14))
      .tooltip(tip);
  }

  render(cx) {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const hasPage = this.html !== null;
    return v_flex().id("web").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/web/globe.svg").size(15).flex_none().text_color(t.muted))
        .child(Input.new(this.url).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
        .child(this.iconBtn("web-reload", "refresh", "刷新", Boolean(this.current) && !this.loading, (cx) => this.load(cx), t))
        .child(this.iconBtn("web-browser", "external", "在浏览器中打开", Boolean(this.current), (cx) => { if (this.current) cx.open_url(this.current); }, t))
        .child(this.iconBtn("web-expand", "expand", "在独立窗格中打开", Boolean(this.current || this.url.value()), (cx) => {
          const u = this.current || this.url.value();
          if (u) run("pane.split", { direction: "right", mod: "web", props: { url: u } });
        }, t)))
      .child(div().flex_1().min_h(0)
        .when(!hasPage && !this.error && !this.loading, (el) => el.child(
          v_flex().size_full().items_center().justify_center().gap(8).text_color(t.dim)
            .child(svg("mods/web/globe.svg").size(28).opacity(0.5))
            .child(div().text_size(12).child("输入网址，在这里预览网页"))))
        .when(this.loading && !hasPage, (el) => el.child(
          h_flex().h_full().items_center().justify_center().text_color(t.dim)
            .child(div().text_size(12).child("加载中…"))))
        .when(Boolean(this.error) && !hasPage, (el) => el.child(
          v_flex().h_full().items_center().justify_center().gap(10).p(16)
            .child(div().text_size(12).text_color(t.ansi1).child(this.error))
            .child(div().id("web-retry").h(26).px(12).flex().items_center().rounded(6).border_1().border_color(t.border)
              .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
              .on_click((_e, cx) => this.load(cx)).child("重试"))))
        .when(hasPage, (el) => el.child(
          div().id("web-scroll").size_full().min_h(0).overflow_y_scrollbar().px(14).py(12)
            .child(TextView.html(`web-${this.version}`, this.html).selectable().on_link_click((url, cx) => this.go(url, cx))))));
  }
}
