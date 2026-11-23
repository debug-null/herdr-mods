// form.js — Linear 风格的极简「新建/编辑卡片」弹窗 & 「派给 Agent」启动弹窗。
// 聚焦写作体验：顶部项目/状态面包屑 → 大号无框标题 → 宽敞多行描述 → 紧凑精致属性区 → 闭环底部动作栏。
import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import {
  appHome,
  checking,
  closeOverlay,
  knownAgents,
  notify,
  openOverlay,
  pickFolder,
  props,
  readTextFile,
  run,
  shared,
  spaces,
  writeTextFile,
} from "herdr";
import {
  COLUMNS,
  ICON,
  PRIORITIES,
  activeAgentProjects,
  ago,
  baseName,
  projectColor,
  projectKey,
  projectLabel,
  saveTasksAtomic,
  tilde,
  uid,
} from "./helpers.js";

const QUICK_TAGS = ["feature", "bug", "ui", "perf", "refactor"];

function chunk(arr, size) {
  const rows = [];
  for (let i = 0; i < arr.length; i += size) rows.push(arr.slice(i, i + size));
  return rows;
}

function trackFocus(view, state, key) {
  state.on("focus", (_e, cx) => { view.focusedField = key; cx.notify(); });
  state.on("blur", (_e, cx) => { if (view.focusedField === key) { view.focusedField = null; cx.notify(); } });
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

function parseTags(raw) {
  return String(raw || "")
    .split(/[,，\s]+/)
    .map((s) => s.replace(/^#/, "").trim())
    .filter(Boolean);
}

// ============================================================================
// 1. 新建 / 编辑卡片弹窗（Linear 极简写卡体验）
// ============================================================================

export function initCardForm(view, formProps, cx) {
  const edit = formProps?.edit || null;
  const defaultCol = formProps?.column || "ideas";
  const agentProjects = activeAgentProjects();

  let defaultProj = null;
  if (edit) {
    defaultProj = edit.project || null;
  } else if (formProps?.project !== undefined) {
    defaultProj = formProps.project;
  } else if (agentProjects.length > 0) {
    defaultProj = agentProjects[0];
  }

  view.editing = edit;
  view.col = edit?.column || defaultCol;
  view.priority = edit?.priority || "p2";
  view.project = defaultProj
    ? { name: defaultProj.name, path: defaultProj.path || null, machine: defaultProj.machine || null }
    : null;
  view.agentProjects = agentProjects;
  view.customProject =
    view.project && !agentProjects.some((p) => projectKey(p) === projectKey(view.project))
      ? view.project
      : null;
  view.focusedField = null;
  view.formErr = null;
  view.saving = false;
  view.confirmDel = false;

  view.f_title = trackFocus(
    view,
    InputState.new({
      value: edit?.title || "",
      placeholder: "卡片标题（例如：回放导出改成 WebWorker）",
    }),
    "title"
  );
  view.f_notes = trackFocus(
    view,
    TextareaState.new({
      value: edit?.notes || "",
      placeholder: "写下背景想法、实现细节或验收标准…\n以后点「派给 Agent」时，这段内容会自动作为初始 Prompt 发给 Agent。",
      rows: 5,
    }),
    "notes"
  );
  view.f_tags = trackFocus(
    view,
    InputState.new({
      value: (edit?.tags || []).join(", "),
      placeholder: "自定义标签，逗号分隔…",
    }),
    "tags"
  );
  view.f_tags.on("change", (_e, cx) => cx.notify());

  if (!checking()) {
    cx.timer.after(35, () => view.f_title.focus());
  }
}

export function submitCardForm(view, cx, { thenDispatch = false } = {}) {
  if (view.saving) return;
  const title = view.f_title.value().trim();
  if (!title) {
    view.formErr = "请先填写卡片标题";
    return cx.notify();
  }
  const notes = view.f_notes.value().trim();
  const tags = [...new Set(parseTags(view.f_tags.value()))];

  view.formErr = null;
  view.saving = true;
  cx.notify();

  const now = Date.now();
  const id = view.editing?.id || uid();
  let savedRec = null;

  cx.spawn(async (cx) => {
    const res = await saveTasksAtomic((tasks) => {
      const idx = tasks.findIndex((x) => x.id === id);
      const prev = idx >= 0 ? tasks[idx] : null;
      savedRec = {
        ...(prev || {}),
        id,
        title,
        notes,
        column: view.col,
        priority: view.priority,
        project: view.project,
        tags,
        createdAt: prev?.createdAt || now,
        updatedAt: now,
        doneAt: view.col === "done" ? (prev?.doneAt || now) : null,
      };
      if (idx >= 0) tasks[idx] = savedRec;
      else tasks.unshift(savedRec);
    });
    view.saving = false;
    if (res.ok) {
      closeOverlay(props().overlay);
      if (thenDispatch && savedRec) {
        openOverlay({
          mod: "board",
          props: { dispatch: { task: savedRec } },
          kind: "dialog",
          width: 560,
          height: 540,
        });
      }
    } else {
      view.formErr = "保存失败：写入冲突，请重试";
      cx.notify();
    }
  });
}

function deleteEditingCard(view, cx) {
  if (!view.editing?.id) return;
  const id = view.editing.id;
  cx.spawn(async () => {
    await saveTasksAtomic((tasks) => {
      const i = tasks.findIndex((x) => x.id === id);
      if (i >= 0) tasks.splice(i, 1);
    });
    closeOverlay(props().overlay);
  });
}

function toggleQuickTag(view, tag, cx) {
  const cur = parseTags(view.f_tags.value());
  const exists = cur.includes(tag);
  const next = exists ? cur.filter((x) => x !== tag) : [...cur, tag];
  view.f_tags.set_value(next.join(", "));
  cx.notify();
}

export function renderCardForm(view, t) {
  const activeCol = COLUMNS.find((c) => c.id === view.col) || COLUMNS[0];
  const curProjKey = view.project ? projectKey(view.project) : "global";
  const projDot = view.project ? projectColor(curProjKey) : t.dim;
  const activeTags = new Set(parseTags(view.f_tags.value()));

  const projChoices = [];
  const seen = new Set();
  for (const p of view.agentProjects || []) {
    const k = projectKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    projChoices.push(p);
  }
  if (view.customProject && !seen.has(projectKey(view.customProject))) {
    projChoices.push(view.customProject);
  }
  projChoices.push({ _global: true, name: "不绑定", path: null, machine: null });

  const canDispatch = view.col === "ideas" || view.col === "todo";

  return v_flex()
    .id("board-card-form")
    .size_full()
    .bg(t.popover)
    .track_focus(view.handle)
    .on_key_down((e, cx) => {
      if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") submitCardForm(view, cx);
    })
    // Minimal breadcrumb top bar (Linear style)
    .child(
      h_flex()
        .flex_none()
        .px(20)
        .pt(14)
        .pb(10)
        .items_center()
        .justify_between()
        .children([
          h_flex()
            .gap(7)
            .items_center()
            .children([
              h_flex()
                .h(22)
                .px(8)
                .gap(5)
                .items_center()
                .rounded(6)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .children([
                  div().size(6.5).rounded_full().bg(projDot),
                  div()
                    .text_size(11.5)
                    .font_medium()
                    .text_color(view.project ? t.foreground : t.muted)
                    .child(view.project ? projectLabel(view.project) : "不绑定项目"),
                ]),
              div().text_size(11.5).text_color(t.dim).child("/"),
              h_flex()
                .h(22)
                .px(8)
                .gap(5)
                .items_center()
                .rounded(6)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .children([
                  svg(ICON(activeCol.icon)).size(11.5).text_color(t[activeCol.tone] || t.muted),
                  div().text_size(11.5).text_color(t.muted).child(activeCol.label),
                ]),
              ...(view.editing?.createdAt
                ? [
                    div()
                      .pl(4)
                      .text_size(11)
                      .text_color(t.dim)
                      .child(`创建于 ${ago(view.editing.createdAt)}`),
                  ]
                : []),
            ]),
          h_flex()
            .id("bf-close")
            .w(26)
            .h(26)
            .rounded(6)
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => closeOverlay(props().overlay))
            .child(svg(ICON("x")).size(14)),
        ])
    )
    // Scrollable writing + properties body
    .child(
      div()
        .id("bf-scroll")
        .flex_1()
        .min_h(0)
        .w_full()
        .overflow_y_scrollbar()
        .child(
          v_flex()
            .w_full()
            .px(20)
            .pb(16)
            .gap(12)
            // 1. Borderless large title input (hero focus)
            .child(
              h_flex()
                .flex_none()
                .h(38)
                .px(2)
                .items_center()
                .border_b_1()
                .border_color(view.focusedField === "title" ? t.accent : t.border)
                .child(
                  Input.new(view.f_title)
                    .flex_1()
                    .min_w(0)
                    .h_full()
                    .font_semibold()
                    .text_size(16)
                    .text_color(t.foreground)
                )
            )
            // 2. Spacious clean description textarea
            .child(
              Textarea.new(view.f_notes)
                .flex_none()
                .h(124)
                .px(12)
                .py(9)
                .rounded(9)
                .border_1()
                .border_color(view.focusedField === "notes" ? t.accent : t.border)
                .bg(t.background)
                .text_color(t.foreground)
                .text_size(12.5)
            )
            // 3. Compact unified Properties Card (Project / Stage / Priority / Tags)
            .child(
              v_flex()
                .flex_none()
                .rounded(10)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .overflow_hidden()
                // Row A: Project
                .child(
                  v_flex()
                    .px(12)
                    .py(10)
                    .gap(7)
                    .border_b_1()
                    .border_color(t.border)
                    .child(
                      h_flex()
                        .items_center()
                        .justify_between()
                        .gap(8)
                        .children([
                          div().text_size(11.5).font_medium().text_color(t.muted).child("关联项目"),
                          h_flex()
                            .id("bf-pick-dir")
                            .h(23)
                            .px(8)
                            .gap(4)
                            .items_center()
                            .rounded(6)
                            .bg(t.background)
                            .border_1()
                            .border_color(t.border)
                            .text_size(11)
                            .text_color(t.foreground)
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover).border_color(t.accent))
                            .on_click((_e, cx) => {
                              cx.spawn(async (cx) => {
                                const picked = await pickFolder({ prompt: "选择关联项目目录" }).catch(() => null);
                                if (picked) {
                                  const proj = { name: baseName(picked), path: picked, machine: null };
                                  view.project = proj;
                                  view.customProject = proj;
                                  cx.notify();
                                }
                              });
                            })
                            .children([svg(ICON("folder")).size(11.5).text_color(t.accent), "选择本地目录…"]),
                        ])
                    )
                    .child(
                      h_flex()
                        .gap(6)
                        .overflow_x_scroll()
                        .children(
                          projChoices.map((p, i) => {
                            const isGlobal = Boolean(p._global);
                            const k = isGlobal ? "global" : projectKey(p);
                            const selected = curProjKey === k;
                            const dot = isGlobal ? t.dim : projectColor(k);
                            return h_flex()
                              .id(`bf-proj-${i}`)
                              .flex_none()
                              .h(26)
                              .px(9)
                              .gap(6)
                              .items_center()
                              .rounded(6)
                              .cursor_pointer()
                              .border_1()
                              .when(selected, (el) =>
                                el.bg(t.selected).border_color(t.accent).text_color(t.foreground).font_medium()
                              )
                              .when(!selected, (el) =>
                                el.bg(t.background).border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
                              )
                              .on_click((_e, cx) => {
                                view.project = isGlobal
                                  ? null
                                  : { name: p.name, path: p.path || null, machine: p.machine || null };
                                cx.notify();
                              })
                              .children([
                                div().size(6.5).flex_none().rounded_full().bg(dot),
                                div().text_size(11.5).child(isGlobal ? p.name : projectLabel(p)),
                              ]);
                          })
                        )
                    )
                    .when(Boolean(view.project?.path), (el) =>
                      el.child(
                        div().text_size(10.5).text_color(t.dim).truncate().child(tilde(view.project.path))
                      )
                    )
                )
                // Row B: Stage (Column)
                .child(
                  h_flex()
                    .px(12)
                    .py(9)
                    .gap(10)
                    .items_center()
                    .border_b_1()
                    .border_color(t.border)
                    .children([
                      div().w(52).flex_none().text_size(11.5).font_medium().text_color(t.muted).child("阶段"),
                      h_flex()
                        .flex_1()
                        .p(2)
                        .gap(2)
                        .rounded(7)
                        .bg(t.raised)
                        .children(
                          COLUMNS.map((c) => {
                            const on = view.col === c.id;
                            return h_flex()
                              .id(`bf-col-${c.id}`)
                              .flex_1()
                              .h(24)
                              .gap(4)
                              .items_center()
                              .justify_center()
                              .rounded(5)
                              .cursor_pointer()
                              .text_size(11)
                              .when(on, (el) => el.bg(t.surface).text_color(t.foreground).font_medium().shadow_xs())
                              .when(!on, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
                              .on_click((_e, cx) => { view.col = c.id; cx.notify(); })
                              .children([
                                div().size(5.5).rounded_full().bg(t[c.tone] || t.dim),
                                c.label,
                              ]);
                          })
                        ),
                    ])
                )
                // Row C: Priority
                .child(
                  h_flex()
                    .px(12)
                    .py(9)
                    .gap(10)
                    .items_center()
                    .border_b_1()
                    .border_color(t.border)
                    .children([
                      div().w(52).flex_none().text_size(11.5).font_medium().text_color(t.muted).child("优先级"),
                      h_flex()
                        .gap(6)
                        .children(
                          PRIORITIES.map((pr) => {
                            const on = view.priority === pr.id;
                            const toneC = t[pr.tone] || t.muted;
                            return h_flex()
                              .id(`bf-prio-${pr.id}`)
                              .h(24)
                              .px(10)
                              .gap(5)
                              .items_center()
                              .rounded(6)
                              .cursor_pointer()
                              .border_1()
                              .text_size(11.5)
                              .when(on, (el) => el.bg(t.selected).border_color(t.accent).text_color(t.foreground).font_medium())
                              .when(!on, (el) => el.bg(t.background).border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
                              .on_click((_e, cx) => { view.priority = pr.id; cx.notify(); })
                              .children([
                                div().size(6).rounded_full().bg(toneC),
                                `${pr.short} ${pr.label}`,
                              ]);
                          })
                        ),
                    ])
                )
                // Row D: Tags (Quick chips + custom input)
                .child(
                  v_flex()
                    .px(12)
                    .py(9)
                    .gap(7)
                    .child(
                      h_flex()
                        .gap(10)
                        .items_center()
                        .children([
                          div().w(52).flex_none().text_size(11.5).font_medium().text_color(t.muted).child("标签"),
                          h_flex()
                            .flex_1()
                            .min_w(0)
                            .gap(5)
                            .overflow_x_scroll()
                            .children(
                              QUICK_TAGS.map((tag) => {
                                const on = activeTags.has(tag);
                                return div()
                                  .id(`bf-qtag-${tag}`)
                                  .flex_none()
                                  .h(22)
                                  .px(8)
                                  .flex()
                                  .items_center()
                                  .rounded(5)
                                  .cursor_pointer()
                                  .border_1()
                                  .text_size(11)
                                  .when(on, (el) => el.bg(t.selected).border_color(t.accent).text_color(t.foreground).font_medium())
                                  .when(!on, (el) => el.bg(t.background).border_color(t.border).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
                                  .on_click((_e, cx) => toggleQuickTag(view, tag, cx))
                                  .child(`#${tag}`);
                              })
                            ),
                        ])
                    )
                    .child(
                      h_flex()
                        .pl(62)
                        .child(
                          h_flex()
                            .flex_1()
                            .h(28)
                            .px(9)
                            .items_center()
                            .rounded(6)
                            .bg(t.background)
                            .border_1()
                            .border_color(view.focusedField === "tags" ? t.accent : t.border)
                            .child(Input.new(view.f_tags).flex_1().min_w(0).h_full().text_size(11.5).text_color(t.foreground))
                        )
                    )
                )
            )
        )
    )
    // Footer action bar
    .child(
      h_flex()
        .flex_none()
        .px(20)
        .py(12)
        .items_center()
        .justify_between()
        .gap(10)
        .border_t_1()
        .border_color(t.border)
        .children([
          view.editing
            ? h_flex()
                .id("bf-del")
                .h(28)
                .px(9)
                .gap(5)
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .text_size(11.5)
                .when(view.confirmDel, (el) => el.bg(t.blocked).text_color("#ffffff").font_medium())
                .when(!view.confirmDel, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.blocked)))
                .on_click((_e, cx) => {
                  if (view.confirmDel) return deleteEditingCard(view, cx);
                  view.confirmDel = true;
                  cx.notify();
                })
                .children([svg(ICON("trash")).size(12.5), view.confirmDel ? "确认删除" : "删除"])
            : div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11.5)
                .text_color(view.formErr ? t.blocked : t.dim)
                .child(view.formErr || "⌘Enter 保存 · Esc 取消"),
          h_flex()
            .gap(8)
            .flex_none()
            .children([
              ...(canDispatch
                ? [
                    h_flex()
                      .id("bf-save-dispatch")
                      .h(30)
                      .px(11)
                      .gap(5)
                      .items_center()
                      .rounded(7)
                      .bg(t.surface)
                      .border_1()
                      .border_color(t.border)
                      .text_size(12)
                      .text_color(t.foreground)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover).border_color(t.accent))
                      .on_click((_e, cx) => submitCardForm(view, cx, { thenDispatch: true }))
                      .children([svg(ICON("sparkles")).size(12).text_color(t.accent), "保存并派给 Agent"]),
                  ]
                : []),
              div()
                .id("bf-cancel")
                .px(11)
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
                .id("bf-save")
                .px(15)
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
                .on_click((_e, cx) => submitCardForm(view, cx))
                .child(view.saving ? "保存中…" : view.editing ? "保存" : "创建卡片"),
            ]),
        ])
    );
}

