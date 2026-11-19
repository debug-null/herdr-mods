// Conversation map for the live Agent pane: a right-edge tick rail, one short
// bar per user turn in the *active tab's* agent session. Bound to that tab's
// pane — not whichever agent last held global focus (clicking the map must
// not jump to another space/agent).

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
    if (a === "--resume=session" || a.startsWith("--resume=")) return a.slice(a.indexOf("=") + 1) || b;
  }
  return null;
}

// Agent in the *shown* space + tab only. Never follow agents().focused after the
// map steals focus — that was switching people into another agent's space.
function targetAgent() {
  const space = spaces().find((s) => s.active);
  if (!space) return null;
  const tab = (space.tabs || []).find((t) => t.active) || (space.tabs || [])[0];
  if (!tab) return null;
  const tabPanes = panes().filter((p) => p.tab === tab.id && p.terminal && (p.status || p.program?.agent));
  const pane = tabPanes.find((p) => p.focused) || tabPanes[0] || null;
  if (!pane?.terminal) return null;
  const address = pane.terminal;
  const agent = agents().find((a) => a.address === address) || null;
  const term = terminals().find((t) => t.address === address) || null;
  const kind = agentKind(term, agent, pane);
  if (!kind) return null;
  return {
    address,
    pane: pane.pane,
    kind,
    cwd: pane.cwd || term?.cwd || term?.foreground?.cwd || null,
    machine: hostOf(address),
    resume: resumeId(term),
    turnHint: Number(term?.turn) || 0,
    title: agent?.title || pane.title || term?.title || "",
  };
}

export default class ConversationMap extends View {
  init(_props, cx) {
    this.turns = []; // [{ text }]
    this.active = 0;
    this.key = null;
    this.session = null;
    this.target = null;
    this.loading = false;
    this.error = null;
    this._jumping = false;
    if (checking()) return;
    cx.timer.every(POLL_MS, (cx) => {
      if (!this._jumping) this.refresh(cx);
    });
    this.refresh(cx);
  }

  // Jump inside the *same* tab agent only — never agent.focus (that switches spaces).
  jumpTo(k, cx) {
    const target = this.target;
    const turn = this.turns[k];
    if (!target?.address || !turn) return;
    this.active = k;
    this._jumping = true;
    cx.notify();

    // Keep keyboard on this pane; do not call agent.focus (cross-space).
    if (target.pane) run("pane.focus", { pane: target.pane });
    else run("pane.focus", { terminal: target.address });

    const n = Math.max(1, this.turns.length);
    if (k <= 0) run("terminal.scroll", { to: "top", terminal: target.address });
    else if (k >= n - 1) run("terminal.scroll", { to: "bottom", terminal: target.address });
    else {
      run("terminal.scroll", { to: "top", terminal: target.address });
      const pages = Math.max(0.5, (k / (n - 1)) * 12);
      cx.timer.after(80, () => run("terminal.scroll", { pages, terminal: target.address }));
    }

    if (this.session?.file) {
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
    }

    const label = (turn.text || `第 ${k + 1} 轮`).slice(0, 60);
    notify({
      title: "会话地图",
      body: `第 ${k + 1}/${this.turns.length} 轮 · ${label}`,
      level: "info",
      timeout: 2500,
    });
    cx.timer.after(600, (cx) => { this._jumping = false; cx.notify(); });
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
    // Prefer exact cwd match over "related" paths from list --cwd.
    const cwd = target.cwd;
    if (cwd) {
      const exact = mine.filter((s) => s.cwd === cwd);
      if (exact.length) return [...exact].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
    }
    return [...mine].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
  }

