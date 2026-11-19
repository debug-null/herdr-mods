// Conversation map for the Agent in the *active space + tab* only.
// Click selects a turn in that same session — never agent.focus / never jump
// to another space (that was sending people into claude-code-web).

import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { agents, terminals, panes, spaces, exec, appHome, theme, checking, run, notify, setShared } from "herdr";

const SCRIPT = () => `${appHome()}/mods/history/history.py`;
const REMOTE_SCRIPT = '"$HOME/.config/herdr-app/mods/history/history.py"';
const POLL_MS = 4000;

const APP_TO_AGENT = {
  "claude-code": "claude",
  claude: "claude",
  codex: "codex",
  pi: "pi",
  "cursor-agent": "cursor",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  agy: "antigravity",
  devin: "devin",
};

const KEY_TO_AGENT = {
  claude: "claude",
  codex: "codex",
  pi: "pi",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  devin: "devin",
};

function hostOf(address) {
  if (!address || !address.includes("/")) return null;
  return address.split("/")[0];
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function agentKind(term, agent, pane) {
  const app = agent?.app || pane?.app || term?.status?.app || term?.report?.app || null;
  if (app && APP_TO_AGENT[app]) return APP_TO_AGENT[app];
  const key = term?.program?.key || agent?.program?.key || pane?.program?.key;
  if (key && KEY_TO_AGENT[key]) return KEY_TO_AGENT[key];
  const argv0 = term?.foreground?.argv?.[0] || term?.argv?.[0] || "";
  const base = String(argv0).split("/").pop().toLowerCase();
  if (base.includes("claude")) return "claude";
  if (base.includes("codex")) return "codex";
  if (base.includes("cursor")) return "cursor";
  if (base === "pi") return "pi";
  if (base.includes("opencode")) return "opencode";
  if (base.includes("devin")) return "devin";
  if (base.includes("agy") || base.includes("antigravity")) return "antigravity";
  return null;
}

function resumeId(term) {
  const argv = term?.foreground?.argv || term?.argv || [];
  for (let i = 0; i < argv.length - 1; i++) {
    const a = String(argv[i]);
    const b = String(argv[i + 1]);
    if (a === "--resume" || a === "resume" || a === "--session" || a === "--conversation") return b;
    if (a.startsWith("--resume=")) return a.slice(a.indexOf("=") + 1) || b;
  }
  return null;
}

function activeSpaceTab() {
  const space = spaces().find((s) => s.active);
  if (!space) return null;
  const tab = (space.tabs || []).find((t) => t.active) || (space.tabs || [])[0];
  if (!tab) return null;
  return { space, tab };
}

// Strictly the agent living in the shown space+tab (via agents().space/tab).
function targetAgent() {
  const loc = activeSpaceTab();
  if (!loc) return null;
  const { space, tab } = loc;

  const inTab = agents().filter((a) => a.space === space.id && a.tab === tab.id);
  let agent = inTab.find((a) => a.focused) || inTab[0] || null;

  // Fallback through panes of this tab only.
  let pane = panes().find((p) => p.tab === tab.id && p.terminal === agent?.address) || null;
  if (!agent) {
    const tabPanes = panes().filter((p) => p.tab === tab.id && p.terminal && (p.status || p.program?.agent));
    pane = tabPanes.find((p) => p.focused) || tabPanes[0] || null;
    if (pane?.terminal) agent = agents().find((a) => a.address === pane.terminal) || null;
  }
  if (!agent && !pane?.terminal) return null;

  const address = agent?.address || pane.terminal;
  // Refuse anything that isn't actually in this tab.
  const stillInTab = agents().some((a) => a.address === address && a.space === space.id && a.tab === tab.id)
    || panes().some((p) => p.terminal === address && p.tab === tab.id);
  if (!stillInTab) return null;

  const term = terminals().find((t) => t.address === address) || null;
  const kind = agentKind(term, agent, pane);
  if (!kind) return null;
  return {
    address,
    pane: pane?.pane || agent?.pane || null,
    space: space.id,
    tab: tab.id,
    kind,
    cwd: pane?.cwd || term?.cwd || term?.foreground?.cwd || null,
    machine: hostOf(address),
    resume: resumeId(term),
    turnHint: Number(term?.turn) || 0,
    title: agent?.title || pane?.title || term?.title || "",
  };
}

function sameSlot(a, b) {
  return a && b && a.address === b.address && a.space === b.space && a.tab === b.tab;
}

export default class ConversationMap extends View {
  init(_props, cx) {
    this.turns = [];
    this.active = 0;
    this.key = null;
    this.session = null;
    this.target = null;
    this.loading = false;
    this.error = null;
    if (checking()) return;
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  // Stay on this tab's agent. Normal click: highlight + scroll this terminal only.
  // Shift-click: also open History at that turn (explicit).
  jumpTo(k, e, cx) {
    const target = this.target;
    const turn = this.turns[k];
    if (!target?.address || !turn) return;

    // Re-check we're still on the same space/tab — never act on a stale target.
    const live = targetAgent();
    if (!sameSlot(live, target)) {
      notify({ title: "会话地图", body: "当前 Tab 的 Agent 已切换，已刷新地图", level: "warn", timeout: 2500 });
      this.refresh(cx, { force: true });
      return;
    }

    this.active = k;
    cx.notify();

    const n = Math.max(1, this.turns.length);
    if (k <= 0) run("terminal.scroll", { to: "top", terminal: target.address });
    else if (k >= n - 1) run("terminal.scroll", { to: "bottom", terminal: target.address });
    else {
      run("terminal.scroll", { to: "top", terminal: target.address });
      const pages = Math.max(0.5, (k / (n - 1)) * 12);
      cx.timer.after(80, () => run("terminal.scroll", { pages, terminal: target.address }));
    }

    const label = (turn.text || `第 ${k + 1} 轮`).slice(0, 80);
    const shift = Boolean(e?.modifiers?.shift || e?.shift);
    if (shift && this.session?.file) {
      const needle = (turn.text || "").replace(/\s+/g, " ").trim();
      setShared("history.jump", {
        at: Date.now(),
        host: this.session._host || target.machine || "local",
        agent: this.session.agent,
        id: this.session.id,
        file: this.session.file,
        cwd: this.session.cwd || target.cwd || null,
        title: this.session.title || "",
        turns: this.session.turns || this.turns.length,
        updated: this.session.updated || Date.now(),
        created: this.session.created || Date.now(),
        _home: this.session._home || null,
        turn: k,
        needle: /^第 \d+ 轮$/.test(needle) ? null : needle.slice(0, 80),
      });
      run("layout.select", { stack: "panel-body", child: "history" });
      run("layout.show", { id: "panel" });
      notify({ title: "会话地图", body: `History · 第 ${k + 1}/${this.turns.length} 轮`, level: "info", timeout: 2000 });
    } else {
      notify({
        title: `${target.title || target.kind} · 第 ${k + 1}/${this.turns.length} 轮`,
        body: label || "（无摘要）",
        level: "info",
        timeout: 3500,
      });
    }
  }

  async historyExec(machine, args) {
    if (!machine) return exec("python3", [SCRIPT(), ...args]);
    const argv = args.map(shQuote).join(" ");
    return exec("sh", ["-lc", `python3 ${REMOTE_SCRIPT} ${argv}`], { on: machine });
  }

  pickSession(sessions, target) {
    const mine = (sessions || []).filter((s) => s.agent === target.kind);
    if (!mine.length) return null;
    if (target.resume) {
      const hit = mine.find((s) => s.id === target.resume || (s.file || "").includes(target.resume));
      if (hit) return hit;
    }
    const cwd = target.cwd;
    if (cwd) {
      const exact = mine.filter((s) => s.cwd === cwd);
      if (exact.length) return [...exact].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
    }
    return null; // do not fall back to "newest anywhere" — that cross-wired agents
  }

  refresh(cx, { force = false } = {}) {
    const target = targetAgent();
    if (!target) {
      if (this.turns.length || this.target) {
        this.turns = [];
        this.session = null;
        this.target = null;
        this.key = null;
        cx.notify();
      }
      return;
    }
    const key = `${target.space}\0${target.tab}\0${target.address}\0${target.resume || ""}`;
    if (!force && key === this.key && this.loading) return;
    if (!force && key === this.key && this.turns.length && Date.now() - (this.loadedAt || 0) < POLL_MS - 500) return;

    // Tab/agent changed: drop previous session immediately so ticks never linger.
    if (this.key && this.key !== key) {
      this.turns = [];
      this.session = null;
      this.active = 0;
    }
    this.key = key;
    this.target = target;
    this.loading = true;

    const hint = Math.min(target.turnHint || 0, 48);
    if (hint > 0 && !this.turns.length) {
      this.turns = Array.from({ length: hint }, (_, i) => ({ text: `第 ${i + 1} 轮` }));
      this.active = hint - 1;
      cx.notify();
    }

    cx.spawn(async (cx) => {
      try {
        let sessions = [];
        if (target.cwd) {
          const listed = await this.historyExec(target.machine, ["list", "--cwd", target.cwd]);
          if (listed.code === 0 && listed.stdout) sessions = JSON.parse(listed.stdout);
        }
        if (this.key !== key) return;
        const session = this.pickSession(sessions, target);
        this.session = session ? { ...session, _host: target.machine || "local" } : null;

        const n = Math.max(session?.turns || 0, target.turnHint || 0);
        if (n > 0 && n !== this.turns.length) {
          this.turns = Array.from({ length: Math.min(n, 48) }, (_, i) => ({
            text: this.turns[i]?.text && !/^第 \d+ 轮$/.test(this.turns[i].text)
              ? this.turns[i].text
              : `第 ${i + 1} 轮`,
          }));
          this.active = this.turns.length - 1;
          cx.notify();
        }

        if (!session?.file) {
          this.error = null;
          this.loadedAt = Date.now();
          return;
        }

        const shown = await this.historyExec(target.machine, ["show", session.agent, session.file]);
        if (this.key !== key) return;
        if (shown.code !== 0) throw new Error((shown.stderr || shown.stdout || "").trim() || `exit ${shown.code}`);
        const data = JSON.parse(shown.stdout || "{}");
        const fromShow = (data.messages || [])
          .filter((m) => m.role === "user")
          .map((m) => ({ text: (m.text || "").replace(/\s+/g, " ").trim() }));
        if (fromShow.length >= (session.turns || 0) || fromShow.length >= this.turns.length) {
          this.turns = fromShow;
        } else if (fromShow.length && this.turns.length >= fromShow.length) {
          const head = this.turns.length - fromShow.length;
          this.turns = [...this.turns.slice(0, head).map((t, i) => ({
            text: t.text && !/^第 \d+ 轮$/.test(t.text) ? t.text : `第 ${i + 1} 轮`,
          })), ...fromShow];
        }
        this.active = Math.max(0, this.turns.length - 1);
        this.error = null;
        this.loadedAt = Date.now();
      } catch (e) {
        if (this.key === key) this.error = String(e);
      } finally {
        if (this.key === key) this.loading = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const target = targetAgent();
    if (target) {
      const nextKey = `${target.space}\0${target.tab}\0${target.address}\0${target.resume || ""}`;
      if (nextKey !== this.key) this.refresh(cx, { force: true });
    } else if (this.target) {
      this.refresh(cx, { force: true });
    }

    const turns = this.turns;
    const shown = this.target;
    if (!shown || !turns.length) {
      return div().id("conversation-map").size_full().bg(t.canvas);
    }
    return v_flex().id("conversation-map").size_full().py(8).items_center().justify_center()
      .bg(t.background).border_1().border_color(t.border).rounded(10)
      .tooltip(`会话地图 · ${shown.title || shown.kind} · ${turns.length} 轮\n点击定位本会话；Shift+点击打开 History`)
      .children(turns.map((turn, k) => {
        const on = k === this.active;
        const title = turn.text.length > 28 ? `${turn.text.slice(0, 28)}…` : (turn.text || `第 ${k + 1} 轮`);
        const tip = `Turn ${k + 1}/${turns.length} · ${title}`;
        return div().id(`cmap-${k}`).w_full().flex_1().min_h(4).max_h(14).flex().items_center().justify_center().cursor_pointer()
          .tooltip(tip)
          .on_click((e, cx) => { cx.stop_propagation(); this.jumpTo(k, e, cx); })
          .child(div().flex_none().rounded(99).h(on ? 3 : 2)
            .w(on ? 16 : 10).bg(on ? t.accent : t.muted)
            .hover((s) => s.w(16).bg(t.accent)));
      }));
  }
}
