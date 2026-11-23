// form.js — 新建 / 编辑定时任务弹窗表单。
import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import {
  agents,
  checking,
  closeOverlay,
  knownAgents,
  notify,
  pickFolder,
  props,
  shared,
  terminals,
} from "herdr";
import {
  ICON,
  activeCwd,
  describeCron,
  fmtLocalAt,
  saveJobsAtomic,
  tilde,
} from "./helpers.js";

const EVERY_PRESETS = [
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "30m", value: "30" },
  { label: "1h", value: "60" },
  { label: "6h", value: "360" },
];

const CRON_PRESETS = [
  { label: "每小时", value: "0 * * * *" },
  { label: "每天 9:00", value: "0 9 * * *" },
  { label: "工作日 18:00", value: "0 18 * * 1-5" },
  { label: "每晚 22:00", value: "0 22 * * *" },
];

function atPresetValue(kind) {
  const now = new Date();
  if (kind === "10m") return fmtLocalAt(new Date(now.getTime() + 10 * 60000));
  if (kind === "1h") return fmtLocalAt(new Date(now.getTime() + 60 * 60000));
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
  return fmtLocalAt(tomorrow);
}

function trackFocus(view, state, key) {
  state.on("focus", (_e, cx) => {
    view.focusedField = key;
    cx.notify();
  });
  state.on("blur", (_e, cx) => {
    if (view.focusedField === key) {
      view.focusedField = null;
      cx.notify();
    }
  });
  return state;
}

function cachedInstalledAgents() {
  const cached = shared("new-menu.agents")?.[""];
  if (!Array.isArray(cached)) return [];
  return cached.filter((x) => x.installed);
}

function agentGlyph(ag, size, color) {
  if (!ag?.icon) return svg(ICON("sparkles")).size(size).flex_none().text_color(color);
  return ag.tint
    ? svg(ag.icon).size(size).flex_none().text_color(color)
    : image(ag.icon).w(size).h(size).flex_none();
}

export function initForm(view, formProps, cx) {
  const job = formProps?.edit || null;
  const preset = formProps?.preset || null;
  const src = job || preset || {};
  const s = src.schedule || {};
  const a = src.action || {};

  view.editing = job;
  view.sk = s.cron ? "cron" : s.at ? "at" : "every";
  view.ak = a.type === "prompt" ? "prompt" : a.type === "spawn" ? "spawn" : "exec";
  view.formErr = null;
  view.saving = false;
  view.focusedField = null;
  view.installedAgents = cachedInstalledAgents();
  view.loadingAgents = view.installedAgents.length === 0;

  const defaultArgv =
    (a.argv || []).join(" ") ||
    (view.installedAgents[0]?.run || []).join(" ") ||
    "";

  view.f_name = trackFocus(
    view,
    InputState.new({
      value: src.name || "",
      placeholder: "例如：构建检查、日报提醒、夜间代码审查",
    }),
    "name"
  );
  view.f_every = trackFocus(
    view,
    InputState.new({
      value: s.every_min != null ? String(s.every_min) : "30",
      placeholder: "分钟数，至少 0.5（如 15）",
    }),
    "every"
  );
  view.f_cron = trackFocus(
    view,
    InputState.new({
      value: s.cron || "0 9 * * 1-5",
      placeholder: "分 时 日 月 周（如 0 9 * * 1-5）",
    }),
    "cron"
  );
  view.f_at = trackFocus(
    view,
    InputState.new({
      value: s.at ? s.at.replace("T", " ") : atPresetValue("1h"),
      placeholder: "YYYY-MM-DD HH:MM",
    }),
    "at"
  );
  view.f_cron.on("change", (_e, cx) => cx.notify());

  view.f_cmd = trackFocus(
    view,
    TextareaState.new({
      value: a.cmd || "",
      placeholder: "例如：pnpm test 或 git status -s",
      rows: 2,
    }),
    "cmd"
  );
  view.f_cwd = trackFocus(
    view,
    InputState.new({
      value: a.cwd || "",
      placeholder: "留空默认主目录 ~",
    }),
    "cwd"
  );
  view.f_timeout = trackFocus(
    view,
    InputState.new({
      value: src.timeout_sec != null ? String(src.timeout_sec) : "600",
      placeholder: "默认 600",
    }),
    "timeout"
  );

  view.f_term = trackFocus(
    view,
    InputState.new({
      value: a.terminal || "",
      placeholder: "点选上方 Agent 或手动输入终端地址（如 t15）",
    }),
    "term"
  );
  view.f_text = trackFocus(
    view,
    TextareaState.new({
      value: a.text || "",
      placeholder: "要定时发送给该 Agent 的提示词 / 指令内容…",
      rows: 3,
    }),
    "text"
  );
  view.f_ifidle = a.if !== undefined ? a.if === "idle" : true;

  view.f_argv = trackFocus(
    view,
    InputState.new({
      value: defaultArgv,
      placeholder: "点选上方 Agent 或输入命令（如 claude / codex）",
    }),
    "argv"
  );
  view.f_task = trackFocus(
    view,
    TextareaState.new({
      value: a.task || "",
      placeholder: "要让新 Agent 执行的具体任务 / Prompt，例如：检查今天的 git diff 并总结潜在风险",
      rows: 3,
    }),
    "task"
  );
  view.f_sname = trackFocus(
    view,
    InputState.new({
      value: a.name || "",
      placeholder: "留空则使用任务名称",
    }),
    "sname"
  );
  view.f_folder = trackFocus(
    view,
    InputState.new({
      value: a.folder || "",
      placeholder: "留空默认当前 Space 目录",
    }),
    "folder"
  );
  view.f_focus = Boolean(a.focus);
  view.f_notify = src.notify === "always" ? "always" : src.notify === "err" ? "err" : "off";

  if (!checking()) {
    cx.timer.after(40, () => view.f_name.focus());
    cx.spawn(async (cx) => {
      try {
        const list = await knownAgents().catch(() => []);
        const installed = (list || []).filter((x) => x.installed);
        if (installed.length > 0) {
          view.installedAgents = installed;
          if (!view.f_argv.value().trim() && installed[0]?.run?.length) {
            view.f_argv.set_value(installed[0].run.join(" "));
          }
        }
      } finally {
        view.loadingAgents = false;
        cx.notify();
      }
    });
  }
}

