// helpers.js — Scheduler 工具函数：路径、时间格式化、Cron 解析说明、状态读写。
import { appHome, panes, readTextFile, spaces, writeTextFile } from "herdr";

export const DIR = () => `${appHome()}/sched`;
export const REFLECT_DIR = () => `${appHome()}/reflections`;
export const JOBS = () => `${DIR()}/jobs.json`;
export const STATE = () => `${DIR()}/state.json`;
export const RUNNOW = () => `${DIR()}/run-now`;
export const LOGFILE = () => `${DIR()}/engine.log`;
export const ENGINE = () => `${DIR()}/engine.py`;
export const ENGINE_NAME = "sched-engine";
export const ICON = (name) => `mods/sched/icons/${name}.svg`;

export const tilde = (p) => (p ? p.replace(/^\/Users\/[^/]+/, "~") : "");

export function activeCwd() {
  const sp = spaces().find((s) => s.active);
  if (!sp) return "";
  const tabs = new Set((sp.tabs || []).map((t) => t.id));
  const cwd = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || sp.folder || "";
  return tilde(cwd);
}

export function ago(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 5) return "刚刚";
  if (s < 60) return `${Math.floor(s)}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}时前`;
  return `${Math.floor(s / 86400)}天前`;
}

export function until(ts) {
  if (!ts) return "—";
  const s = ts - Date.now() / 1000;
  if (s <= 0) return "即将执行";
  if (s < 60) return `${Math.ceil(s)}秒后`;
  if (s < 3600) return `${Math.ceil(s / 60)}分后`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}时${m}分后` : `${h}小时后`;
  }
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtDur(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function fmtLocalAt(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const DOW_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function schedText(s = {}) {
  if (s.every_min != null) {
    const m = Number(s.every_min);
    if (m >= 60 && m % 60 === 0) return `每 ${m / 60} 小时`;
    return `每 ${m} 分钟`;
  }
  if (s.cron) {
    const parts = String(s.cron).trim().split(/\s+/);
    if (parts.length === 5) {
      const [min, hr, dom, mon, dow] = parts;
      const pad2 = (x) => String(x).padStart(2, "0");
      if (min.startsWith("*/") && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
        return `每 ${min.slice(2)} 分钟`;
      }
      if (/^\d+$/.test(min) && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
        return min === "0" ? "每小时整点" : `每小时 :${pad2(min)}`;
      }
      if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === "*" && mon === "*") {
        const tm = `${pad2(hr)}:${pad2(min)}`;
        if (dow === "*") return `每天 ${tm}`;
        if (dow === "1-5") return `工作日 ${tm}`;
        if (dow === "0,6" || dow === "6,0" || dow === "6,7") return `周末 ${tm}`;
        if (/^\d$/.test(dow)) return `每${DOW_NAMES[Number(dow)]} ${tm}`;
      }
    }
    return `cron · ${s.cron}`;
  }
  if (s.at) return `一次 · ${s.at.replace("T", " ")}`;
  return "未配置";
}

export function schedRawTip(s = {}) {
  if (s.cron) return `Cron 表达式：${s.cron}`;
  if (s.every_min != null) return `固定间隔：每 ${s.every_min} 分钟`;
  if (s.at) return `单次定时：${s.at.replace("T", " ")}`;
  return "";
}

export function extractMdPath(text, userHome) {
  if (!text) return null;
  const m = String(text).match(/(~\/[^\s，。；）)"']+\.md|\/[^\s，。；）)"']+\.md)/);
  if (!m) return null;
  const p = m[1];
  return p.startsWith("~/") && userHome ? `${userHome}${p.slice(1)}` : p;
}

/** 轻量校验 5 段 cron 并返回可读中文提示 */
export function describeCron(expr) {
  const parts = (expr || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return { ok: false, text: "需要 5 段：分 时 日 月 周（如 0 9 * * 1-5）" };
  const [min, hr, dom, mon, dow] = parts;
  const checkRange = (spec, lo, hi) => {
    for (const part of spec.split(",")) {
      if (!part) return false;
      const [body, st] = part.split("/");
      if (st !== undefined && (!/^\d+$/.test(st) || Number(st) < 1)) return false;
      if (body === "*" || body === "") continue;
      if (body.includes("-")) {
        const [a, b] = body.split("-");
        if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
        const na = Number(a);
        const nb = Number(b);
        if (na < lo || nb > hi || na > nb) return false;
      } else {
        if (!/^\d+$/.test(body)) return false;
        const n = Number(body);
        if (n < lo || n > hi) return false;
      }
    }
    return true;
  };
  if (
    !checkRange(min, 0, 59) ||
    !checkRange(hr, 0, 23) ||
    !checkRange(dom, 1, 31) ||
    !checkRange(mon, 1, 12) ||
    !checkRange(dow, 0, 7)
  ) {
    return { ok: false, text: "表达式字段超出合法范围" };
  }
  const pad2 = (x) => String(x).padStart(2, "0");
  if (min.startsWith("*/") && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ok: true, text: `每 ${min.slice(2)} 分钟执行一次` };
  }
  if (/^\d+$/.test(min) && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ok: true, text: `每小时的第 ${pad2(min)} 分执行` };
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === "*" && mon === "*") {
    const tstr = `${pad2(hr)}:${pad2(min)}`;
    if (dow === "*") return { ok: true, text: `每天 ${tstr} 执行` };
    if (dow === "1-5") return { ok: true, text: `工作日（周一至周五）${tstr} 执行` };
    if (dow === "0,6" || dow === "6,0" || dow === "6,7") return { ok: true, text: `周末 ${tstr} 执行` };
    if (/^\d$/.test(dow)) return { ok: true, text: `每${DOW_NAMES[Number(dow)]} ${tstr} 执行` };
    return { ok: true, text: `按周 (${dow}) ${tstr} 执行` };
  }
  return { ok: true, text: `合法 5 段 Cron（分:${min} 时:${hr} 日:${dom} 月:${mon} 周:${dow}）` };
}

export function actionMeta(a = {}) {
  if (a.type === "prompt") {
    return {
      kind: "prompt",
      label: "发消息",
      icon: "message",
      summary: `→ ${a.terminal || "?"}${a.if === "idle" ? " (空闲时)" : ""}: ${(a.text || "").replace(/\s+/g, " ").trim()}`,
    };
  }
  if (a.type === "spawn") {
    const argv = (a.argv || []).join(" ");
    const task = (a.task || "").replace(/\s+/g, " ").trim();
    return {
      kind: "spawn",
      label: "新 Agent",
      icon: "sparkles",
      summary: `${argv || "agent"}${task ? ` · ${task}` : ""}${a.folder ? ` (${tilde(a.folder)})` : ""}`,
    };
  }
  const cmd = (a.cmd || "").replace(/\s+/g, " ").trim();
  return {
    kind: "exec",
    label: "Shell",
    icon: "terminal",
    summary: `${a.cwd ? `${tilde(a.cwd)} $ ` : "$ "}${cmd}`,
  };
}

export async function saveJobsAtomic(mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const old = await readTextFile(JOBS()).catch(() => null);
    let data;
    try {
      data = JSON.parse(old || '{"jobs":[]}');
      if (!Array.isArray(data.jobs)) data.jobs = [];
    } catch {
      data = { jobs: [] };
    }
    mutate(data.jobs);
    const next = JSON.stringify(data, null, 2) + "\n";
    try {
      await writeTextFile(JOBS(), next, old);
      return { ok: true, next, jobs: data.jobs };
    } catch {
      /* stale snapshot, retry */
    }
  }
  return { ok: false };
}

export function cloneJobRecord(job) {
  const copy = JSON.parse(JSON.stringify(job));
  copy.id = `j${Date.now().toString(36)}`;
  copy.name = `${job.name || job.id} (副本)`;
  copy.enabled = false;
  return copy;
}
