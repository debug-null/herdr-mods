// Image Annotate — 全中文图片预览 & 图上插针批注发回 Agent。
// 自动发现当前项目图片与最近系统/临时截图，支持直接从 Finder 拖入图片；
// 点击图片任意位置即可插针标注坐标与修改意见，⌘Enter 一键发送给当前聚焦的 Agent！
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import {
  agents,
  appHome,
  checking,
  exec,
  focused,
  hc,
  home,
  notify,
  panes,
  props as modProps,
  run,
  spaces,
  theme,
} from "herdr";

const ICON = (name) => `mods/image-annotate/icons/${name}.svg`;
const IS_IMG = /\.(png|jpe?g|webp|gif)$/i;

function basename(p) {
  return p ? String(p).replace(/\/+$/, "").split("/").pop() || p : "";
}

function tilde(p) {
  return p ? String(p).replace(/^\/Users\/[^/]+/, "~") : "";
}

function regionLabel(xp, yp) {
  const h = xp < 33 ? "左" : xp > 67 ? "右" : "中";
  const v = yp < 33 ? "上" : yp > 67 ? "下" : "中";
  if (h === "中" && v === "中") return "中央区域";
  if (h === "中") return `${v}方居中`;
  if (v === "中") return `${h}侧居中`;
  return `${h}${v}区域`;
}