export function submitForm(view, cx) {
  if (view.saving) return;
  const name = view.f_name.value().trim();

  let schedule;
  if (view.sk === "every") {
    const m = parseFloat(view.f_every.value().trim());
    if (!(m >= 0.5)) {
      view.formErr = "执行间隔至少 0.5 分钟";
      return cx.notify();
    }
    schedule = { every_min: m };
  } else if (view.sk === "cron") {
    const expr = view.f_cron.value().trim();
    const info = describeCron(expr);
    if (!info.ok) {
      view.formErr = `Cron 格式错误：${info.text}`;
      return cx.notify();
    }
    schedule = { cron: expr };
  } else {
    const raw = view.f_at.value().trim();
    const iso = raw.replace(" ", "T");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) || Number.isNaN(Date.parse(iso))) {
      view.formErr = "时间格式需为 YYYY-MM-DD HH:MM";
      return cx.notify();
    }
    schedule = { at: iso.slice(0, 16) };
  }

  let action;
  let timeoutSec = null;
  if (view.ak === "exec") {
    const cmd = view.f_cmd.value().trim();
    if (!cmd) {
      view.formErr = "请填写要执行的 Shell 命令";
      return cx.notify();
    }
    action = { type: "exec", cmd };
    const cwd = view.f_cwd.value().trim();
    if (cwd) action.cwd = cwd;
    const tStr = view.f_timeout.value().trim();
    if (tStr) {
      const tNum = parseFloat(tStr);
      if (!(tNum >= 5 && tNum <= 86400)) {
        view.formErr = "超时时间需在 5 ~ 86400 秒之间";
        return cx.notify();
      }
      if (tNum !== 600) timeoutSec = tNum;
    }
  } else if (view.ak === "prompt") {
    const term = view.f_term.value().trim();
    const text = view.f_text.value().trim();
    if (!term || !text) {
      view.formErr = "请选择或填写目标终端地址和要发送的消息";
      return cx.notify();
    }
    action = { type: "prompt", terminal: term, text };
    if (view.f_ifidle) action.if = "idle";
  } else {
    const argv = view.f_argv.value().trim().split(/\s+/).filter(Boolean);
    if (!argv.length) {
      view.formErr = "请选择 Agent 或填写启动命令（如 claude / codex）";
      return cx.notify();
    }
    action = {
      type: "spawn",
      argv,
      task: view.f_task.value().trim(),
      focus: Boolean(view.f_focus),
    };
    const sname = view.f_sname.value().trim();
    const folder = view.f_folder.value().trim();
    if (sname) action.name = sname;
    if (folder) action.folder = folder;
  }

  view.formErr = null;
  view.saving = true;
  cx.notify();

  const id = view.editing?.id || `j${Date.now().toString(36)}`;
  cx.spawn(async (cx) => {
    const res = await saveJobsAtomic((jobs) => {
      const rec = {
        id,
        name: name || id,
        enabled: view.editing ? view.editing.enabled !== false : true,
        schedule,
        action,
      };
      if (timeoutSec != null) rec.timeout_sec = timeoutSec;
      if (view.f_notify !== "off") rec.notify = view.f_notify;
      const idx = jobs.findIndex((x) => x.id === id);
      if (idx >= 0) jobs[idx] = rec;
      else jobs.push(rec);
    });
    view.saving = false;
    if (res.ok) {
      closeOverlay(props().overlay);
    } else {
      view.formErr = "保存失败：jobs.json 写入冲突，请重试";
      notify({ title: "Scheduler", body: view.formErr, level: "error" });
      cx.notify();
    }
  });
}

