// Board — Herdr 项目级 Trello 5 列看板（全断点响应式自适应 + 2D 弹簧物理拖拽）。
// 响应式布局：
//   - 宽屏 (>= 1080px)：5 列一字排开，等宽填满零溢出
//   - 半屏/中屏 (640px ~ 1079px)：上 3 列（灵感/待开发/进行中）+ 下 2 列（待验收/已完成）网格全览，5 列尽收眼底
//   - 极窄屏 (< 640px)：顶部 5 列标签切换 + 全宽单列流（支持拖卡片到顶部列标签换列）
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import {
  agents,
  checking,
  nextCommand,
  notify,
  openOverlay,
  props,
  readTextFile,
  run,
  theme,
} from "herdr";
import {
  COLUMNS,
  COL_IDS,
  ICON,
  TASKS_FILE,
  activeAgentProjects,
  activeFilterProjects,
  activeSpaceProject,
  ago,
  cleanTitle,
  projectColor,
  projectKey,
  projectLabel,
  projectOfAgent,
  saveTasksAtomic,
  uid,
} from "./helpers.js";
import {
  initCardForm,
  initDispatchForm,
  renderCardForm,
  renderDispatchForm,
} from "./form.js";

const COL_HEAD_H = 44;
const EST_CARD_H = 96;
const CARD_GAP = 8;

function agentIcon(prog, size, color) {
  if (!prog?.icon) return svg(ICON("sparkles")).size(size).flex_none().text_color(color);
  return prog.tint
    ? svg(prog.icon).size(size).flex_none().text_color(color)
    : image(prog.icon).w(size).h(size).flex_none();
}