function activeLocalCwd() {
  const sp = spaces().find((s) => s.active);
  if (!sp || sp.machine) return "";
  const tabs = new Set((sp.tabs || []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || sp.folder || "";
}

function defaultAgentAddr() {
  const f = focused();
  const live = agents();
  const hit = live.find((a) => a.address === f?.terminal) || live.find((a) => a.address === f?.agent) || live[0] || null;
  return hit?.address || f?.terminal || null;
}

export default class ImageAnnotate extends View {
  init(p, cx) {
    const initProps = p || modProps() || {};
    this.source = "recent"; // "recent" (/tmp + Desktop) | "project" (cwd)
    this.images = [];
    this.loading = false;
    this.current = initProps.file || null;
    this.displayRel = null; // relative path under appHome() required by GPUI image()
    this.natSize = { w: 1200, h: 750 };
    this.stageSize = { width: 340, height: 280 };
    this.pins = []; // [{ id, xPct, yPct, text }]
    this.activePinId = null;
    this.pinSeq = 1;
    this.sending = false;
    this.targetAddr = defaultAgentAddr();
    this.noteFocused = false;

    this.handle = cx.focus_handle();
    this.noteInput = InputState.new({ placeholder: "输入这处位置的修改意见（回车确认 · ⌘↵ 发送给 Agent）…" });
    this.noteInput.on("focus", (_e, cx) => { this.noteFocused = true; cx.notify(); });
    this.noteInput.on("blur", (_e, cx) => { this.noteFocused = false; cx.notify(); });
    this.noteInput.on("change", (_e, cx) => {
      const pin = this.pins.find((x) => x.id === this.activePinId);
      if (pin) {
        pin.text = this.noteInput.value();
        cx.notify();
      }
    });

    if (checking()) return;
    if (this.current) this.prepareImage(this.current, cx);
    this.scanImages(cx);
  }

  scanImages(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    const src = this.source;
    const cwd = activeLocalCwd();
    const desk = `${home()}/Desktop`;

    const script =
      src === "project" && cwd
        ? `find "$1" -maxdepth 4 \\( -name .git -o -name node_modules -o -name dist -o -name build -o -name .next \\) -prune -o -type f \\( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' \\) -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -n 20`
        : `ls -t "$1"/*.png "$1"/*.jpg "$1"/*.jpeg /tmp/*.png /tmp/*.jpg 2>/dev/null | head -n 20`;

    cx.spawn(async (cx) => {
      try {
        const arg = src === "project" && cwd ? cwd : desk;
        const r = await exec("sh", ["-c", script, "scan-img", arg], { timeout: 10000 }).catch(() => null);
        const list = (r?.stdout || "")
          .split("\n")
          .map((s) => s.trim())
          .filter((p) => p && IS_IMG.test(p));
        this.images = [...new Set(list)];
        if (!this.current && this.images.length > 0) {
          this.selectImage(this.images[0], cx);
        }
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  selectImage(path, cx) {
    if (!path) return;
    this.current = path;
    this.displayRel = null;
    this.pins = [];
    this.activePinId = null;
    this.pinSeq = 1;
    this.noteInput.set_value("");
    if (!this.images.includes(path)) this.images = [path, ...this.images].slice(0, 20);
    this.prepareImage(path, cx);
    cx.notify();
  }

  /**
   * GPUI image() resolves paths relative to appHome() (~/.config/herdr-app).
   * Copy/convert the chosen image into cache/image-annotate/ and read its exact pixel size.
   */
  prepareImage(path, cx) {
    const cacheDir = `${appHome()}/cache/image-annotate`;
    const extM = String(path).match(/\.(png|jpe?g|webp|gif)$/i);
    const rawExt = extM ? extM[0].toLowerCase() : ".png";
    // Stable unique name incorporating path & mtime-safe hash
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const safeName = `${Math.abs(h).toString(36)}-${Date.now().toString(36)}${rawExt}`;
    const rel = `cache/image-annotate/${safeName}`;
    const dest = `${appHome()}/${rel}`;

    cx.spawn(async (cx) => {
      const script = [
        'SRC="$1"; DIR="$2"; DEST="$3"',
        'mkdir -p "$DIR"',
        'cp "$SRC" "$DEST" 2>/dev/null || exit 1',
        // Keep cache tidy (retain newest 15 preview files)
        'ls -t "$DIR" 2>/dev/null | tail -n +16 | while IFS= read -r f; do rm -f "$DIR/$f"; done',
        'sips -g pixelWidth -g pixelHeight "$DEST" 2>/dev/null || true',
      ].join("\n");
      const r = await exec("sh", ["-c", script, "prep-img", path, cacheDir, dest], { timeout: 10000 }).catch(() => null);
      if (this.current !== path) return;
      if (r && r.code === 0) {
        const mw = (r.stdout || "").match(/pixelWidth:\s*(\d+)/);
        const mh = (r.stdout || "").match(/pixelHeight:\s*(\d+)/);
        if (mw && mh) {
          this.natSize = { w: Math.max(1, Number(mw[1])), h: Math.max(1, Number(mh[1])) };
        }
        this.displayRel = rel;
        cx.notify();
      }
    });
  }

  computeDrawRect() {
    const availW = Math.max(160, (this.stageSize?.width || 340) - 20);
    const availH = Math.max(120, (this.stageSize?.height || 260) - 20);
    const nw = this.natSize.w || 1200;
    const nh = this.natSize.h || 750;
    const scale = Math.min(availW / nw, availH / nh, 1);
    return {
      w: Math.max(80, Math.round(nw * scale)),
      h: Math.max(60, Math.round(nh * scale)),
    };
  }

  addPinAt(e, drawW, drawH, cx) {
    const lx =
      e?.local_position?.x ??
      (e?.bounds && e?.position ? e.position.x - e.bounds.x : drawW / 2);
    const ly =
      e?.local_position?.y ??
      (e?.bounds && e?.position ? e.position.y - e.bounds.y : drawH / 2);
    const xPct = Math.max(0, Math.min(100, Math.round((lx / Math.max(1, drawW)) * 100)));
    const yPct = Math.max(0, Math.min(100, Math.round((ly / Math.max(1, drawH)) * 100)));

    const pin = {
      id: this.pinSeq++,
      xPct,
      yPct,
      text: "",
    };
    this.pins = [...this.pins, pin];
    this.activePinId = pin.id;
    this.noteInput.set_value("");
    cx.notify();
    cx.timer.after(25, () => this.noteInput.focus());
  }

  selectPin(pin, cx) {
    this.activePinId = pin.id;
    this.noteInput.set_value(pin.text || "");
    cx.notify();
    cx.timer.after(25, () => this.noteInput.focus());
  }

  removePin(id, cx) {
    this.pins = this.pins.filter((p) => p.id !== id);
    if (this.activePinId === id) {
      const next = this.pins[this.pins.length - 1] || null;
      this.activePinId = next?.id || null;
      this.noteInput.set_value(next?.text || "");
    }
    cx.notify();
  }

  buildFeedbackText() {
    if (!this.current) return "";
    const { w, h } = this.natSize;
    const lines = [
      `请查看这张图片并根据以下标注位置进行修改：`,
      `图片路径：${this.current}（${w}×${h}）`,
      "",
    ];
    if (this.pins.length === 0) {
      lines.push("（请结合图片整体 UI/内容进行分析与建议）");
    } else {
      this.pins.forEach((p, idx) => {
        const px = Math.round((p.xPct / 100) * w);
        const py = Math.round((p.yPct / 100) * h);
        const desc = (p.text || "").trim() || "请重点检查此处细节";
        lines.push(`${idx + 1}. [${regionLabel(p.xPct, p.yPct)} · x=${p.xPct}%, y=${p.yPct}% (约 ${px},${py}px)]：${desc}`);
      });
    }
    return lines.join("\n");
  }

  sendToAgent(cx) {
    if (!this.current || this.sending) return;
    const payload = this.buildFeedbackText();
    const addr = this.targetAddr || defaultAgentAddr();
    if (!addr) {
      cx.write_to_clipboard(payload);
      notify({ title: "已复制批注内容", body: "当前无活跃 Agent，已复制到剪贴板", level: "info", timeout: 2200 });
      return;
    }
    this.sending = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["send", addr, payload]).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code === 0) {
          notify({
            title: `已发送 ${this.pins.length} 条图上批注到 ${addr}`,
            body: basename(this.current),
            level: "success",
            timeout: 2400,
          });
        } else {
          notify({ title: "发送失败", body: (r.stderr || r.stdout || "").slice(0, 160), level: "error" });
        }
      } finally {
        this.sending = false;
        cx.notify();
      }
    });
  }

  openWideTab() {
    if (!this.current) return;
    run("tab.new", {
      name: `批注 · ${basename(this.current).slice(0, 14)}`,
      mod: "image-annotate",
      props: { file: this.current },
      focus: true,
    });
  }

  render() {
    const t = theme();
    const draw = this.computeDrawRect();
    const liveAgents = agents();
    if (!this.targetAddr && liveAgents.length) this.targetAddr = liveAgents[0].address;
    const activePin = this.pins.find((p) => p.id === this.activePinId) || null;

    const srcChip = (id, label) => {
      const on = this.source === id;
      return div()
        .id(`imgsrc-${id}`)
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
          if (this.source === id) return;
          this.source = id;
          this.scanImages(cx);
        })
        .child(label);
    };

    return v_flex()
      .id("image-annotate")
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
      .on_drop((e, cx) => {
        const hit = (e?.paths || []).find((p) => IS_IMG.test(p));
        if (hit) this.selectImage(hit, cx);
      })
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") {
          this.sendToAgent(cx);
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
          .children([
            svg(ICON("image")).size(14.5).flex_none().text_color(t.accent),
            div().font_semibold().child("图片批注"),
            div().flex_1(),
            srcChip("recent", "最近截图"),
            srcChip("project", "当前项目"),
            div()
              .id("img-refresh")
              .size(24)
              .flex()
              .flex_none()
              .items_center()
              .justify_center()
              .rounded(6)
              .cursor_pointer()
              .text_color(t.muted)
              .tooltip("刷新图片列表")
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.scanImages(cx))
              .child(svg(ICON("refresh")).size(13).when(this.loading, (e) => e.spin(900))),
            ...(this.current
              ? [
                  div()
                    .id("img-expand")
                    .size(24)
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .rounded(6)
                    .cursor_pointer()
                    .text_color(t.muted)
                    .tooltip("在大宽屏新标签页中精细批注")
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click(() => this.openWideTab())
                    .child(svg(ICON("external")).size(13)),
                ]
              : []),
          ])
      )
      // Horizontal image strip picker
      .when(this.images.length > 0, (el) =>
        el.child(
          h_flex()
            .flex_none()
            .px(10)
            .py(6)
            .gap(5)
            .items_center()
            .border_b_1()
            .border_color(t.border)
            .bg(t.chrome)
            .overflow_x_scroll()
            .children(
              this.images.map((p, i) => {
                const on = this.current === p;
                return div()
                  .id(`img-pick-${i}`)
                  .flex_none()
                  .h(22)
                  .px(8)
                  .flex()
                  .items_center()
                  .rounded(5)
                  .cursor_pointer()
                  .border_1()
                  .text_size(11)
                  .when(on, (e) => e.bg(t.selected).border_color(t.accent).text_color(t.foreground).font_medium())
                  .when(!on, (e) => e.bg(t.surface).border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover)))
                  .tooltip(tilde(p))
                  .on_click((_e, cx) => this.selectImage(p, cx))
                  .child(basename(p));
              })
            )
        )
      )
      // Interactive image stage (click anywhere on image to drop a numbered pin!)
      .child(
        h_flex()
          .id("img-stage")
          .flex_1()
          .min_h(160)
          .w_full()
          .items_center()
          .justify_center()
          .bg(t.canvas)
          .overflow_hidden()
          .on_size_change((size, cx) => {
            if (Math.abs((this.stageSize?.width || 0) - size.width) > 6 || Math.abs((this.stageSize?.height || 0) - size.height) > 6) {
              this.stageSize = size;
              cx.notify();
            }
          })
          .child(
            this.current && this.displayRel
              ? div()
                  .id("img-canvas-box")
                  .relative()
                  .w(draw.w)
                  .h(draw.h)
                  .rounded(6)
                  .overflow_hidden()
                  .border_1()
                  .border_color(t.border)
                  .shadow_sm()
                  .cursor_pointer()
                  .tooltip("点击图片任意位置插针添加批注")
                  .on_mouse_down("left", (e, cx) => this.addPinAt(e, draw.w, draw.h, cx))
                  .child(image(this.displayRel).w(draw.w).h(draw.h))
                  .children(
                    this.pins.map((pin, idx) => {
                      const active = pin.id === this.activePinId;
                      const px = Math.round((pin.xPct / 100) * draw.w) - 11;
                      const py = Math.round((pin.yPct / 100) * draw.h) - 11;
                      return h_flex()
                        .id(`pin-${pin.id}`)
                        .absolute()
                        .left(Math.max(0, Math.min(draw.w - 22, px)))
                        .top(Math.max(0, Math.min(draw.h - 22, py)))
                        .size(22)
                        .rounded_full()
                        .items_center()
                        .justify_center()
                        .bg(active ? t.blocked : t.accent)
                        .border_2()
                        .border_color("#ffffff")
                        .shadow_md()
                        .text_size(11)
                        .font_bold()
                        .text_color("#ffffff")
                        .cursor_pointer()
                        .on_mouse_down("left", (_e, cx) => {
                          cx.stop_propagation();
                          this.selectPin(pin, cx);
                        })
                        .child(`${idx + 1}`);
                    })
                  )
              : v_flex()
                  .items_center()
                  .gap(8)
                  .p(20)
                  .text_color(t.dim)
                  .children([
                    svg(ICON("image")).size(28).opacity(0.5),
                    div().text_size(12.5).text_color(t.muted).child("拖入任意图片，或等待发现最近截图"),
                    div().text_size(11).child("点击图片任意位置即可插针批注并一键发回 Agent"),
                  ])
          )
      )
      // Bottom pin editor & annotation list + Send to Agent bar
      .when(Boolean(this.current), (el) =>
        el.child(
          v_flex()
            .flex_none()
            .border_t_1()
            .border_color(t.border)
            .bg(t.surface)
            // Active pin note input
            .when(Boolean(activePin), (b) =>
              b.child(
                h_flex()
                  .px(10)
                  .py(8)
                  .gap(7)
                  .items_center()
                  .border_b_1()
                  .border_color(t.border)
                  .children([
                    h_flex()
                      .size(20)
                      .flex_none()
                      .rounded_full()
                      .bg(t.blocked)
                      .items_center()
                      .justify_center()
                      .text_size(10.5)
                      .font_bold()
                      .text_color("#ffffff")
                      .child(`${this.pins.findIndex((x) => x.id === activePin.id) + 1}`),
                    h_flex()
                      .flex_1()
                      .min_w(0)
                      .h(28)
                      .px(8)
                      .items_center()
                      .rounded(6)
                      .bg(t.background)
                      .border_1()
                      .border_color(this.noteFocused ? t.accent : t.input)
                      .child(Input.new(this.noteInput).flex_1().min_w(0).h_full().text_size(11.5).text_color(t.foreground)),
                  ])
              )
            )
            // Pin list summary (scrollable up to 108px)
            .when(this.pins.length > 0, (b) =>
              b.child(
                div()
                  .id("pins-list-scroll")
                  .max_h(108)
                  .w_full()
                  .overflow_y_scrollbar()
                  .border_b_1()
                  .border_color(t.border)
                  .child(
                    v_flex()
                      .w_full()
                      .p(6)
                      .gap(4)
                      .children(
                        this.pins.map((pin, idx) => {
                          const on = pin.id === this.activePinId;
                          return h_flex()
                            .id(`pin-row-${pin.id}`)
                            .px(7)
                            .py(5)
                            .gap(7)
                            .items_center()
                            .rounded(6)
                            .cursor_pointer()
                            .when(on, (e) => e.bg(t.selected))
                            .when(!on, (e) => e.hover((s) => s.bg(t.hover)))
                            .on_click((_e, cx) => this.selectPin(pin, cx))
                            .children([
                              h_flex()
                                .size(18)
                                .flex_none()
                                .rounded_full()
                                .bg(on ? t.blocked : t.accent)
                                .items_center()
                                .justify_center()
                                .text_size(10)
                                .font_bold()
                                .text_color("#ffffff")
                                .child(`${idx + 1}`),
                              div()
                                .flex_none()
                                .text_size(10.5)
                                .text_color(t.dim)
                                .child(`${regionLabel(pin.xPct, pin.yPct)} (${pin.xPct}%,${pin.yPct}%)`),
                              div()
                                .flex_1()
                                .min_w(0)
                                .truncate()
                                .text_size(11.5)
                                .text_color(pin.text ? t.foreground : t.dim)
                                .child(pin.text || "（点击填写修改意见）"),
                              div()
                                .id(`pin-del-${pin.id}`)
                                .size(18)
                                .flex()
                                .flex_none()
                                .items_center()
                                .justify_center()
                                .rounded(4)
                                .cursor_pointer()
                                .text_color(t.dim)
                                .hover((s) => s.bg(t.hover).text_color(t.blocked))
                                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                                .on_click((_e, cx) => {
                                  cx.stop_propagation();
                                  this.removePin(pin.id, cx);
                                })
                                .child(svg(ICON("x")).size(10.5)),
                            ]);
                        })
                      )
                  )
              )
            )
            // Action footer: target agent + copy + send
            .child(
              h_flex()
                .px(10)
                .py(8)
                .gap(6)
                .items_center()
                .justify_between()
                .children([
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(
                      this.pins.length
                        ? `已标 ${this.pins.length} 处 · 目标 ${this.targetAddr || "剪贴板"}`
                        : "点击上图任意位置插针标注"
                    ),
                  h_flex()
                    .gap(5)
                    .flex_none()
                    .children([
                      ...(this.pins.length > 0
                        ? [
                            div()
                              .id("pins-clear")
                              .h(26)
                              .px(8)
                              .flex()
                              .items_center()
                              .rounded(6)
                              .cursor_pointer()
                              .text_size(11)
                              .text_color(t.dim)
                              .hover((s) => s.bg(t.hover).text_color(t.blocked))
                              .on_click((_e, cx) => {
                                this.pins = [];
                                this.activePinId = null;
                                this.noteInput.set_value("");
                                cx.notify();
                              })
                              .child("清空"),
                          ]
                        : []),
                      div()
                        .id("pins-copy")
                        .size(26)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(6)
                        .border_1()
                        .border_color(t.border)
                        .bg(t.background)
                        .cursor_pointer()
                        .text_color(t.muted)
                        .tooltip("复制批注文本")
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .on_click((_e, cx) => {
                          cx.write_to_clipboard(this.buildFeedbackText());
                          notify({ title: "已复制批注内容", body: `共 ${this.pins.length} 条标注`, level: "success", timeout: 1800 });
                        })
                        .child(svg(ICON("copy")).size(12)),
                      h_flex()
                        .id("pins-send")
                        .h(26)
                        .px(10)
                        .gap(4)
                        .items_center()
                        .rounded(6)
                        .bg(t.solid)
                        .text_color(t.solid_foreground)
                        .text_size(11.5)
                        .font_medium()
                        .cursor_pointer()
                        .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
                        .on_click((_e, cx) => this.sendToAgent(cx))
                        .children([svg(ICON("send")).size(11.5), this.sending ? "发送中…" : "发给 Agent"]),
                    ]),
                ])
            )
        )
      );
  }
}