function styledInput(state, key, view, t, invalid = false) {
  const focused = view.focusedField === key;
  return h_flex()
    .h(32)
    .px(10)
    .items_center()
    .rounded(7)
    .border_1()
    .border_color(invalid ? t.blocked : focused ? t.accent : t.input)
    .bg(t.background)
    .child(
      Input.new(state)
        .flex_1()
        .min_w(0)
        .h_full()
        .text_color(t.foreground)
        .text_size(12.5)
    );
}

function segButton(id, label, icon, active, onClick, t) {
  return h_flex()
    .id(id)
    .flex_1()
    .h(28)
    .px(10)
    .gap(6)
    .items_center()
    .justify_center()
    .rounded(6)
    .cursor_pointer()
    .text_size(12)
    .when(active, (el) => el.bg(t.surface).text_color(t.foreground).font_medium().border_1().border_color(t.border))
    .when(!active, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
    .on_click(onClick)
    .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(13).flex_none()))
    .child(label);
}

function chipButton(id, label, onClick, t, active = false) {
  return div()
    .id(id)
    .px(8)
    .h(22)
    .flex()
    .items_center()
    .rounded(5)
    .cursor_pointer()
    .text_size(11)
    .border_1()
    .when(active, (el) => el.bg(t.selected).border_color(t.accent).text_color(t.foreground).font_medium())
    .when(!active, (el) =>
      el.bg(t.surface).border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
    )
    .on_click(onClick)
    .child(label);
}

function fieldInput(label, state, key, view, t) {
  return v_flex()
    .flex_1()
    .min_w(0)
    .gap(5)
    .child(div().text_size(11.5).font_medium().text_color(t.muted).child(label))
    .child(styledInput(state, key, view, t));
}

function fieldTextarea(label, state, key, height, view, t) {
  const focused = view.focusedField === key;
  return v_flex()
    .flex_none()
    .gap(5)
    .child(div().text_size(11.5).font_medium().text_color(t.muted).child(label))
    .child(
      Textarea.new(state)
        .h(height)
        .px(10)
        .py(7)
        .rounded(7)
        .border_1()
        .border_color(focused ? t.accent : t.input)
        .bg(t.background)
        .text_color(t.foreground)
        .text_size(12.5)
    );
}