  refresh(cx, { force = false } = {}) {
    if (this._jumping && !force) return;
    const target = targetAgent();
    if (!target) {
      // Map click / History focus can clear pane focus — keep the pinned tab target.
      return;
    }
    const key = `${target.address}\0${target.kind}\0${target.resume || ""}\0${target.cwd || ""}`;
    if (!force && key === this.key && this.loading) return;
    if (!force && key === this.key && this.turns.length && Date.now() - (this.loadedAt || 0) < POLL_MS - 500) return;
    this.key = key;
    this.target = target;
    this.loading = true;
    if (!this.turns.length && target.turnHint > 0) {
      this.turns = Array.from({ length: Math.min(target.turnHint, 48) }, (_, i) => ({ text: `第 ${i + 1} 轮` }));
      this.active = this.turns.length - 1;
      cx.notify();
    }
    cx.spawn(async (cx) => {
      try {
        let sessions = [];
        const listArgs = target.cwd ? ["list", "--cwd", target.cwd] : ["list"];
        const listed = await this.historyExec(target.machine, listArgs);
        if (listed.code === 0 && listed.stdout) sessions = JSON.parse(listed.stdout);
        if (this.key !== key) return;
        const session = this.pickSession(sessions, target);
        this.session = session
          ? { ...session, _host: target.machine || "local" }
          : null;
        if (!session?.file) {
          const n = Math.max(target.turnHint, session?.turns || 0);
          this.turns = n > 0 ? Array.from({ length: Math.min(n, 48) }, (_, i) => ({ text: `第 ${i + 1} 轮` })) : [];
          this.active = Math.max(0, this.turns.length - 1);
          this.error = null;
          this.loadedAt = Date.now();
          return;
        }
        const n = Math.max(session.turns || 0, target.turnHint || 0);
        if (n > this.turns.length) {
          this.turns = Array.from({ length: Math.min(n, 48) }, (_, i) => ({
            text: this.turns[i]?.text || `第 ${i + 1} 轮`,
          }));
          this.active = this.turns.length - 1;
          cx.notify();
        }
        const shown = await this.historyExec(target.machine, ["show", session.agent, session.file]);
        if (this.key !== key) return;
        if (shown.code !== 0) throw new Error((shown.stderr || shown.stdout || "").trim() || `exit ${shown.code}`);
        const data = JSON.parse(shown.stdout || "{}");
        const messages = data.messages || [];
        const fromShow = messages
          .filter((m) => m.role === "user")
          .map((m) => ({ text: (m.text || "").replace(/\s+/g, " ").trim() }));
        if (fromShow.length >= this.turns.length) this.turns = fromShow;
        else if (fromShow.length) {
          const head = Math.max(0, this.turns.length - fromShow.length);
          this.turns = [...this.turns.slice(0, head), ...fromShow];
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
      const nextKey = `${target.address}\0${target.kind}\0${target.resume || ""}\0${target.cwd || ""}`;
      if (nextKey !== this.key && !this._jumping) this.refresh(cx, { force: true });
    }
    const turns = this.turns;
    const shown = this.target;
    if (!shown || !turns.length) {
      return div().id("conversation-map").size_full().bg(t.canvas);
    }
    return v_flex().id("conversation-map").size_full().py(8).items_center().justify_center()
      .bg(t.background).border_1().border_color(t.border).rounded(10)
      .tooltip(`会话地图 · ${shown.title || shown.kind} · ${turns.length} 轮`)
      .children(turns.map((turn, k) => {
        const on = k === this.active;
        const title = turn.text.length > 28 ? `${turn.text.slice(0, 28)}…` : (turn.text || `第 ${k + 1} 轮`);
        const tip = `Turn ${k + 1}/${turns.length} · ${title}${turn.text.length > 28 ? `\n${turn.text.slice(0, 120)}${turn.text.length > 120 ? "…" : ""}` : ""}`;
        return div().id(`cmap-${k}`).w_full().flex_1().min_h(4).max_h(14).flex().items_center().justify_center().cursor_pointer()
          .tooltip(tip)
          .on_click((_e, cx) => { cx.stop_propagation(); this.jumpTo(k, cx); })
          .child(div().flex_none().rounded(99).h(on ? 3 : 2)
            .w(on ? 16 : 10).bg(on ? t.accent : t.muted)
            .hover((s) => s.w(16).bg(t.accent)));
      }));
  }
}