// ============================================================================
// 2. 「派给 Agent」启动弹窗（支持 立即派发 / 定时派发 联动 Scheduler）
// ============================================================================

function fmtLocalAt(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dispatchTimePreset(kind) {
  const now = new Date();
  if (kind === "30m") return fmtLocalAt(new Date(now.getTime() + 30 * 60000));
  if (kind === "1h") return fmtLocalAt(new Date(now.getTime() + 60 * 60000));
  if (kind === "22") {
    const tonight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 22, 0);
    if (tonight.getTime() > now.getTime() + 5 * 60000) return fmtLocalAt(tonight);
    return fmtLocalAt(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 22, 0));
  }
  return fmtLocalAt(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0));
}

async function upsertSchedJob(job) {
  const path = `${appHome()}/sched/jobs.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const old = await readTextFile(path).catch(() => null);
    let data;
    try {
      data = JSON.parse(old || '{"jobs":[]}');
      if (!Array.isArray(data.jobs)) data.jobs = [];
    } catch {
      data = { jobs: [] };
    }
    const idx = data.jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) data.jobs[idx] = job;
    else data.jobs.push(job);
    const next = JSON.stringify(data, null, 2) + "\n";
    try {
      await writeTextFile(path, next, old);
      return true;
    } catch {}
  }
  return false;
}

export function initDispatchForm(view, dispatchProps, cx) {
  const task = dispatchProps?.task;
  view.dispatchTask = task;
  view.installedAgents = cachedInstalledAgents();
  view.loadingAgents = view.installedAgents.length === 0;
  view.focusedField = null;
  view.focusNewTab = true;
  view.dispatching = false;
  view.dispatchMode = task?.scheduled?.at ? "later" : "now";
  view.dispatchErr = null;

  const first = view.installedAgents[0];
  view.selectedAgentKey = first?.key || "";
  view.selectedArgv = first?.run || ["claude"];
  view.selectedAgentName = first?.name || "Claude";

  const defaultPrompt = task?.notes
    ? `${task.title}\n\n${task.notes}`
    : (task?.title || "");

  view.f_prompt = trackFocus(
    view,
    TextareaState.new({
      value: defaultPrompt,
      placeholder: "发送给 Agent 的初始任务 Prompt…",
      rows: 5,
    }),
    "prompt"
  );
  view.f_when = trackFocus(
    view,
    InputState.new({
      value: task?.scheduled?.at ? task.scheduled.at.replace("T", " ") : dispatchTimePreset("22"),
      placeholder: "YYYY-MM-DD HH:MM",
    }),
    "when"
  );

  if (!checking()) {
    cx.spawn(async (cx) => {
      try {
        const list = await knownAgents().catch(() => []);
        const installed = (list || []).filter((x) => x.installed);
        if (installed.length > 0) {
          view.installedAgents = installed;
          if (!view.selectedAgentKey) {
            view.selectedAgentKey = installed[0].key;
            view.selectedArgv = installed[0].run || [installed[0].key];
            view.selectedAgentName = installed[0].name || installed[0].key;
          }
        }
      } finally {
        view.loadingAgents = false;
        cx.notify();
      }
    });
  }
}

export function submitDispatch(view, cx) {
  if (view.dispatching || !view.dispatchTask) return;
  const task = view.dispatchTask;
  const promptText = view.f_prompt.value().trim();
  const argv = view.selectedArgv?.length ? view.selectedArgv : ["claude"];
  const proj = task.project;

  // Mode B: Scheduled dispatch via Scheduler (sched/jobs.json)
  if (view.dispatchMode === "later") {
    const raw = view.f_when.value().trim();
    const iso = raw.replace(" ", "T");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) || Number.isNaN(Date.parse(iso))) {
      view.dispatchErr = "时间格式需为 YYYY-MM-DD HH:MM";
      return cx.notify();
    }
    const atIso = iso.slice(0, 16);
    view.dispatchErr = null;
    view.dispatching = true;
    cx.notify();

    const jobId = `board-${task.id}`;
    const action = {
      type: "spawn",
      argv,
      task: promptText,
      name: task.title.slice(0, 24),
      focus: false,
    };
    if (proj?.path) action.folder = proj.path;

    const jobRec = {
      id: jobId,
      name: `看板 · ${task.title.slice(0, 26)}`,
      enabled: true,
      schedule: { at: atIso },
      action,
      notify: "always",
    };

    cx.spawn(async (cx) => {
      const ok = await upsertSchedJob(jobRec);
      if (!ok) {
        view.dispatching = false;
        view.dispatchErr = "写入定时任务失败，请重试";
        return cx.notify();
      }
      const now = Date.now();
      await saveTasksAtomic((tasks) => {
        const hit = tasks.find((x) => x.id === task.id);
        if (hit) {
          hit.updatedAt = now;
          hit.scheduled = {
            jobId,
            at: atIso,
            program: view.selectedAgentName,
          };
        }
      });
      notify({
        title: "已预约定时派发",
        body: `${atIso.replace("T", " ")} 将由 ${view.selectedAgentName} 启动「${task.title}」`,
        level: "success",
        timeout: 3000,
      });
      closeOverlay(props().overlay);
    });
    return;
  }

  // Mode A: Immediate dispatch
  view.dispatchErr = null;
  view.dispatching = true;
  cx.notify();

  const allSpaces = spaces();
  let targetSpace = null;
  if (proj) {
    targetSpace = allSpaces.find(
      (s) =>
        (s.machine || null) === (proj.machine || null) &&
        ((proj.path && s.folder && s.folder.replace(/\/+$/, "") === proj.path.replace(/\/+$/, "")) ||
          (proj.name && s.name === proj.name))
    );
  }

  const tabArgs = {
    name: task.title.slice(0, 24),
    argv,
    focus: Boolean(view.focusNewTab),
  };
  if (promptText) tabArgs.task = promptText;
  if (targetSpace) tabArgs.space = targetSpace.id;
  if (proj?.path) tabArgs.folder = proj.path;

  if (targetSpace && view.focusNewTab && !targetSpace.active) {
    run("space.select", { id: targetSpace.id });
  }
  run("tab.new", tabArgs);

  const now = Date.now();
  cx.spawn(async () => {
    await saveTasksAtomic((tasks) => {
      const hit = tasks.find((x) => x.id === task.id);
      if (hit) {
        hit.column = "doing";
        hit.updatedAt = now;
        delete hit.scheduled;
        hit.agent = {
          program: view.selectedAgentName,
          argv,
          startedAt: now,
        };
      }
    });
    notify({
      title: "已派给 Agent",
      body: `${view.selectedAgentName} 开始处理「${task.title}」`,
      level: "success",
      timeout: 2400,
    });
    closeOverlay(props().overlay);
  });
}

export function renderDispatchForm(view, t) {
  const task = view.dispatchTask || {};
  const list = view.installedAgents.slice(0, 9);
  const rows = chunk(list, 3);
  const proj = task.project;
  const isLater = view.dispatchMode === "later";

  return v_flex()
    .id("board-dispatch-form")
    .size_full()
    .bg(t.popover)
    .track_focus(view.handle)
    .on_key_down((e, cx) => {
      if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") submitDispatch(view, cx);
    })
    .child(
      h_flex()
        .flex_none()
        .px(20)
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
                .child(svg(ICON(isLater ? "clock" : "sparkles")).size(14)),
              div()
                .font_semibold()
                .text_size(14.5)
                .text_color(t.foreground)
                .child(isLater ? "定时派给 Agent（联动 Scheduler）" : "派给 Agent 开始开发"),
            ]),
          h_flex()
            .id("dp-close")
            .w(26)
            .h(26)
            .rounded(6)
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => closeOverlay(props().overlay))
            .child(svg(ICON("x")).size(14)),
        ])
    )
    .child(
      div()
        .id("dp-scroll")
        .flex_1()
        .min_h(0)
        .w_full()
        .overflow_y_scrollbar()
        .child(
          v_flex()
            .w_full()
            .px(20)
            .py(14)
            .gap(12)
            // Task summary
            .child(
              v_flex()
                .flex_none()
                .px(12)
                .py(10)
                .gap(5)
                .rounded(9)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .children([
                  div().font_semibold().text_size(13.5).text_color(t.foreground).child(task.title || ""),
                  h_flex()
                    .gap(6)
                    .items_center()
                    .children([
                      div().size(7).rounded_full().bg(proj ? projectColor(projectKey(proj)) : t.dim),
                      div()
                        .text_size(11)
                        .text_color(t.muted)
                        .child(proj ? `${projectLabel(proj)}${proj.path ? ` · ${tilde(proj.path)}` : ""}` : "未绑定项目（在当前目录启动）"),
                    ]),
                ])
            )
            // Mode switch: Immediate vs Scheduled
            .child(
              h_flex()
                .flex_none()
                .p(3)
                .gap(3)
                .rounded(8)
                .bg(t.raised)
                .children([
                  h_flex()
                    .id("dp-mode-now")
                    .flex_1()
                    .h(28)
                    .gap(6)
                    .items_center()
                    .justify_center()
                    .rounded(6)
                    .cursor_pointer()
                    .text_size(12)
                    .when(!isLater, (el) => el.bg(t.surface).text_color(t.foreground).font_medium().border_1().border_color(t.border))
                    .when(isLater, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
                    .on_click((_e, cx) => { view.dispatchMode = "now"; view.dispatchErr = null; cx.notify(); })
                    .children([svg(ICON("sparkles")).size(12.5), "立即派发"]),
                  h_flex()
                    .id("dp-mode-later")
                    .flex_1()
                    .h(28)
                    .gap(6)
                    .items_center()
                    .justify_center()
                    .rounded(6)
                    .cursor_pointer()
                    .text_size(12)
                    .when(isLater, (el) => el.bg(t.surface).text_color(t.foreground).font_medium().border_1().border_color(t.border))
                    .when(!isLater, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
                    .on_click((_e, cx) => { view.dispatchMode = "later"; view.dispatchErr = null; cx.notify(); })
                    .children([svg(ICON("clock")).size(12.5), "定时派发"]),
                ])
            )
            // Scheduled time picker (when later)
            .when(isLater, (el) =>
              el.child(
                v_flex()
                  .flex_none()
                  .p(11)
                  .gap(8)
                  .rounded(9)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .children([
                    div().text_size(11.5).font_medium().text_color(t.muted).child("预约启动时间（到点由 Scheduler 后台自动拉起）"),
                    h_flex()
                      .h(32)
                      .px(10)
                      .items_center()
                      .rounded(7)
                      .bg(t.background)
                      .border_1()
                      .border_color(view.focusedField === "when" ? t.accent : t.input)
                      .child(Input.new(view.f_when).flex_1().min_w(0).h_full().text_size(12.5).text_color(t.foreground)),
                    h_flex()
                      .gap(6)
                      .children([
                        ...[
                          { id: "30m", label: "30 分钟后" },
                          { id: "1h", label: "1 小时后" },
                          { id: "22", label: "今晚 22:00" },
                          { id: "tmr9", label: "明早 09:00" },
                        ].map((p) =>
                          div()
                            .id(`dp-t-${p.id}`)
                            .h(22)
                            .px(8)
                            .flex()
                            .items_center()
                            .rounded(5)
                            .bg(t.background)
                            .border_1()
                            .border_color(t.border)
                            .text_size(11)
                            .text_color(t.muted)
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover).text_color(t.foreground))
                            .on_click((_e, cx) => {
                              view.f_when.set_value(dispatchTimePreset(p.id));
                              cx.notify();
                            })
                            .child(p.label)
                        ),
                      ]),
                  ])
              )
            )
            // Agent picker
            .child(
              v_flex()
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
                              .id(`dp-arow-${rIdx}`)
                              .flex_none()
                              .gap(6)
                              .children([
                                ...row.map((ag) => {
                                  const selected = view.selectedAgentKey === ag.key;
                                  return h_flex()
                                    .id(`dp-ag-${ag.key}`)
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
                                      el.bg(t.surface).border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
                                    )
                                    .on_click((_e, cx) => {
                                      view.selectedAgentKey = ag.key;
                                      view.selectedArgv = ag.run || [ag.key];
                                      view.selectedAgentName = ag.name || ag.key;
                                      cx.notify();
                                    })
                                    .children([
                                      agentGlyph(ag, 14, selected ? t.foreground : t.muted),
                                      div().flex_1().min_w(0).truncate().text_size(12).child(ag.name || ag.key),
                                    ]);
                                }),
                                ...Array.from({ length: 3 - row.length }, (_, k) =>
                                  div().id(`dp-apad-${rIdx}-${k}`).flex_1()
                                ),
                              ])
                          )
                        )
                    : div().text_size(11.5).text_color(t.dim).child(view.loadingAgents ? "正在检测已安装的 Agent…" : "默认使用 claude")
                )
            )
            // Initial prompt
            .child(
              v_flex()
                .flex_none()
                .gap(5)
                .child(div().text_size(11.5).font_medium().text_color(t.muted).child("初始任务指令"))
                .child(
                  Textarea.new(view.f_prompt)
                    .h(105)
                    .px(11)
                    .py(8)
                    .rounded(8)
                    .border_1()
                    .border_color(view.focusedField === "prompt" ? t.accent : t.border)
                    .bg(t.background)
                    .text_color(t.foreground)
                    .text_size(12.5)
                )
            )
            .when(!isLater, (el) =>
              el.child(
                h_flex()
                  .id("dp-focus-toggle")
                  .flex_none()
                  .gap(8)
                  .items_center()
                  .cursor_pointer()
                  .on_click((_e, cx) => { view.focusNewTab = !view.focusNewTab; cx.notify(); })
                  .children([
                    h_flex()
                      .w(15)
                      .h(15)
                      .rounded(4)
                      .border_1()
                      .border_color(view.focusNewTab ? t.accent : t.input)
                      .bg(view.focusNewTab ? t.accent : t.background)
                      .items_center()
                      .justify_center()
                      .text_size(10)
                      .text_color(t.accent_foreground)
                      .child(view.focusNewTab ? "✓" : ""),
                    div().text_size(12).text_color(t.muted).child("派发后立即切换到新开的 Agent 标签页"),
                  ])
              )
            )
        )
    )
    .child(
      h_flex()
        .flex_none()
        .px(20)
        .py(12)
        .items_center()
        .justify_between()
        .gap(8)
        .border_t_1()
        .border_color(t.border)
        .children([
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(11)
            .text_color(view.dispatchErr ? t.blocked : t.dim)
            .child(
              view.dispatchErr ||
                (isLater ? "将自动写入 Scheduler 一次性定时任务并开启通知" : "派发后卡片自动移入「进行中」列")
            ),
          h_flex()
            .gap(8)
            .flex_none()
            .children([
              div()
                .id("dp-cancel")
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
              h_flex()
                .id("dp-go")
                .px(14)
                .h(30)
                .gap(5)
                .items_center()
                .rounded(7)
                .bg(t.solid)
                .text_color(t.solid_foreground)
                .text_size(12)
                .font_medium()
                .cursor_pointer()
                .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
                .on_click((_e, cx) => submitDispatch(view, cx))
                .children([
                  svg(ICON(isLater ? "clock" : "play")).size(11.5),
                  view.dispatching ? "处理中…" : isLater ? "预约定时派发" : "立即派发",
                ]),
            ]),
        ])
    );
}