function folderRow(label, state, key, idPrefix, view, t) {
  const cwd = activeCwd();
  return v_flex()
    .flex_none()
    .gap(5)
    .child(div().text_size(11.5).font_medium().text_color(t.muted).child(label))
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(styledInput(state, key, view, t).flex_1().min_w(0))
        .when(Boolean(cwd), (el) =>
          el.child(
            div()
              .id(`${idPrefix}-cwd`)
              .h(32)
              .px(9)
              .flex()
              .items_center()
              .rounded(7)
              .border_1()
              .border_color(t.border)
              .bg(t.surface)
              .text_size(11.5)
              .text_color(t.muted)
              .cursor_pointer()
              .tooltip(`填入当前目录：${cwd}`)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                state.set_value(cwd);
                cx.notify();
              })
              .child("当前")
          )
        )
        .child(
          h_flex()
            .id(`${idPrefix}-pick`)
            .h(32)
            .px(9)
            .gap(5)
            .items_center()
            .rounded(7)
            .border_1()
            .border_color(t.border)
            .bg(t.surface)
            .text_size(11.5)
            .text_color(t.muted)
            .cursor_pointer()
            .tooltip("打开系统目录选择器")
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.spawn(async (cx) => {
                const picked = await pickFolder({ prompt: "选择工作目录" }).catch(() => null);
                if (picked) {
                  state.set_value(tilde(picked));
                  cx.notify();
                }
              });
            })
            .children([svg(ICON("folder")).size(13).flex_none(), "选择"])
        )
    );
}

function checkboxRow(id, checked, label, onToggle, t) {
  return h_flex()
    .id(id)
    .flex_none()
    .gap(8)
    .items_center()
    .cursor_pointer()
    .on_click(onToggle)
    .children([
      h_flex()
        .w(15)
        .h(15)
        .rounded(4)
        .border_1()
        .border_color(checked ? t.accent : t.input)
        .bg(checked ? t.accent : t.background)
        .items_center()
        .justify_center()
        .text_size(10)
        .text_color(t.accent_foreground)
        .child(checked ? "✓" : ""),
      div().text_size(12).text_color(t.muted).child(label),
    ]);
}

function chunk(arr, size) {
  const rows = [];
  for (let i = 0; i < arr.length; i += size) rows.push(arr.slice(i, i + size));
  return rows;
}

function renderSpawnAgentPicker(view, t) {
  const currentArgv = view.f_argv.value().trim();
  const list = view.installedAgents.slice(0, 9);
  const rows = chunk(list, 3);
  return v_flex()
    .flex_none()
    .gap(6)
    .child(div().text_size(11.5).font_medium().text_color(t.muted).child("选择 Agent"))
    .child(
      rows.length > 0
        ? v_flex()
            .flex_none()
            .gap(6)
            .children(
              rows.map((row, rIdx) =>
                h_flex()
                  .id(`ka-row-${rIdx}`)
                  .flex_none()
                  .gap(6)
                  .children([
                    ...row.map((ag) => {
                      const cmd = (ag.run || [ag.key]).join(" ");
                      const selected = currentArgv === cmd || currentArgv.startsWith(cmd + " ");
                      return h_flex()
                        .id(`pick-ka-${ag.key}`)
                        .flex_1()
                        .min_w(0)
                        .h(30)
                        .px(9)
                        .gap(6)
                        .items_center()
                        .rounded(7)
                        .cursor_pointer()
                        .border_1()
                        .when(selected, (el) =>
                          el.bg(t.selected).border_color(t.accent).text_color(t.foreground).font_medium()
                        )
                        .when(!selected, (el) =>
                          el
                            .bg(t.surface)
                            .border_color(t.border)
                            .text_color(t.muted)
                            .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        )
                        .on_click((_e, cx) => {
                          view.f_argv.set_value(cmd);
                          cx.notify();
                        })
                        .children([
                          agentGlyph(ag, 14, selected ? t.foreground : t.muted),
                          div().flex_1().min_w(0).truncate().text_size(12).child(ag.name || ag.key),
                        ]);
                    }),
                    ...Array.from({ length: 3 - row.length }, (_, k) =>
                      div().id(`ka-pad-${rIdx}-${k}`).flex_1()
                    ),
                  ])
              )
            )
        : div()
            .text_size(11.5)
            .text_color(t.dim)
            .child(view.loadingAgents ? "正在检测已安装的 Agent…" : "未检测到预置 Agent，可直接在下方填写启动命令")
    );
}

