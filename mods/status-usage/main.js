import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, home, readTextFile } from "herdr";

// The usage endpoints are rate limited; five minutes is fresh enough for a status bar.
const REFRESH_MS = 5 * 60 * 1000;

// Normalized usage: { windows: [{ label, used, resetsAt (ms) }] } or { error }.
async function claudeUsage() {
  let raw = null;
  // macOS keeps Claude Code's OAuth credentials in the keychain; Linux in a file.
  const r = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]).catch(() => null);
  if (r && r.code === 0) raw = r.stdout.trim();
  else raw = await readTextFile(`${home()}/.claude/.credentials.json`);
  const token = raw && JSON.parse(raw)?.claudeAiOauth?.accessToken;
  if (!token) return { error: "未登录" };
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const d = await res.json();
  const win = (label, w) => w && { label, used: w.utilization, resetsAt: Date.parse(w.resets_at) };
  return { windows: [win("5小时", d.five_hour), win("7天", d.seven_day)].filter(Boolean) };
}

async function codexUsage() {
  const raw = await readTextFile(`${home()}/.codex/auth.json`);
  const tokens = raw && JSON.parse(raw)?.tokens;
  if (!tokens?.access_token) return { error: "未登录" };
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id ?? "" },
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const d = await res.json();
  const win = (label, w) => w && { label, used: w.used_percent, resetsAt: w.reset_at * 1000 };
  const rl = d.rate_limit ?? {};
  return { windows: [win("5小时", rl.primary_window), win("7天", rl.secondary_window)].filter(Boolean) };
}

function untilText(ms) {
  const mins = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (mins >= 1440) return `${Math.floor(mins / 1440)}天${Math.floor((mins % 1440) / 60)}小时`;
  if (mins >= 60) return `${Math.floor(mins / 60)}小时${mins % 60}分`;
  return `${mins}分钟`;
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.usage = {};
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    const load = (key, fn) => cx.spawn(async (cx) => {
      try { this.usage[key] = await fn(); }
      catch (e) { this.usage[key] = { error: String(e?.message ?? e) }; }
      cx.notify();
    });
    load("claude", claudeUsage);
    load("codex", codexUsage);
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  命令面板` : "命令面板";
  }

  // One provider: "Claude 5h 96% · 7d 35%", each number the share left.
  quota(t, key, name) {
    const u = this.usage[key];
    const color = (left) => left <= 10 ? t.blocked : left <= 30 ? t.ansi3 : t.muted;
    let body, tip;
    if (!u) {
      body = [div().text_color(t.dim).child("…")];
      tip = `${name}：加载中`;
    } else if (u.error) {
      body = [div().text_color(t.dim).child("—")];
      tip = `${name}：${u.error}（点击重试）`;
    } else {
      body = u.windows.flatMap((w, i) => {
        const left = Math.max(0, Math.round(100 - w.used));
        return [
          ...(i > 0 ? [div().text_color(t.dim).child("·")] : []),
          div().text_color(t.dim).child(w.label),
          div().text_color(color(left)).child(`${left}%`),
        ];
      });
      tip = `${name} 剩余 · ` + u.windows.map((w) => `${w.label}窗口 ${untilText(w.resetsAt)}后重置`).join(" · ") + "（点击刷新）";
    }
    return h_flex().id(`quota-${key}`).gap(4).items_center().cursor_pointer().tooltip(tip)
      .on_click((_e, cx) => this.refresh(cx))
      .child(div().text_color(t.foreground).child(name))
      .children(body);
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "本机"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} 个智能体`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} 个需要你`))))
      .child(div().flex_1())
      .child(this.quota(t, "claude", "Claude"))
      .child(this.quota(t, "codex", "Codex"))
      .child(div().id("palette").text_color(t.dim).cursor_pointer().on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