export default class Board extends View {
  init(p, cx) {
    const myProps = p || props() || {};
    this.isCardForm = Boolean(myProps.cardForm);
    this.isDispatch = Boolean(myProps.dispatch);
    this.handle = cx.focus_handle();

    if (this.isCardForm) {
      initCardForm(this, myProps.cardForm, cx);
      return;
    }
    if (this.isDispatch) {
      initDispatchForm(this, myProps.dispatch, cx);
      return;
    }

    this.tasksRaw = null;
    this.tasks = [];
    this.err = null;
    this.busy = false;
    this.projectFilter = "all";
    this.followSpace = false;
    this.query = "";
    this.searchFocused = false;
    this.hoveredCard = null;
    this.confirmClearDone = 0;

    // Responsive viewport dimensions from GPUI on_size_change
    this.size = { width: 1200, height: 800 };
    this.activeTabCol = "doing"; // used in narrow (<640px) single-column mode

    // 2D geometry snapshots (window-relative) for rock-solid drag hit-testing across all layouts
    this.rootBounds = null;
    this.colBounds = {}; // colId -> ElementBounds (column container or tab pill in narrow mode)

    this.drag = null;
    this.justDroppedId = null;

    this._colTaskCounts = Object.fromEntries(COL_IDS.map((id) => [id, 0]));
    this._colAgentCounts = Object.fromEntries(COL_IDS.map((id) => [id, 0]));

    this.quickCol = null;
    this.quickInput = InputState.new({ placeholder: "输入标题，回车添加…" });
    this.quickInput.on("submit", (_e, cx) => this.submitQuickAdd(cx));

    this.searchInput = InputState.new({ placeholder: "搜索任务或会话…" });
    this.searchInput.on("focus", (_e, cx) => { this.searchFocused = true; cx.notify(); });
    this.searchInput.on("blur", (_e, cx) => { this.searchFocused = false; cx.notify(); });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value().trim().toLowerCase();
      cx.notify();
    });

    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(2000, (cx) => this.refresh(cx));
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c === "new") this.openCardForm({ column: "todo" });
        else if (c === "idea") this.openCardForm({ column: "ideas" });
      }
    });
  }

  layoutMode() {
    const w = this.size?.width || 1200;
    if (w >= 1080) return "wide"; // 5 columns in 1 row
    if (w >= 640) return "grid";  // 3 + 2 adaptive grid (all 5 visible, zero horizontal scroll!)
    return "narrow";              // 5 top tabs + full-width column
  }

  refresh(cx) {
    if (this.busy || this.drag?.active) return;
    if (this.confirmClearDone && Date.now() > this.confirmClearDone) {
      this.confirmClearDone = 0;
      cx.notify();
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(TASKS_FILE()).catch(() => null);
        if (raw !== this.tasksRaw) {
          this.tasksRaw = raw;
          try {
            const parsed = JSON.parse(raw || '{"version":1,"tasks":[]}');
            this.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
            this.err = null;
          } catch (e) {
            this.err = `tasks.json 解析失败: ${e.message}`;
          }
          cx.notify();
        }
      } finally {
        this.busy = false;
      }
    });
  }

  // ---- inline quick add ---------------------------------------------------

  startQuickAdd(colId, cx) {
    this.quickCol = colId;
    this.quickInput.set_value("");
    cx.notify();
    cx.timer.after(30, () => this.quickInput.focus());
  }

  cancelQuickAdd(cx) {
    this.quickCol = null;
    this.quickInput.set_value("");
    cx.notify();
  }

  defaultProjectForNew() {
    const eff = this.effectiveProjectFilter();
    if (eff !== "all") {
      if (eff === "global") return null;
      const hit = activeFilterProjects(this.tasks).find((p) => projectKey(p) === eff);
      if (hit) return { name: hit.name, path: hit.path || null, machine: hit.machine || null };
    }
    const agProjs = activeAgentProjects();
    if (agProjs.length > 0) {
      const p = agProjs[0];
      return { name: p.name, path: p.path || null, machine: p.machine || null };
    }
    return null;
  }

  submitQuickAdd(cx) {
    if (!this.quickCol) return;
    const title = this.quickInput.value().trim();
    if (!title) return;
    const col = this.quickCol;
    const proj = this.defaultProjectForNew();
    const now = Date.now();
    const rec = {
      id: uid(),
      title,
      notes: "",
      column: col,
      priority: "p2",
      project: proj,
      tags: [],
      createdAt: now,
      updatedAt: now,
      doneAt: col === "done" ? now : null,
    };
    this.tasks = [rec, ...this.tasks];
    this.quickInput.set_value("");
    this.flashDropped(rec.id, cx);
    cx.notify();

    cx.spawn(async (cx) => {
      const res = await saveTasksAtomic((tasks) => {
        tasks.unshift(rec);
      });
      if (res.ok) this.tasksRaw = res.next;
      else this.refresh(cx);
    });
  }

  // ---- 2D Trello-grade spring drag & drop ---------------------------------

  flashDropped(id, cx) {
    this.justDroppedId = id;
    cx.timer.after(680, (cx) => {
      if (this.justDroppedId === id) {
        this.justDroppedId = null;
        cx.notify();
      }
    });
  }

  captureGeometryFromRoot(e) {
    if (e?.bounds) this.rootBounds = e.bounds;
  }

  /** 2D bounding-box hit-testing: works identically in 5-col row, 3+2 grid, and narrow tab mode */
  resolveDropSlot(winX, winY) {
    const mode = this.layoutMode();
    let targetCol = this.drag?.targetCol || this.drag?.originCol || "ideas";
    let colRect = this.colBounds[targetCol] || null;
    let exactHit = false;

    for (const id of COL_IDS) {
      const b = this.colBounds[id];
      if (!b) continue;
      const pad = 8;
      if (winX >= b.x - pad && winX <= b.x + b.width + pad && winY >= b.y - pad && winY <= b.y + b.height + pad) {
        targetCol = id;
        colRect = b;
        exactHit = true;
        break;
      }
    }

    // Fallback: geometric calculation from rootBounds if a column hasn't reported bounds yet
    if (!exactHit && this.rootBounds) {
      const rx = winX - this.rootBounds.x;
      const ry = winY - this.rootBounds.y;
      const rw = Math.max(1, this.rootBounds.width);
      const rh = Math.max(1, this.rootBounds.height);
      const bodyTop = 92;
      if (mode === "wide") {
        const idx = Math.max(0, Math.min(4, Math.floor((rx / rw) * 5)));
        targetCol = COL_IDS[idx];
      } else if (mode === "grid") {
        const midY = bodyTop + (rh - bodyTop) * 0.5;
        if (ry < midY) {
          const idx = Math.max(0, Math.min(2, Math.floor((rx / rw) * 3)));
          targetCol = COL_IDS[idx];
        } else {
          const idx = Math.max(0, Math.min(1, Math.floor((rx / rw) * 2)));
          targetCol = COL_IDS[3 + idx];
        }
      } else {
        // narrow mode: top tab bar hit
        if (ry < bodyTop + 44) {
          const idx = Math.max(0, Math.min(4, Math.floor((rx / rw) * 5)));
          targetCol = COL_IDS[idx];
        } else {
          targetCol = this.activeTabCol;
        }
      }
      colRect = this.colBounds[targetCol] || null;
    }

    const liveCount = this._colAgentCounts[targetCol] || 0;
    const taskCount = this._colTaskCounts[targetCol] || 0;
    const cardStep = (this.drag?.cardH || EST_CARD_H) + CARD_GAP;
    const colTop = colRect ? colRect.y : (this.rootBounds?.y ?? 0) + 100;
    const cardsTop = colTop + COL_HEAD_H + liveCount * (EST_CARD_H + CARD_GAP);
    const relY = winY - cardsTop;
    const rawIdx = Math.floor((relY + cardStep * 0.45) / cardStep);
    const insertIdx = Math.max(0, Math.min(taskCount, rawIdx));
    return { targetCol, insertIdx };
  }

  beginDragTask(task, e) {
    const b = e?.bounds;
    const px = e?.position?.x ?? 0;
    const py = e?.position?.y ?? 0;
    const cardW = b?.width || 240;
    const cardH = b?.height || EST_CARD_H;
    const grabX = b ? Math.max(12, Math.min(cardW - 12, px - b.x)) : cardW / 2;
    const grabY = b ? Math.max(10, Math.min(cardH - 10, py - b.y)) : 24;

    this.drag = {
      kind: "task",
      id: task.id,
      title: task.title,
      originCol: task.column,
      task,
      startX: px,
      startY: py,
      curX: px,
      curY: py,
      grabX,
      grabY,
      cardW,
      cardH,
      active: false,
      targetCol: task.column,
      insertIdx: 0,
    };
  }

  beginDragLive(ag, originCol, e) {
    const b = e?.bounds;
    const px = e?.position?.x ?? 0;
    const py = e?.position?.y ?? 0;
    const cardW = b?.width || 240;
    const cardH = b?.height || EST_CARD_H;
    const grabX = b ? Math.max(12, Math.min(cardW - 12, px - b.x)) : cardW / 2;
    const grabY = b ? Math.max(10, Math.min(cardH - 10, py - b.y)) : 24;
    const title = cleanTitle(ag.title) || ag.tab_name || ag.program?.name || ag.address;

    this.drag = {
      kind: "live",
      id: `live:${ag.address}`,
      title,
      originCol,
      agent: ag,
      startX: px,
      startY: py,
      curX: px,
      curY: py,
      grabX,
      grabY,
      cardW,
      cardH,
      active: false,
      targetCol: originCol,
      insertIdx: 0,
    };
  }

  updateDragPointer(e, cx) {
    const d = this.drag;
    if (!d || !e?.position) return;
    const px = e.position.x;
    const py = e.position.y;
    d.curX = px;
    d.curY = py;

    if (!d.active) {
      const dx = px - d.startX;
      const dy = py - d.startY;
      if (dx * dx + dy * dy < 20) return;
      d.active = true;
      this.hoveredCard = null;
    }

    const { targetCol, insertIdx } = this.resolveDropSlot(px, py);
    d.targetCol = targetCol;
    d.insertIdx = insertIdx;
    cx.notify();
  }

  finishDrag(cx) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;

    if (!d.active) {
      if (d.kind === "task") {
        this.openCardForm({ edit: d.task });
      } else if (d.kind === "live") {
        run("agent.focus", { terminal: d.agent.address });
      }
      cx.notify();
      return;
    }

    const targetCol = d.targetCol || d.originCol;
    const insertIdx = d.insertIdx ?? 0;

    if (d.kind === "task") {
      this.placeTask(d.task, targetCol, insertIdx, cx);
      if (this.layoutMode() === "narrow") this.activeTabCol = targetCol;
    } else if (d.kind === "live" && targetCol !== d.originCol) {
      this.adoptLiveAgent(d.agent, targetCol, cx);
      if (this.layoutMode() === "narrow") this.activeTabCol = targetCol;
    }
    cx.notify();
  }

  placeTask(task, targetCol, insertIdx, cx) {
    const now = Date.now();
    const moved = {
      ...task,
      column: targetCol,
      updatedAt: now,
      doneAt: targetCol === "done" ? (task.doneAt || now) : null,
    };

    const reorder = (list) => {
      const without = list.filter((x) => x.id !== task.id);
      const colIndices = [];
      without.forEach((x, idx) => {
        if ((COL_IDS.includes(x.column) ? x.column : "ideas") === targetCol) {
          colIndices.push(idx);
        }
      });
      if (colIndices.length === 0 || insertIdx <= 0) {
        const firstIdx = colIndices.length > 0 ? colIndices[0] : 0;
        without.splice(firstIdx, 0, moved);
      } else if (insertIdx >= colIndices.length) {
        const afterLast = colIndices[colIndices.length - 1] + 1;
        without.splice(afterLast, 0, moved);
      } else {
        without.splice(colIndices[insertIdx], 0, moved);
      }
      return without;
    };

    this.tasks = reorder(this.tasks);
    this.flashDropped(task.id, cx);
    cx.notify();

    cx.spawn(async (cx) => {
      const res = await saveTasksAtomic((tasks) => {
        const next = reorder(tasks);
        tasks.length = 0;
        tasks.push(...next);
      });
      if (res.ok) this.tasksRaw = res.next;
      else {
        notify({ title: "Board", body: "保存失败，请重试", level: "error" });
        this.refresh(cx);
      }
    });
  }

  clearDoneTasks(cx) {
    this.confirmClearDone = 0;
    const activeFilter = this.effectiveProjectFilter();
    cx.spawn(async (cx) => {
      let removed = 0;
      const res = await saveTasksAtomic((tasks) => {
        for (let i = tasks.length - 1; i >= 0; i--) {
          const t = tasks[i];
          if (t.column !== "done") continue;
          if (activeFilter !== "all" && projectKey(t.project) !== activeFilter) continue;
          tasks.splice(i, 1);
          removed++;
        }
      });
      if (res.ok) {
        this.tasks = res.tasks;
        this.tasksRaw = res.next;
      }
      if (removed > 0) {
        notify({ title: "Board", body: `已清理 ${removed} 张已完成卡片`, level: "info", timeout: 1800 });
      }
      cx.notify();
    });
  }

  adoptLiveAgent(ag, targetCol, cx) {
    const proj = projectOfAgent(ag);
    const title = cleanTitle(ag.title) || ag.tab_name || `${ag.program?.name || "Agent"} (${ag.address})`;
    const col = targetCol || (ag.status === "blocked" || ag.status === "done" ? "review" : "doing");
    const now = Date.now();
    const rec = {
      id: uid(),
      title,
      notes: `关联会话：${ag.program?.name || "Agent"} (${ag.address})`,
      column: col,
      priority: ag.status === "blocked" ? "p1" : "p2",
      project: { name: proj.name, path: proj.path, machine: proj.machine },
      tags: [],
      agent: {
        address: ag.address,
        program: ag.program?.name || ag.app || "Agent",
      },
      createdAt: now,
      updatedAt: now,
      doneAt: col === "done" ? now : null,
    };
    this.tasks = [rec, ...this.tasks];
    this.flashDropped(rec.id, cx);
    cx.notify();
    cx.spawn(async (cx) => {
      const res = await saveTasksAtomic((tasks) => {
        tasks.unshift(rec);
      });
      if (res.ok) {
        this.tasksRaw = res.next;
        const colObj = COLUMNS.find((c) => c.id === col);
        notify({
          title: "Board",
          body: `已将「${title}」放入${colObj ? colObj.label : col}`,
          level: "success",
          timeout: 1800,
        });
      } else {
        this.refresh(cx);
      }
    });
  }

  openCardForm({ edit = null, column = "ideas" } = {}) {
    const defaultProj = edit ? edit.project : this.defaultProjectForNew();
    openOverlay({
      mod: "board",
      props: {
        cardForm: {
          edit,
          column,
          project: defaultProj,
        },
      },
      kind: "dialog",
      width: 580,
      height: 550,
    });
  }

  openDispatch(task) {
    openOverlay({
      mod: "board",
      props: { dispatch: { task } },
      kind: "dialog",
      width: 560,
      height: 590,
    });
  }

  // ---- filtering ----------------------------------------------------------

  effectiveProjectFilter() {
    if (this.followSpace) {
      const sp = activeSpaceProject();
      if (sp) return projectKey(sp);
    }
    return this.projectFilter;
  }

  matchesFilter(proj, textHaystack) {
    const eff = this.effectiveProjectFilter();
    if (eff !== "all") {
      const pk = proj ? projectKey(proj) : "global";
      if (pk !== eff) return false;
    }
    if (this.query && !textHaystack.toLowerCase().includes(this.query)) return false;
    return true;
  }

  // ---- Trello placeholder slot & floating ghost ---------------------------

  dropPlaceholder(col, t) {
    const h = Math.max(52, Math.min(120, this.drag?.cardH || 74));
    return h_flex()
      .id(`drop-slot-${col.id}`)
      .flex_none()
      .w_full()
      .h(h)
      .px(10)
      .items_center()
      .justify_center()
      .rounded(10)
      .bg(t.raised)
      .border_1()
      .border_dashed()
      .border_color(t.accent)
      .spring("height", { response: 150, damping: 0.86 })
      .transition("opacity", { duration: 120, easing: "ease-out" })
      .text_size(11.5)
      .font_medium()
      .text_color(t.accent)
      .child(`松手放入「${col.label}」`);
  }

  renderFloatingGhost(t) {
    const d = this.drag;
    if (!d?.active) return null;
    const originX = this.rootBounds?.x ?? 0;
    const originY = this.rootBounds?.y ?? 0;
    const left = d.curX - originX - d.grabX - 3;
    const top = d.curY - originY - d.grabY - 4;
    const w = Math.max(200, Math.min(320, (d.cardW || 240) + 6));

    const isTask = d.kind === "task";
    const proj = isTask ? d.task?.project : projectOfAgent(d.agent);
    const pColor = proj ? projectColor(projectKey(proj)) : t.dim;
    const targetColObj = COLUMNS.find((c) => c.id === d.targetCol);

    return v_flex()
      .id("board-drag-ghost")
      .absolute()
      .left(left)
      .top(top)
      .w(w)
      .px(12)
      .py(11)
      .gap(7)
      .rounded(11)
      .bg(t.surface)
      .border_2()
      .border_color(t.accent)
      .shadow_2xl()
      .opacity(0.96)
      .cursor_grabbing()
      .spring("left", { response: 68, damping: 0.9 })
      .spring("top", { response: 68, damping: 0.9 })
      .on_mouse_move((e, cx) => this.updateDragPointer(e, cx))
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        this.finishDrag(cx);
      })
      .children([
        h_flex()
          .gap(6)
          .items_center()
          .justify_between()
          .children([
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(5)
              .items_center()
              .children([
                div().size(7).flex_none().rounded_full().bg(pColor),
                div().truncate().text_size(11).font_medium().text_color(t.muted).child(proj ? projectLabel(proj) : "全局"),
              ]),
            ...(targetColObj && targetColObj.id !== d.originCol
              ? [
                  div()
                    .px(6)
                    .h(18)
                    .flex()
                    .flex_none()
                    .items_center()
                    .rounded(5)
                    .bg(t.selected)
                    .text_size(10)
                    .font_medium()
                    .text_color(t.accent)
                    .child(`→ ${targetColObj.label}`),
                ]
              : []),
          ]),
        div()
          .font_semibold()
          .text_size(13)
          .text_color(t.foreground)
          .whitespace_normal()
          .child(d.title),
        ...(isTask && d.task?.notes
          ? [
              div()
                .text_size(11.5)
                .text_color(t.muted)
                .truncate()
                .child(d.task.notes.replace(/\s+/g, " ")),
            ]
          : []),
      ]);
  }

  // ---- clean Trello/Linear cards ------------------------------------------

  liveAgentCard(ag, originCol, t) {
    const proj = projectOfAgent(ag);
    const pk = projectKey(proj);
    const pColor = projectColor(pk);
    const isBlocked = ag.status === "blocked";
    const isDone = ag.status === "done";
    const isWorking = ag.status === "working";
    const isDraggingThis = this.drag?.active && this.drag.id === `live:${ag.address}`;

    if (isDraggingThis) return null;

    const railColor = isBlocked ? t.blocked : isDone ? t.done : isWorking ? t.working : t.accent;
    const statusText = isBlocked ? "需要回复" : isDone ? "刚完成" : isWorking ? "工作中" : "会话中";
    const title = cleanTitle(ag.title) || ag.tab_name || ag.program?.name || ag.address;

    return h_flex()
      .id(`live-${ag.address}`)
      .flex_none()
      .rounded(10)
      .bg(t.surface)
      .border_1()
      .border_color(isBlocked ? t.blocked : isDone ? t.done : t.border)
      .shadow_xs()
      .hover((s) => s.border_color(isBlocked ? t.blocked : t.accent).shadow_sm())
      .overflow_hidden()
      .when(this.drag?.active, (el) => el.cursor_grabbing())
      .when(!this.drag?.active, (el) => el.cursor_grab())
      .on_mouse_down("left", (e) => {
        this.beginDragLive(ag, originCol, e);
      })
      .child(div().w(3).flex_none().bg(railColor))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .px(10)
          .py(9)
          .gap(6)
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .children([
                h_flex()
                  .flex_1()
                  .min_w(0)
                  .gap(5)
                  .items_center()
                  .children([
                    div().size(6.5).flex_none().rounded_full().bg(pColor),
                    div().truncate().text_size(11).font_medium().text_color(t.muted).child(projectLabel(proj)),
                  ]),
                h_flex()
                  .gap(4)
                  .px(5)
                  .h(18)
                  .flex_none()
                  .items_center()
                  .rounded(4)
                  .bg(t.raised)
                  .text_size(10)
                  .font_medium()
                  .text_color(railColor)
                  .children([
                    isWorking
                      ? svg(ICON("spinner")).size(10).spin(900)
                      : div().size(5.5).rounded_full().bg(railColor),
                    statusText,
                  ]),
              ])
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .children([
                agentIcon(ag.program, 14.5, t.foreground),
                div()
                  .flex_1()
                  .min_w(0)
                  .font_semibold()
                  .text_size(12.5)
                  .text_color(t.foreground)
                  .whitespace_normal()
                  .child(title),
              ])
          )
          .child(
            h_flex()
              .pt(2)
              .gap(4)
              .items_center()
              .justify_between()
              .children([
                div().truncate().text_size(10.5).text_color(t.dim).child(`${ag.program?.name || "Agent"} · ${ag.address}`),
                h_flex()
                  .id(`live-focus-${ag.address}`)
                  .h(22)
                  .px(7)
                  .gap(3)
                  .flex_none()
                  .items_center()
                  .rounded(5)
                  .cursor_pointer()
                  .when(isBlocked, (e) => e.bg(t.blocked).text_color("#ffffff").font_medium())
                  .when(!isBlocked, (e) => e.bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.selected)))
                  .text_size(10.5)
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    run("agent.focus", { terminal: ag.address });
                  })
                  .children([isBlocked ? "去回复" : "打开", svg(ICON("external")).size(10)]),
              ])
          )
      );
  }

  taskCard(task, liveByAddr, t) {
    const proj = task.project;
    const pColor = proj ? projectColor(projectKey(proj)) : t.dim;
    const isHovered = this.hoveredCard === task.id && !this.drag?.active;
    const isJustDropped = this.justDroppedId === task.id;
    const boundAgent = task.agent?.address ? liveByAddr.get(task.agent.address) : null;

    const notePreview = task.notes
      ? task.notes.length <= 72
        ? task.notes
        : task.notes.slice(0, 71) + "…"
      : "";

    const stop = (_e, cx) => cx.stop_propagation();

    return v_flex()
      .id(`card-${task.id}`)
      .flex_none()
      .px(10)
      .py(9)
      .gap(6)
      .rounded(10)
      .bg(t.surface)
      .border_1()
      .border_color(isJustDropped ? t.accent : t.border)
      .when(isJustDropped, (el) => el.shadow_md())
      .when(!isJustDropped, (el) => el.shadow_xs().hover((s) => s.border_color(t.input).shadow_sm()))
      .when(task.column === "done", (el) => el.opacity(0.74))
      .transition("opacity", { duration: 160, easing: "ease-out" })
      .when(this.drag?.active, (el) => el.cursor_grabbing())
      .when(!this.drag?.active, (el) => el.cursor_grab())
      .on_hover((on, cx) => {
        if (this.drag?.active) return;
        if (on) this.hoveredCard = task.id;
        else if (this.hoveredCard === task.id) this.hoveredCard = null;
        cx.notify();
      })
      .on_mouse_down("left", (e) => {
        this.beginDragTask(task, e);
      })
      .child(
        h_flex()
          .gap(5)
          .items_center()
          .children([
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(5)
              .items_center()
              .children([
                div().size(6.5).flex_none().rounded_full().bg(pColor),
                div()
                  .truncate()
                  .text_size(11)
                  .font_medium()
                  .text_color(proj ? t.muted : t.dim)
                  .child(proj ? projectLabel(proj) : "全局"),
              ]),
            ...(task.scheduled?.at
              ? [
                  h_flex()
                    .id(`csch-${task.id}`)
                    .flex_none()
                    .h(17)
                    .px(5)
                    .gap(3)
                    .items_center()
                    .rounded(4)
                    .bg(t.selected)
                    .text_size(9.5)
                    .font_medium()
                    .text_color(t.accent)
                    .tooltip(`已预约 ${task.scheduled.at.replace("T", " ")} 由 ${task.scheduled.program || "Agent"} 启动`)
                    .children([svg(ICON("clock")).size(9.5), task.scheduled.at.slice(11, 16)]),
                ]
              : []),
            ...(task.priority === "p1"
              ? [
                  div()
                    .px(5)
                    .h(16)
                    .flex()
                    .flex_none()
                    .items_center()
                    .rounded(4)
                    .bg(t.raised)
                    .text_size(9.5)
                    .font_semibold()
                    .text_color(t.blocked)
                    .child("P1"),
                ]
              : []),
            ...(isHovered
              ? [
                  h_flex()
                    .id(`cedit-${task.id}`)
                    .w(20)
                    .h(20)
                    .flex_none()
                    .rounded(5)
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .tooltip("编辑或删除")
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      this.openCardForm({ edit: task });
                    })
                    .child(svg(ICON("edit")).size(11.5)),
                ]
              : []),
          ])
      )
      .child(
        v_flex()
          .gap(3)
          .child(
            div()
              .font_semibold()
              .text_size(12.5)
              .text_color(t.foreground)
              .whitespace_normal()
              .child(task.title)
          )
          .when(Boolean(notePreview), (el) =>
            el.child(
              div()
                .text_size(11.5)
                .text_color(t.muted)
                .whitespace_normal()
                .child(notePreview)
            )
          )
      )
      .child(
        h_flex()
          .pt(2)
          .gap(5)
          .items_center()
          .justify_between()
          .children([
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(4)
              .items_center()
              .overflow_hidden()
              .children(
                (task.tags || []).length > 0
                  ? (task.tags || []).slice(0, 2).map((tag, i) =>
                      div()
                        .id(`ctag-${task.id}-${i}`)
                        .flex_none()
                        .h(18)
                        .px(5)
                        .flex()
                        .items_center()
                        .rounded(4)
                        .bg(t.raised)
                        .text_size(10)
                        .text_color(t.dim)
                        .child(`#${tag}`)
                    )
                  : [
                      div()
                        .text_size(10.5)
                        .text_color(t.dim)
                        .child(task.doneAt ? `${ago(task.doneAt)}完成` : ago(task.updatedAt)),
                    ]
              ),
            ...(task.column === "todo"
              ? [
                  h_flex()
                    .id(`cdisp-${task.id}`)
                    .h(22)
                    .px(8)
                    .gap(4)
                    .flex_none()
                    .items_center()
                    .rounded(6)
                    .bg(t.solid)
                    .text_color(t.solid_foreground)
                    .text_size(10.5)
                    .font_medium()
                    .cursor_pointer()
                    .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      this.openDispatch(task);
                    })
                    .children([svg(ICON("sparkles")).size(10), "派给 Agent"]),
                ]
              : task.column === "doing" && boundAgent
              ? [
                  h_flex()
                    .id(`cjump-${task.id}`)
                    .h(22)
                    .px(7)
                    .gap(3)
                    .flex_none()
                    .items_center()
                    .rounded(5)
                    .bg(t.selected)
                    .text_size(10.5)
                    .text_color(t.foreground)
                    .cursor_pointer()
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      run("agent.focus", { terminal: boundAgent.address });
                    })
                    .children([boundAgent.address, svg(ICON("external")).size(10)]),
                ]
              : task.column === "review"
              ? [
                  h_flex()
                    .id(`c2done-${task.id}`)
                    .h(22)
                    .px(8)
                    .gap(3)
                    .flex_none()
                    .items_center()
                    .rounded(6)
                    .bg(t.done)
                    .text_color("#ffffff")
                    .text_size(10.5)
                    .font_medium()
                    .cursor_pointer()
                    .hover((s) => s.opacity(0.9))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      this.placeTask(task, "done", 0, cx);
                    })
                    .children([svg(ICON("check")).size(10.5), "完成"]),
                ]
              : []),
          ])
      );
  }

  // ---- column renderer ----------------------------------------------------

  renderColumn(col, colTasks, colAgents, liveByAddr, t) {
    const draggingActive = Boolean(this.drag?.active);
    const visibleTasks = draggingActive && this.drag.kind === "task"
      ? colTasks.filter((tk) => tk.id !== this.drag.id)
      : colTasks;
    const visibleAgents = draggingActive && this.drag.kind === "live"
      ? colAgents.filter((ag) => `live:${ag.address}` !== this.drag.id)
      : colAgents;

    this._colTaskCounts[col.id] = visibleTasks.length;
    this._colAgentCounts[col.id] = visibleAgents.length;

    const isTargetCol = draggingActive && this.drag.targetCol === col.id;
    const showSlot = isTargetCol && (this.drag.kind === "task" || this.drag.originCol !== col.id);
    const insertIdx = Math.max(0, Math.min(visibleTasks.length, this.drag?.insertIdx ?? 0));

    const total = colTasks.length + colAgents.length;
    const toneColor = t[col.tone] || t.muted;
    const clearConfirming = this.confirmClearDone > Date.now();
    const isQuickHere = this.quickCol === col.id;

    const taskNodes = [];
    for (let i = 0; i <= visibleTasks.length; i++) {
      if (showSlot && i === insertIdx) {
        taskNodes.push(this.dropPlaceholder(col, t));
      }
      if (i < visibleTasks.length) {
        taskNodes.push(this.taskCard(visibleTasks[i], liveByAddr, t));
      }
    }

    const agentNodes = visibleAgents
      .map((ag) => this.liveAgentCard(ag, col.id, t))
      .filter(Boolean);

    return v_flex()
      .id(`col-${col.id}`)
      .flex_1()
      .min_w(0)
      .min_h(0)
      .h_full()
      .rounded(11)
      .bg(isTargetCol && this.drag.originCol !== col.id ? t.selected : t.chrome)
      .border_1()
      .border_color(isTargetCol && this.drag.originCol !== col.id ? t.accent : t.border)
      .overflow_hidden()
      .on_mouse_move((e, cx) => {
        if (e?.bounds) this.colBounds[col.id] = e.bounds;
        if (this.drag) this.updateDragPointer(e, cx);
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag) {
          cx.stop_propagation();
          this.finishDrag(cx);
        }
      })
      .child(div().h(2).w_full().flex_none().bg(isTargetCol ? t.accent : toneColor).opacity(isTargetCol ? 1 : 0.7))
      .child(
        h_flex()
          .flex_none()
          .h(38)
          .px(11)
          .gap(6)
          .items_center()
          .children([
            svg(ICON(col.icon))
              .size(13)
              .flex_none()
              .text_color(toneColor)
              .when(col.id === "doing" && colAgents.some((a) => a.status === "working"), (el) => el.spin(1200)),
            div().truncate().font_semibold().text_size(12.5).text_color(t.foreground).child(col.label),
            div()
              .px(5.5)
              .h(17)
              .flex()
              .flex_none()
              .items_center()
              .rounded(9)
              .bg(t.raised)
              .text_size(10.5)
              .font_medium()
              .text_color(total > 0 && col.id === "review" ? t.blocked : t.muted)
              .child(`${total}`),
            div().flex_1(),
            ...(col.id === "done" && colTasks.length > 0
              ? [
                  div()
                    .id("clear-done-btn")
                    .h(22)
                    .px(7)
                    .flex()
                    .flex_none()
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .text_size(10.5)
                    .when(clearConfirming, (el) => el.bg(t.blocked).text_color("#ffffff").font_medium())
                    .when(!clearConfirming, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
                    .on_click((_e, cx) => {
                      if (clearConfirming) return this.clearDoneTasks(cx);
                      this.confirmClearDone = Date.now() + 4000;
                      cx.notify();
                    })
                    .child(clearConfirming ? "确认" : "清空"),
                ]
              : [
                  h_flex()
                    .id(`col-add-${col.id}`)
                    .w(24)
                    .h(24)
                    .flex_none()
                    .rounded(6)
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .text_color(t.muted)
                    .tooltip(`在「${col.label}」快速添加`)
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => this.startQuickAdd(col.id, cx))
                    .child(svg(ICON("plus")).size(13)),
                ]),
          ])
      )
      .child(
        div()
          .id(`col-scroll-${col.id}`)
          .flex_1()
          .min_h(0)
          .w_full()
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .w_full()
              .px(8)
              .pb(8)
              .gap(CARD_GAP)
              .children(agentNodes)
              .children(taskNodes)
              .when(agentNodes.length === 0 && taskNodes.length === 0 && !isQuickHere, (el) =>
                el.child(
                  div()
                    .py(18)
                    .px(8)
                    .text_size(11.5)
                    .text_color(t.dim)
                    .child(col.empty)
                )
              )
          )
      )
      .child(
        isQuickHere
          ? v_flex()
              .flex_none()
              .p(8)
              .gap(6)
              .border_t_1()
              .border_color(t.border)
              .bg(t.surface)
              .children([
                h_flex()
                  .h(28)
                  .px(8)
                  .items_center()
                  .rounded(7)
                  .bg(t.background)
                  .border_1()
                  .border_color(t.accent)
                  .child(Input.new(this.quickInput).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground)),
                h_flex()
                  .items_center()
                  .justify_between()
                  .children([
                    div()
                      .id(`qmore-${col.id}`)
                      .text_size(11)
                      .text_color(t.muted)
                      .cursor_pointer()
                      .hover((s) => s.text_color(t.accent))
                      .on_click((_e, cx) => {
                        this.cancelQuickAdd(cx);
                        this.openCardForm({ column: col.id });
                      })
                      .child("详细表单…"),
                    h_flex()
                      .gap(5)
                      .children([
                        div()
                          .id(`qcancel-${col.id}`)
                          .h(23)
                          .px(8)
                          .flex()
                          .items_center()
                          .rounded(5)
                          .cursor_pointer()
                          .text_size(11)
                          .text_color(t.muted)
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => this.cancelQuickAdd(cx))
                          .child("取消"),
                        div()
                          .id(`qok-${col.id}`)
                          .h(23)
                          .px(9)
                          .flex()
                          .items_center()
                          .rounded(5)
                          .cursor_pointer()
                          .bg(t.solid)
                          .text_color(t.solid_foreground)
                          .text_size(11)
                          .font_medium()
                          .on_click((_e, cx) => this.submitQuickAdd(cx))
                          .child("添加"),
                      ]),
                  ]),
              ])
          : h_flex()
              .id(`col-qadd-${col.id}`)
              .flex_none()
              .h(32)
              .px(11)
              .gap(5)
              .items_center()
              .border_t_1()
              .border_color(t.border)
              .cursor_pointer()
              .text_size(11.5)
              .text_color(t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.startQuickAdd(col.id, cx))
              .children([svg(ICON("plus")).size(12.5), "添加卡片"])
      );
  }

  // ---- responsive board body (wide 5-col / grid 3+2 / narrow tabs) --------

  renderBoardBody(byColTasks, byColAgents, liveByAddr, t) {
    const mode = this.layoutMode();

    // 1. Wide (>= 1080px): 5 equal columns filling viewport
    if (mode === "wide") {
      return h_flex()
        .id("board-wide")
        .flex_1()
        .min_h(0)
        .w_full()
        .p(12)
        .gap(10)
        .children(
          COLUMNS.map((col) =>
            this.renderColumn(col, byColTasks[col.id], byColAgents[col.id], liveByAddr, t)
          )
        );
    }

    // 2. Medium / Half-screen (640px ~ 1079px): 3 top + 2 bottom adaptive grid — ALL 5 columns visible!
    if (mode === "grid") {
      const topCols = COLUMNS.slice(0, 3);
      const botCols = COLUMNS.slice(3, 5);
      return v_flex()
        .id("board-grid")
        .flex_1()
        .min_h(0)
        .w_full()
        .p(10)
        .gap(10)
        .child(
          h_flex()
            .id("board-grid-top")
            .flex_1()
            .min_h(0)
            .w_full()
            .gap(10)
            .children(
              topCols.map((col) =>
                this.renderColumn(col, byColTasks[col.id], byColAgents[col.id], liveByAddr, t)
              )
            )
        )
        .child(
          h_flex()
            .id("board-grid-bot")
            .flex_1()
            .min_h(0)
            .w_full()
            .gap(10)
            .children(
              botCols.map((col) =>
                this.renderColumn(col, byColTasks[col.id], byColAgents[col.id], liveByAddr, t)
              )
            )
        );
    }

    // 3. Narrow (< 640px): 5 droppable column tabs + full-width active column
    const activeCol = COLUMNS.find((c) => c.id === this.activeTabCol) || COLUMNS[0];
    return v_flex()
      .id("board-narrow")
      .flex_1()
      .min_h(0)
      .w_full()
      .p(10)
      .gap(8)
      .child(
        h_flex()
          .flex_none()
          .p(3)
          .gap(3)
          .rounded(9)
          .bg(t.raised)
          .children(
            COLUMNS.map((col) => {
              const on = col.id === activeCol.id;
              const n = byColTasks[col.id].length + byColAgents[col.id].length;
              const isDragTarget = Boolean(this.drag?.active) && this.drag.targetCol === col.id && this.drag.originCol !== col.id;
              return h_flex()
                .id(`ntab-${col.id}`)
                .flex_1()
                .min_w(0)
                .h(28)
                .px(6)
                .gap(4)
                .items_center()
                .justify_center()
                .rounded(6)
                .cursor_pointer()
                .text_size(11)
                .when(isDragTarget, (e) => e.bg(t.accent).text_color(t.accent_foreground).font_semibold())
                .when(!isDragTarget && on, (e) => e.bg(t.surface).text_color(t.foreground).font_medium().shadow_xs())
                .when(!isDragTarget && !on, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
                .on_mouse_move((e, cx) => {
                  if (e?.bounds) this.colBounds[col.id] = e.bounds;
                  if (this.drag) this.updateDragPointer(e, cx);
                })
                .on_mouse_up("left", (_e, cx) => {
                  if (this.drag?.active) {
                    cx.stop_propagation();
                    this.drag.targetCol = col.id;
                    this.finishDrag(cx);
                  }
                })
                .on_click((_e, cx) => {
                  this.activeTabCol = col.id;
                  cx.notify();
                })
                .children([
                  div().truncate().child(col.label),
                  ...(n > 0 ? [div().text_size(10).opacity(0.75).child(`${n}`)] : []),
                ]);
            })
          )
      )
      .child(
        this.renderColumn(
          activeCol,
          byColTasks[activeCol.id],
          byColAgents[activeCol.id],
          liveByAddr,
          t
        )
      );
  }

  // ---- main render --------------------------------------------------------

  render() {
    const t = theme();
    if (this.isCardForm) return renderCardForm(this, t);
    if (this.isDispatch) return renderDispatchForm(this, t);

    const w = this.size?.width || 1200;
    const compactHeader = w < 860;
    const tinyHeader = w < 600;

    const liveAgents = agents();
    const liveByAddr = new Map(liveAgents.map((a) => [a.address, a]));
    const boundActiveAddrs = new Set(
      this.tasks
        .filter((x) => x.column !== "done" && x.agent?.address)
        .map((x) => x.agent.address)
    );
    const archivedIdleAddrs = new Set(
      this.tasks
        .filter((x) => x.column === "done" && x.agent?.address)
        .map((x) => x.agent.address)
    );

    const projects = activeFilterProjects(this.tasks);
    const effFilter = this.effectiveProjectFilter();

    const projCounts = new Map();
    let globalCount = 0;
    for (const tk of this.tasks) {
      if (tk.column === "done") continue;
      if (!tk.project) globalCount++;
      else {
        const k = projectKey(tk.project);
        projCounts.set(k, (projCounts.get(k) || 0) + 1);
      }
    }
    const visibleLiveAgents = liveAgents.filter((ag) => {
      if (boundActiveAddrs.has(ag.address)) return false;
      if (archivedIdleAddrs.has(ag.address) && ag.status === "idle") return false;
      return true;
    });
    for (const ag of visibleLiveAgents) {
      const k = projectKey(projectOfAgent(ag));
      projCounts.set(k, (projCounts.get(k) || 0) + 1);
    }

    const byColTasks = Object.fromEntries(COL_IDS.map((id) => [id, []]));
    const byColAgents = Object.fromEntries(COL_IDS.map((id) => [id, []]));

    for (const tk of this.tasks) {
      const hay = `${tk.title || ""} ${tk.notes || ""} ${(tk.tags || []).join(" ")} ${tk.project?.name || ""}`;
      if (!this.matchesFilter(tk.project, hay)) continue;
      const col = COL_IDS.includes(tk.column) ? tk.column : "ideas";
      byColTasks[col].push(tk);
    }

    for (const ag of visibleLiveAgents) {
      const proj = projectOfAgent(ag);
      const hay = `${ag.address} ${ag.title || ""} ${ag.tab_name || ""} ${ag.program?.name || ""} ${proj.name}`;
      if (!this.matchesFilter(proj, hay)) continue;
      if (ag.status === "blocked" || ag.status === "done") byColAgents.review.push(ag);
      else byColAgents.doing.push(ag);
    }
    byColAgents.doing.sort((a, b) => (a.status === "working" ? 0 : 1) - (b.status === "working" ? 0 : 1));
    byColAgents.review.sort((a, b) => (a.status === "blocked" ? 0 : 1) - (b.status === "blocked" ? 0 : 1));

    const openTaskCount = this.tasks.filter((x) => x.column !== "done").length;
    const ghost = this.renderFloatingGhost(t);

    const searchBox = h_flex()
      .when(tinyHeader, (el) => el.flex_1().min_w(0))
      .when(!tinyHeader, (el) => el.w(compactHeader ? 160 : 210))
      .h(28)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(7)
      .bg(t.surface)
      .border_1()
      .border_color(this.searchFocused ? t.accent : t.border)
      .children([
        svg(ICON("search")).size(12.5).flex_none().text_color(this.searchFocused ? t.accent : t.dim),
        Input.new(this.searchInput).flex_1().min_w(0).h_full().text_size(11.5).text_color(t.foreground),
        ...(this.query
          ? [
              h_flex()
                .id("b-search-clr")
                .w(16)
                .h(16)
                .rounded(4)
                .items_center()
                .justify_center()
                .cursor_pointer()
                .text_color(t.dim)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => { this.searchInput.set_value(""); this.query = ""; cx.notify(); })
                .child(svg(ICON("x")).size(10.5)),
            ]
          : []),
      ]);

    const followBtn = div()
      .id("board-follow")
      .h(28)
      .px(9)
      .flex()
      .flex_none()
      .items_center()
      .rounded(7)
      .border_1()
      .cursor_pointer()
      .text_size(11.5)
      .when(this.followSpace, (e) => e.bg(t.selected).border_color(t.accent).text_color(t.foreground).font_medium())
      .when(!this.followSpace, (e) => e.bg(t.surface).border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .tooltip("开启后自动只看当前左侧选中 Space 对应的项目")
      .on_click((_e, cx) => { this.followSpace = !this.followSpace; cx.notify(); })
      .child(compactHeader ? "当前项目" : "仅看当前项目");

    return v_flex()
      .id("board-root")
      .relative()
      .size_full()
      .bg(t.canvas)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        if (Math.abs((this.size?.width || 0) - size.width) > 4 || Math.abs((this.size?.height || 0) - size.height) > 4) {
          this.size = size;
          this.colBounds = {};
          cx.notify();
        }
      })
      .when(Boolean(this.drag?.active), (el) => el.cursor_grabbing())
      .on_mouse_down("left", (e) => {
        this.captureGeometryFromRoot(e);
      })
      .on_mouse_move((e, cx) => {
        this.captureGeometryFromRoot(e);
        if (this.drag) this.updateDragPointer(e, cx);
      })
      .on_mouse_up("left", (_e, cx) => this.finishDrag(cx))
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.drag) {
            this.drag = null;
            cx.notify();
          } else if (this.quickCol) {
            this.cancelQuickAdd(cx);
          }
        }
      })
      // Responsive top bar
      .child(
        v_flex()
          .flex_none()
          .border_b_1()
          .border_color(t.border)
          .child(
            h_flex()
              .px(14)
              .py(10)
              .gap(8)
              .items_center()
              .children([
                h_flex()
                  .w(28)
                  .h(28)
                  .flex_none()
                  .rounded(8)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .items_center()
                  .justify_center()
                  .text_color(t.accent)
                  .child(svg(ICON("kanban")).size(15)),
                div().font_semibold().text_size(15).text_color(t.foreground).child("Board"),
                ...(!compactHeader
                  ? [
                      div()
                        .text_size(12)
                        .text_color(t.dim)
                        .child(`${liveAgents.length} 活跃会话 · ${openTaskCount} 待办`),
                    ]
                  : []),
                div().flex_1(),
                ...(!tinyHeader ? [searchBox, followBtn] : []),
                h_flex()
                  .id("board-new-btn")
                  .h(28)
                  .px(11)
                  .gap(5)
                  .flex_none()
                  .items_center()
                  .rounded(7)
                  .bg(t.solid)
                  .text_color(t.solid_foreground)
                  .text_size(11.5)
                  .font_medium()
                  .cursor_pointer()
                  .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
                  .on_click(() => this.openCardForm({ column: "ideas" }))
                  .children([svg(ICON("plus")).size(13), "新建"]),
              ])
          )
          .when(tinyHeader, (el) =>
            el.child(
              h_flex()
                .px(14)
                .pb(9)
                .gap(8)
                .items_center()
                .children([searchBox, followBtn])
            )
          )
      )
      // Active project filter strip
      .when(projects.length > 0 || globalCount > 0, (el) =>
        el.child(
          h_flex()
            .flex_none()
            .px(14)
            .py(6)
            .gap(6)
            .items_center()
            .border_b_1()
            .border_color(t.border)
            .overflow_x_scroll()
            .children([
              h_flex()
                .id("pf-all")
                .flex_none()
                .h(24)
                .px(9)
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .text_size(11.5)
                .when(!this.followSpace && effFilter === "all", (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
                .when(this.followSpace || effFilter !== "all", (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
                .on_click((_e, cx) => { this.followSpace = false; this.projectFilter = "all"; cx.notify(); })
                .child("全部"),
              ...projects.map((p, idx) => {
                const k = projectKey(p);
                const active = effFilter === k;
                const n = projCounts.get(k) || 0;
                return h_flex()
                  .id(`pf-p-${idx}`)
                  .flex_none()
                  .h(24)
                  .px(9)
                  .gap(5)
                  .items_center()
                  .rounded(6)
                  .cursor_pointer()
                  .text_size(11.5)
                  .when(active, (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
                  .when(!active, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
                  .on_click((_e, cx) => {
                    this.followSpace = false;
                    this.projectFilter = active ? "all" : k;
                    cx.notify();
                  })
                  .children([
                    div().size(7).flex_none().rounded_full().bg(projectColor(k)),
                    projectLabel(p),
                    ...(n > 0 ? [div().text_size(10.5).text_color(t.dim).child(`${n}`)] : []),
                  ]);
              }),
              ...(globalCount > 0
                ? [
                    h_flex()
                      .id("pf-global")
                      .flex_none()
                      .h(24)
                      .px(9)
                      .gap(5)
                      .items_center()
                      .rounded(6)
                      .cursor_pointer()
                      .text_size(11.5)
                      .when(effFilter === "global", (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
                      .when(effFilter !== "global", (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
                      .on_click((_e, cx) => {
                        this.followSpace = false;
                        this.projectFilter = effFilter === "global" ? "all" : "global";
                        cx.notify();
                      })
                      .children(["全局", div().text_size(10.5).text_color(t.dim).child(`${globalCount}`)]),
                  ]
                : []),
            ])
        )
      )
      // Error banner
      .when(Boolean(this.err), (el) =>
        el.child(div().flex_none().px(14).py(8).text_size(12).text_color(t.blocked).child(this.err))
      )
      // Responsive board body
      .child(this.renderBoardBody(byColTasks, byColAgents, liveByAddr, t))
      // Floating lifted ghost card overlay
      .when(Boolean(ghost), (el) => el.child(ghost));
  }
}