function renderPromptTargetPicker(view, t) {
  const liveAgents = agents();
  const liveTerms =
    liveAgents.length === 0
      ? terminals()
          .filter((x) => x.state === "live" && x.labels?.["herdr.sched"] !== "engine")
          .slice(0, 6)
      : [];
  const current = view.f_term.value().trim();

  if (liveAgents.length > 0) {
    const rows = chunk(liveAgents.slice(0, 6), 2);
    return v_flex()
      .flex_none()
      .gap(6)
      .child(div().text_size(11.5).font_medium().text_color(t.muted).child("选择运行中的 Agent"))
      .child(
        v_flex()
          .flex_none()
          .gap(6)
          .children(
            rows.map((row, rIdx) =>
              h_flex()
                .id(`ag-row-${rIdx}`)
                .flex_none()
                .gap(6)
                .children([
                  ...row.map((ag) => {
                    const selected = current === ag.address;
                    const statusDot = t[ag.status] || t.dim;
                    const sub = ag.space_name ? ` · ${ag.space_name}` : "";
                    return h_flex()
                      .id(`pick-ag-${ag.address}`)
                      .flex_1()
                      .min_w(0)
                      .h(28)
                      .px(9)
                      .gap(6)
                      .items_center()
                      .rounded(7)
                      .cursor_pointer()
                      .border_1()
                      .when(selected, (el) =>
                        el.bg(t.selected).border_color(t.accent).text_color(t.foreground).font_medium()
                      )
                      .when(!selected, (el) =>
                        el
                          .bg(t.surface)
                          .border_color(t.border)
                          .text_color(t.muted)
                          .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      )
                      .on_click((_e, cx) => {
                        view.f_term.set_value(ag.address);
                        cx.notify();
                      })
                      .children([
                        div().size(6).flex_none().rounded_full().bg(statusDot),
                        div()
                          .flex_1()
                          .min_w(0)
                          .truncate()
                          .text_size(11.5)
                          .child(`${ag.address} · ${ag.program?.name || ag.tab_name || "Agent"}${sub}`),
                      ]);
                  }),
                  ...Array.from({ length: 2 - row.length }, (_, k) =>
                    div().id(`ag-pad-${rIdx}-${k}`).flex_1()
                  ),
                ])
            )
          )
      );
  }
  if (liveTerms.length > 0) {
    const rows = chunk(liveTerms, 2);
    return v_flex()
      .flex_none()
      .gap(6)
      .child(div().text_size(11.5).font_medium().text_color(t.muted).child("选择运行中的终端"))
      .child(
        v_flex()
          .flex_none()
          .gap(6)
          .children(
            rows.map((row, rIdx) =>
              h_flex()
                .id(`tm-row-${rIdx}`)
                .flex_none()
                .gap(6)
                .children([
                  ...row.map((tm) =>
                    chipButton(
                      `pick-tm-${tm.address}`,
                      `${tm.address}${tm.program?.name ? ` · ${tm.program.name}` : ""}`,
                      (_e, cx) => {
                        view.f_term.set_value(tm.address);
                        cx.notify();
                      },
                      t,
                      current === tm.address
                    ).flex_1()
                  ),
                  ...Array.from({ length: 2 - row.length }, (_, k) =>
                    div().id(`tm-pad-${rIdx}-${k}`).flex_1()
                  ),
                ])
            )
          )
      );
  }
  return null;
}

