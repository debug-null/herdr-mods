// helpers.js — Board 看板工具函数：列定义、项目识别与稳定配色、原子持久化、实时 Agent 项目提取。
import { agents, appHome, panes, readTextFile, spaces, writeTextFile } from "herdr";

export const DIR = () => `${appHome()}/board`;
export const TASKS_FILE = () => `${DIR()}/tasks.json`;
export const ICON = (name) => `mods/board/icons/${name}.svg`;

export const COLUMNS = [
  { id: "ideas", label: "灵感池", icon: "lightbulb", tone: "muted", empty: "有想法先放这里" },
  { id: "todo", label: "待开发", icon: "list-todo", tone: "accent", empty: "明确要做的任务" },
  { id: "doing", label: "进行中", icon: "spinner", tone: "working", empty: "活跃会话或进行中" },
  { id: "review", label: "待验收", icon: "eye", tone: "blocked", empty: "待回复或待验收" },
  { id: "done", label: "已完成", icon: "circle-check", tone: "done", empty: "已完成的工作" },
];

export const COL_IDS = COLUMNS.map((c) => c.id);

export const PRIORITIES = [
  { id: "p1", label: "高优", short: "P1", tone: "blocked" },
  { id: "p2", label: "常规", short: "P2", tone: "accent" },
  { id: "p3", label: "低优", short: "P3", tone: "dim" },
];

const PALETTE = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a"];

export function projectColor(key) {
  if (!key || key === "global") return "#8b949e";
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function uid() {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export function tilde(p) {
  return p ? String(p).replace(/^\/Users\/[^/]+/, "~") : "";
}

export function baseName(p) {
  return p ? String(p).replace(/\/+$/, "").split("/").pop() || p : "";
}

export function projectKey(proj) {
  if (!proj) return "global";
  const m = proj.machine || "local";
  const p = (proj.path || proj.name || "").replace(/\/+$/, "");
  return `${m}::${p.toLowerCase()}`;
}

export function projectLabel(proj) {
  if (!proj) return "全局";
  const name = proj.name || baseName(proj.path) || "未命名项目";
  return proj.machine ? `${proj.machine} · ${name}` : name;
}

export function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}天前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 根据实时 agent 推导其所属项目（优先取该 pane 的实时 cwd，其次取所属 space） */
export function projectOfAgent(ag) {
  const sp = spaces().find((s) => s.id === ag.space);
  const pane = panes().find((p) => p.pane === ag.pane);
  const path = pane?.cwd || sp?.folder || null;
  const name = ag.space_name || sp?.name || baseName(path) || "未命名";
  return {
    name,
    path,
    machine: sp?.machine || null,
    spaceId: sp?.id || ag.space || null,
  };
}

export function activeSpaceProject() {
  const sp = spaces().find((s) => s.active);
  if (!sp) return null;
  const tabs = new Set((sp.tabs || []).map((t) => t.id));
  const cwd = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || sp.folder || "";
  const name = sp.name || baseName(cwd) || "当前项目";
  return { name, path: cwd || null, machine: sp.machine || null, spaceId: sp.id };
}

/** 仅提取当前有活跃 Agent 的项目（用于新建任务弹窗，避免无关项目干扰） */
export function activeAgentProjects() {
  const map = new Map();
  for (const ag of agents()) {
    const proj = projectOfAgent(ag);
    const k = projectKey(proj);
    if (!map.has(k)) map.set(k, proj);
  }
  return [...map.values()];
}

/** 仅提取当前有活跃 Agent 或已有任务的项目（用于看板顶部项目筛选条，零空壳噪音） */
export function activeFilterProjects(tasks = []) {
  const map = new Map();
  for (const ag of agents()) {
    const proj = projectOfAgent(ag);
    const k = projectKey(proj);
    if (!map.has(k)) map.set(k, proj);
  }
  for (const t of tasks) {
    if (!t.project) continue;
    const k = projectKey(t.project);
    if (!map.has(k)) {
      map.set(k, {
        name: t.project.name || baseName(t.project.path) || "未命名",
        path: t.project.path || null,
        machine: t.project.machine || null,
      });
    }
  }
  return [...map.values()];
}

export function cleanTitle(s) {
  return (s || "")
    .replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "")
    .replace(/^\[ [!.] \] /, "")
    .trim();
}

export async function saveTasksAtomic(mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const old = await readTextFile(TASKS_FILE()).catch(() => null);
    let data;
    try {
      data = JSON.parse(old || '{"version":1,"tasks":[]}');
      if (!Array.isArray(data.tasks)) data.tasks = [];
    } catch {
      data = { version: 1, tasks: [] };
    }
    mutate(data.tasks);
    const next = JSON.stringify(data, null, 2) + "\n";
    try {
      await writeTextFile(TASKS_FILE(), next, old);
      return { ok: true, next, tasks: data.tasks };
    } catch {
      /* stale snapshot, retry */
    }
  }
  return { ok: false };
}