export function renderForm(view, t) {
  const cronInfo = view.sk === "cron" ? describeCron(view.f_cron.value()) : null;
  const targetPicker = view.ak === "prompt" ? renderPromptTargetPicker(view, t) : null;

  return v_flex()
    .id("sched-form")
    .size_full()
    .bg(t.popover)
    .track_focus(view.handle)
    .on_key_down((e, cx) => {
      if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") {
        submitForm(view, cx);
      }
    })
    // Header (fixed)
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
          h_flex()
            .gap(8)
            .items_center()
            .children([
              h_flex()
                .w(26)
                .h(26)
                .rounded(7)
                .bg(t.raised)
                .items_center()
                .justify_center()
                .text_color(t.accent)
                .child(svg(ICON("clock")).size(14)),
              div()
                .font_semibold()
                .text_size(14.5)
                .text_color(t.foreground)
                .child(view.editing ? "编辑定时任务" : "新建定时任务"),
            ]),
          h_flex()
            .id("form-close")
            .w(26)
            .h(26)
            .rounded(6)
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => closeOverlay(props().overlay))
            .child(svg(ICON("x")).size(14)),
        ])
    )
    // Body: outer block scroll viewport + inner v_flex so children never compress/overlap
    .child(
      div()
        .id("sched-form-body")
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
            // 任务名称
            .child(v_flex().flex_none().child(fieldInput("任务名称", view.f_name, "name", view, t)))
        // 频率区块
        .child(
          v_flex()
            .flex_none()
            .gap(7)
            .child(div().text_size(11.5).font_medium().text_color(t.muted).child("触发频率"))
            .child(
              h_flex()
                .p(3)
                .gap(3)
                .rounded(8)
                .bg(t.raised)
                .children([
                  segButton("sk-every", "固定间隔", null, view.sk === "every", (_e, cx) => { view.sk = "every"; view.formErr = null; cx.notify(); }, t),
                  segButton("sk-cron", "Cron 定时", null, view.sk === "cron", (_e, cx) => { view.sk = "cron"; view.formErr = null; cx.notify(); }, t),
                  segButton("sk-at", "单次定时", null, view.sk === "at", (_e, cx) => { view.sk = "at"; view.formErr = null; cx.notify(); }, t),
                ])
            )
            .when(view.sk === "every", (el) =>
              el.children([
                styledInput(view.f_every, "every", view, t),
                h_flex()
                  .flex_none()
                  .gap(6)
                  .children(
                    EVERY_PRESETS.map((p) =>
                      chipButton(
                        `ep-${p.value}`,
                        `每 ${p.label}`,
                        (_e, cx) => {
                          view.f_every.set_value(p.value);
                          cx.notify();
                        },
                        t,
                        view.f_every.value().trim() === p.value
                      )
                    )
                  ),
              ])
            )
            .when(view.sk === "cron", (el) =>
              el.children([
                styledInput(view.f_cron, "cron", view, t, Boolean(cronInfo && !cronInfo.ok)),
                div()
                  .text_size(11)
                  .text_color(cronInfo?.ok ? t.muted : t.blocked)
                  .child(cronInfo ? cronInfo.text : ""),
                h_flex()
                  .flex_none()
                  .gap(6)
                  .children(
                    CRON_PRESETS.map((p) =>
                      chipButton(
                        `cp-${p.label}`,
                        p.label,
                        (_e, cx) => {
                          view.f_cron.set_value(p.value);
                          cx.notify();
                        },
                        t,
                        view.f_cron.value().trim() === p.value
                      )
                    )
                  ),
              ])
            )
            .when(view.sk === "at", (el) =>
              el.children([
                styledInput(view.f_at, "at", view, t),
                h_flex()
                  .flex_none()
                  .gap(6)
                  .children([
                    chipButton("at-10m", "10 分钟后", (_e, cx) => { view.f_at.set_value(atPresetValue("10m")); cx.notify(); }, t),
                    chipButton("at-1h", "1 小时后", (_e, cx) => { view.f_at.set_value(atPresetValue("1h")); cx.notify(); }, t),
                    chipButton("at-tmr", "明天 09:00", (_e, cx) => { view.f_at.set_value(atPresetValue("tmr")); cx.notify(); }, t),
                  ]),
              ])
            )
        )
        // 动作区块
        .child(
          v_flex()
            .flex_none()
            .gap(10)
            .child(div().text_size(11.5).font_medium().text_color(t.muted).child("执行动作"))
            .child(
              h_flex()
                .p(3)
                .gap(3)
                .rounded(8)
                .bg(t.raised)
                .children([
                  segButton("ak-exec", "Shell 命令", "terminal", view.ak === "exec", (_e, cx) => { view.ak = "exec"; view.formErr = null; cx.notify(); }, t),
                  segButton("ak-prompt", "给 Agent 发消息", "message", view.ak === "prompt", (_e, cx) => { view.ak = "prompt"; view.formErr = null; cx.notify(); }, t),
                  segButton("ak-spawn", "起新 Agent", "sparkles", view.ak === "spawn", (_e, cx) => { view.ak = "spawn"; view.formErr = null; cx.notify(); }, t),
                ])
            )
            .when(view.ak === "exec", (el) =>
              el.children([
                fieldTextarea("Shell 命令", view.f_cmd, "cmd", 60, view, t),
                folderRow("工作目录（可空）", view.f_cwd, "cwd", "exec-cwd", view, t),
                h_flex()
                  .flex_none()
                  .gap(10)
                  .items_center()
                  .child(
                    v_flex()
                      .w(150)
                      .gap(5)
                      .child(div().text_size(11.5).font_medium().text_color(t.muted).child("超时时间（秒）"))
                      .child(styledInput(view.f_timeout, "timeout", view, t))
                  )
                  .child(
                    div()
                      .flex_1()
                      .pt(18)
                      .text_size(11)
                      .text_color(t.dim)
                      .child("通过 /bin/sh -c 执行，输出自动保存在运行历史中")
                  ),
              ])
            )
            .when(view.ak === "prompt", (el) =>
              el.children([
                ...(targetPicker ? [targetPicker] : []),
                v_flex().flex_none().child(fieldInput("目标终端地址", view.f_term, "term", view, t)),
                fieldTextarea("要发送的消息 / 指令", view.f_text, "text", 76, view, t),
                checkboxRow(
                  "ifidle",
                  view.f_ifidle,
                  "仅在 Agent 空闲时发送（避免打断正在执行的任务）",
                  (_e, cx) => {
                    view.f_ifidle = !view.f_ifidle;
                    cx.notify();
                  },
                  t
                ),
              ])
            )
            .when(view.ak === "spawn", (el) =>
              el.children([
                renderSpawnAgentPicker(view, t),
                h_flex()
                  .flex_none()
                  .gap(10)
                  .children([
                    fieldInput("启动命令", view.f_argv, "argv", view, t),
                    fieldInput("Tab 名称（可空）", view.f_sname, "sname", view, t),
                  ]),
                fieldTextarea("任务指令 / Prompt（让 Agent 做什么）", view.f_task, "task", 78, view, t),
                folderRow("工作目录（可空）", view.f_folder, "folder", "spawn-cwd", view, t),
                checkboxRow(
                  "spawn-focus",
                  !view.f_focus,
                  "后台静默创建 Tab（不打断当前窗口焦点）",
                  (_e, cx) => {
                    view.f_focus = !view.f_focus;
                    cx.notify();
                  },
                  t
                ),
              ])
            )
        )
        // 提醒策略
        .child(
          v_flex()
            .flex_none()
            .gap(6)
            .child(div().text_size(11.5).font_medium().text_color(t.muted).child("运行提醒（Toast 通知）"))
            .child(
              h_flex()
                .p(3)
                .gap(3)
                .rounded(8)
                .bg(t.raised)
                .children([
                  segButton("nt-off", "不提醒", null, view.f_notify === "off", (_e, cx) => { view.f_notify = "off"; cx.notify(); }, t),
                  segButton("nt-err", "仅失败时", null, view.f_notify === "err", (_e, cx) => { view.f_notify = "err"; cx.notify(); }, t),
                  segButton("nt-all", "每次都提醒", null, view.f_notify === "always", (_e, cx) => { view.f_notify = "always"; cx.notify(); }, t),
                ])
            )
        )
        )
    )
    // Footer (fixed)
    .child(
      h_flex()
        .flex_none()
        .px(18)
        .py(12)
        .items_center()
        .justify_between()
        .gap(10)
        .border_t_1()
        .border_color(t.border)
        .children([
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(11.5)
            .text_color(view.formErr ? t.blocked : t.dim)
            .child(view.formErr || "⌘Enter 快速保存 · Esc 取消"),
          h_flex()
            .gap(8)
            .flex_none()
            .children([
              div()
                .id("form-cancel")
                .px(12)
                .h(30)
                .flex()
                .items_center()
                .rounded(7)
                .text_size(12)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click(() => closeOverlay(props().overlay))
                .child("取消"),
              div()
                .id("form-save")
                .px(16)
                .h(30)
                .flex()
                .items_center()
                .rounded(7)
                .bg(t.solid)
                .text_color(t.solid_foreground)
                .text_size(12)
                .font_medium()
                .cursor_pointer()
                .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
                .on_click((_e, cx) => submitForm(view, cx))
                .child(view.saving ? "保存中…" : view.editing ? "保存修改" : "创建任务"),
            ]),
        ])
    );
}
