import { View, div, svg, image, list } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, appHome, home, theme, settings, run, notify, shared, setShared } from "herdr";

// One entry per agent whose transcripts history.py can read. `resume` builds
// the command that reopens a session in its own folder.
const AGENTS = {
  claude: { name: "Claude", icon: "icons/claude.svg", tint: false, resume: (s) => ["claude", "--resume", s.id] },
  codex: { name: "Codex", icon: "icons/codex.svg", tint: false, resume: (s) => ["codex", "resume", s.id] },
  pi: { name: "Pi", icon: "icons/pi.svg", tint: true, resume: (s) => ["pi", "--session", s.file] },
  cursor: { name: "Cursor", icon: "icons/cursor.svg", tint: false, resume: (s) => ["cursor", "agent", "--resume", s.id] },
  opencode: { name: "OpenCode", icon: "icons/opencode.svg", tint: false, resume: (s) => ["opencode", "--session", s.id] },
  antigravity: { name: "Antigravity", icon: "icons/antigravity.svg", tint: false, resume: (s) => ["agy", "--conversation", s.id] },
  devin: { name: "Devin", icon: "icons/devin.png", tint: false, resume: (s) => ["devin", "--resume", s.id] },
};
const SCRIPT = () => `${appHome()}/mods/history/history.py`;
const REMOTE_SCRIPT_EXPR = '"$HOME/.config/herdr-app/mods/history/history.py"';
const TOOL_LINES = 6;
const PAGE = 100; // sessions shown per "加载更多"
const GLOBAL_DAYS = 3; // 全局默认只看最近几天，避免跨机器列表过长
const STORE = "history.index";
const PIN_STORE = "history.pins"; // { "host\\0agent\\0id": { at } } — survives restart
const CACHE_TTL_MS = 60_000;
const BG_REFRESH_MS = 45_000;
const SCRIPT_SYNC = "history.script";

// The directory the panel follows: cwd inside the active space (focused pane),
// not the space root alone. Filter by this path — do not lift to the git root
// unless the user picks 「本仓库」.
function location() {
  const space = spaces().find((s) => s.active);
  const tabIds = new Set((space?.tabs ?? []).map((t) => t.id));
  const mine = panes().filter((p) => tabIds.has(p.tab));
  const focusedPane = mine.find((p) => p.focused) || mine.find((p) => p.cwd) || null;
  const f = focused();
  const cwd =
    focusedPane?.cwd ||
    (f?.pane && mine.some((p) => p.pane === f.pane) ? f.cwd : null) ||
    (space?.folder && space.folder !== "/" ? space.folder : null) ||
    null;
  return { cwd, machine: space?.machine || null, space };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hostKey(machine) {
  return machine || "local";
}

function hostLabel(host) {
  return !host || host === "local" ? "本机" : host;
}

/** Machines that appear in the header spaces list (always includes local). */
function knownHosts() {
  const map = new Map([["local", null]]);
  for (const s of spaces()) map.set(hostKey(s.machine), s.machine || null);
  return [...map.entries()].map(([host, machine]) => ({ host, machine }));
}

function indexStore() {
  const value = shared(STORE);
  return value && typeof value === "object" ? value : { hosts: {} };
}

function scriptStore() {
  const value = shared(SCRIPT_SYNC);
  return value && typeof value === "object" ? value : {};
}

function cacheFresh(host, { full = false } = {}) {
  const hit = indexStore().hosts?.[host];
  if (!hit?.sessions?.length) return false;
  if (full && hit.full === false) return false; // narrow seed must still revalidate
  return Date.now() - (hit.at || 0) < CACHE_TTL_MS;
}

/** Merge per-host caches into one newest-first list, tagged with `_host` / `_home`. */
function mergeGlobalSessions() {
  const store = indexStore();
  const out = [];
  const seen = new Set();
  for (const { host } of knownHosts()) {
    const hit = store.hosts?.[host];
    if (!hit?.sessions?.length) continue;
    for (const s of hit.sessions) {
      const key = `${host}\0${s.agent}\0${s.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...s, _host: host, _home: hit.home || null });
    }
  }
  out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return out;
}

function sessionHost(session) {
  return session?._host || "local";
}

function sessionMachine(session) {
  const host = sessionHost(session);
  return host === "local" ? null : host;
}

function pinKey(session) {
  return `${sessionHost(session)}\0${session?.agent || ""}\0${session?.id || ""}`;
}

function pinMap() {
  const value = shared(PIN_STORE);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isPinned(session) {
  return Boolean(pinMap()[pinKey(session)]);
}

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function clock(ms) {
  if (!ms) return "";
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const inside = (path, root) => Boolean(path && root && (path === root || path.startsWith(root.endsWith("/") ? root : root + "/")));
const short = (path, home) => (path && home && path.startsWith(home) ? "~" + path.slice(home.length) : path ?? "");

function inScope(session, scope, root, repo) {
  const cwd = session?.cwd;
  if (scope === "all" || scope === "global") return true;
  if (!cwd) return false; // unknowns only under 全部 / 全局
  if (scope === "repo") return Boolean(repo && inside(cwd, repo));
  return inside(cwd, root);
}

function inGlobalWindow(session) {
  const cutoff = Date.now() - GLOBAL_DAYS * 86400 * 1000;
  return (session?.updated || 0) >= cutoff;
}

export default class History extends View {
  init(_props, cx) {
    this.home = home(); this.sessions = []; this.agent = "all"; this.scope = "here"; this.query = "";
    this.open = null; this.transcript = null; this.typing = false;
    this.host = null; // which machine the current index was built for
    this.repo = null; this.stale = false; this.loadingLabel = null;
    this.shown = PAGE; // how many filtered sessions to render (grows via 加载更多)
    this._refreshGen = 0; this._repoGen = 0;
    // Turn rail state: `start` is the first message shown (a jump to a prompt
    // starts the transcript there), `top` the message at the top of the view.
    this.start = 0; this.top = 0; this.drawnTop = Infinity;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "搜索会话" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.shown = PAGE;
      cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx, { preferCache: true });
    // Disk + shared caches make this cheap; skip when the host entry is still fresh.
    cx.timer.every(BG_REFRESH_MS, (cx) => this.refresh(cx, { background: true }));
  }

  setFilter(key, value, cx) {
    if (this[key] === value) return;
    this[key] = value;
    this.shown = PAGE;
    this._visKey = null;
    if (key === "scope") this.refresh(cx, { preferCache: true });
    else cx.notify();
  }

  loadMore(cx) {
    this.shown += PAGE;
    cx.notify();
  }

  // Filter once per (sessions, scope, agent, query, roots, pins) — render calls this a lot.
  filtered() {
    const pins = pinMap();
    const key = [
      this.host, this.agent, this.scope, this.root || "", this.repo || "",
      this.query, this.sessions.length,
      this.sessions[0]?.id || "", this.sessions[this.sessions.length - 1]?.updated || 0,
      Object.keys(pins).sort().join(","),
    ].join("\0");
    if (this._visKey === key && this._visRef === this.sessions) return this._vis;
    this._visKey = key;
    this._visRef = this.sessions;
    this._vis = this.visible();
    return this._vis;
  }

  togglePin(session, cx) {
    const map = { ...pinMap() };
    const key = pinKey(session);
    if (map[key]) delete map[key];
    else map[key] = { at: Date.now() };
    setShared(PIN_STORE, map);
    this._visKey = null;
    cx.notify();
  }

  applyCache(host) {
    if (host === "global") {
      const merged = mergeGlobalSessions();
      if (!merged.length) return false;
      this.sessions = merged;
      this.host = "global";
      this.error = null;
      this.stale = knownHosts().some(({ host: h }) => !cacheFresh(h, { full: true }));
      return true;
    }
    const hit = indexStore().hosts?.[host];
    if (!hit?.sessions?.length) return false;
    this.sessions = hit.sessions.map((s) => ({ ...s, _host: host, _home: hit.home || null }));
    this.host = host;
    this.home = hit.home || this.home;
    this.error = null;
    this.stale = Date.now() - (hit.at || 0) > CACHE_TTL_MS || hit.full === false;
    return true;
  }

  saveCache(host, sessions, { full = true, home: homePath } = {}) {
    if (!sessions?.length) return;
    const next = indexStore();
    const prev = next.hosts?.[host];
    // Never let a narrow seed replace a fuller index.
    if (!full && prev?.full && prev.sessions?.length >= sessions.length) return;
    next.hosts = {
      ...(next.hosts || {}),
      [host]: { at: Date.now(), sessions, home: homePath ?? this.home, full },
    };
    setShared(STORE, next);
  }

  async ensureRemoteScript(machine) {
    if (!machine) return;
    const localPath = SCRIPT();
    const hashResult = await exec("sh", ["-lc", `shasum -a 256 ${shQuote(localPath)} | awk '{print $1}'`]).catch(() => null);
    const hash = String(hashResult?.stdout || "").trim();
    if (!hash) return;
    const synced = scriptStore();
    if (synced[machine] === hash) return;
    const remote = await exec(
      "sh",
      ["-lc", `f=${REMOTE_SCRIPT_EXPR}; test -f "$f" && shasum -a 256 "$f" | awk '{print $1}' || true`],
      { on: machine },
    ).catch(() => null);
    if (String(remote?.stdout || "").trim() === hash) {
      setShared(SCRIPT_SYNC, { ...synced, [machine]: hash });
      return;
    }
    const b64 = await exec("base64", ["-i", localPath]).catch(() => null);
    const payload = String(b64?.stdout || "").replace(/\s+/g, "");
    if (!payload) return;
    const write = await exec(
      "sh",
      ["-lc", `mkdir -p "$(dirname ${REMOTE_SCRIPT_EXPR})" && printf %s ${shQuote(payload)} | base64 -D > ${REMOTE_SCRIPT_EXPR}.tmp && mv ${REMOTE_SCRIPT_EXPR}.tmp ${REMOTE_SCRIPT_EXPR}`],
      { on: machine, timeout: 60000 },
    ).catch(() => null);
    if (write?.code === 0) setShared(SCRIPT_SYNC, { ...scriptStore(), [machine]: hash });
  }

  // Run history.py on a machine (null = this Mac).
  historyExecOn(machine, args) {
    const on = machine ? { on: machine, timeout: 120000 } : { timeout: 120000 };
    if (!machine) return exec("python3", [SCRIPT(), ...args], on);
    const argv = args.map(shQuote).join(" ");
    return exec("sh", ["-lc", `python3 ${REMOTE_SCRIPT_EXPR} ${argv}`], on);
  }

  historyExec(args) {
    return this.historyExecOn(location().machine, args);
  }

  async resolveRepo(cwd, machine) {
    if (!cwd) return null;
    const opts = machine ? { on: machine, cwd, timeout: 15000 } : { cwd, timeout: 15000 };
    const r = await exec("git", ["rev-parse", "--show-toplevel"], opts).catch(() => null);
    if (r?.code === 0) {
      const root = String(r.stdout || "").trim();
      if (root) return root;
    }
    return cwd;
  }

  refresh(cx, opts = {}) {
    if (this.scope === "global") return this.refreshGlobal(cx, opts);

    const { preferCache = false, background = false, narrow = false } = opts;
    const { machine, cwd } = location();
    const host = hostKey(machine);

    // Quiet polls: skip only when we already hold a fresh *full* index.
    if (background && cacheFresh(host, { full: true }) && this.host === host && this.sessions.length) return;

    const gen = ++this._refreshGen;

    if (preferCache && this.applyCache(host)) {
      this._visKey = null;
      cx.notify();
      // Always revalidate in the background after a cache hit.
      background || this.refresh(cx, { background: true });
      return;
    }

    if (this.loading && !background) return;
    if (!background) {
      this.loading = true;
      this.loadingLabel = machine ? `正在从 ${machine} 加载…` : "正在加载会话…";
      if (this.host && this.host !== host) {
        // Don't flash the previous machine's sessions as if they belong here.
        if (!this.applyCache(host)) this.sessions = [];
        this.stale = true;
      }
      cx.notify();
    }

    cx.spawn(async (cx) => {
      try {
        if (machine) await this.ensureRemoteScript(machine);
        if (gen !== this._refreshGen && background) return;

        let homePath = home();
        if (machine) {
          const h = await exec("sh", ["-lc", 'printf %s "$HOME"'], { on: machine }).catch(() => null);
          if (h?.code === 0 && h.stdout.trim()) homePath = h.stdout.trim();
        }
        this.home = homePath;

        // Narrow first paint when we have nothing for this host yet.
        const have = indexStore().hosts?.[host]?.sessions?.length;
        const useCwd = Boolean(narrow || (!have && cwd && this.scope !== "all" && this.scope !== "global"));
        const args = useCwd && cwd ? ["list", "--cwd", cwd] : ["list"];
        const r = await this.historyExecOn(machine, args);
        if (gen !== this._refreshGen) return;
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || `exit ${r.code}`);
        const sessions = JSON.parse(r.stdout);
        this.sessions = sessions.map((s) => ({ ...s, _host: host, _home: homePath }));
        this._visKey = null;
        this.error = null;
        this.host = host;
        this.stale = false;
        // Only mark full indexes as complete; a --cwd seed must still revalidate.
        if (!useCwd) this.saveCache(host, sessions, { full: true, home: homePath });
        else if (!have) {
          this.saveCache(host, sessions, { full: false, home: homePath });
          this.refresh(cx, { background: true });
        }
      } catch (e) {
        if (gen !== this._refreshGen) return;
        if (!this.sessions.length) this.error = `无法读取历史：${e}`;
      } finally {
        if (gen === this._refreshGen) {
          this.loading = false;
          this.loadingLabel = null;
          cx.notify();
        }
      }
    });
  }

  // Aggregate indexes from every machine that has a space in the header.
  refreshGlobal(cx, opts = {}) {
    const { preferCache = false, background = false } = opts;
    const hosts = knownHosts();
    const allFresh = hosts.every(({ host }) => cacheFresh(host, { full: true }));

    if (background && allFresh && this.host === "global" && this.sessions.length) return;

    const gen = ++this._refreshGen;

    if (preferCache && this.applyCache("global")) {
      this._visKey = null;
      cx.notify();
      background || this.refreshGlobal(cx, { background: true });
      return;
    }

    if (this.loading && !background) return;
    if (!background) {
      this.loading = true;
      this.loadingLabel = `正在汇总 ${hosts.length} 台机器…`;
      const merged = mergeGlobalSessions();
      if (merged.length) {
        this.sessions = merged;
        this.host = "global";
      }
      cx.notify();
    }

    cx.spawn(async (cx) => {
      await Promise.all(hosts.map(async ({ host, machine }) => {
        try {
          if (machine) await this.ensureRemoteScript(machine);
          let homePath = home();
          if (machine) {
            const h = await exec("sh", ["-lc", 'printf %s "$HOME"'], { on: machine }).catch(() => null);
            if (h?.code === 0 && h.stdout.trim()) homePath = h.stdout.trim();
          } else {
            homePath = home();
          }
          const r = await this.historyExecOn(machine, ["list"]);
          if (r.code !== 0) return;
          const sessions = JSON.parse(r.stdout);
          this.saveCache(host, sessions, { full: true, home: homePath });
        } catch {
          // One unreachable machine must not blank the whole global view.
        }
      }));
      if (gen !== this._refreshGen) return;
      this.sessions = mergeGlobalSessions();
      this.host = "global";
      this._visKey = null;
      this.error = this.sessions.length ? null : "没有会话";
      this.stale = false;
      this.loading = false;
      this.loadingLabel = null;
      cx.notify();
    });
  }

  // "本目录" = the pane's current cwd inside this space (updates as you cd).
  // "本仓库" = git toplevel of that cwd. Re-index when the active machine changes.
  syncRoot(cx) {
    const { cwd, machine } = location();
    const host = hostKey(machine);
    const cwdChanged = cwd !== this.cwd;
    const hostChanged = this.host != null && host !== this.host;
    this.cwd = cwd;
    this.root = cwd;

    const repoKey = `${host}\0${cwd || ""}`;
    if (cwdChanged || this.repo == null || this._repoKey !== repoKey) {
      const gen = ++this._repoGen;
      const at = cwd;
      this._repoKey = repoKey;
      cx.spawn(async (cx) => {
        const repo = await this.resolveRepo(at, machine);
        if (gen !== this._repoGen) return;
        this.repo = repo;
        this._visKey = null;
        cx.notify();
      });
    }

    // Global view is not tied to the active space's machine.
    if (hostChanged && this.scope !== "global") {
      this.shown = PAGE;
      this.refresh(cx, { preferCache: true });
    }
  }

  show(session, cx) {
    this.open = session; this.transcript = null; this.loadError = null; this.start = 0; this.top = 0;
    const ref = session.file;
    const machine = sessionMachine(session);
    cx.spawn(async (cx) => {
      try {
        const r = await this.historyExecOn(machine, ["show", session.agent, ref]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || `exit ${r.code}`);
        if (this.open === session) this.transcript = JSON.parse(r.stdout);
      } catch (e) { if (this.open === session) this.loadError = String(e); }
      cx.notify();
    });
    cx.notify();
  }

  resume(session) {
    const argv = AGENTS[session.agent]?.resume?.(session);
    if (!argv) return;
    const host = sessionHost(session);
    const machine = sessionMachine(session);
    const space =
      spaces().find((s) => s.active && hostKey(s.machine) === host) ||
      spaces().find((s) => hostKey(s.machine) === host) ||
      location().space;
    if (machine) {
      notify({ title: "历史", body: `在 ${machine} 上恢复会话`, level: "info", timeout: 3000 });
    }
    run("tab.new", {
      argv,
      ...(space?.id ? { space: space.id } : {}),
      ...(session.cwd ? { folder: session.cwd } : {}),
    });
  }

  // Resume straight from the list: a quiet play icon that becomes a button on row hover.
  quickResume(s, hot, t) {
    return h_flex().id(`resume-${sessionHost(s)}-${s.agent}-${s.id}`).h(24).flex_none().gap(4).items_center().justify_center().rounded(6).cursor_pointer()
      .when(hot, (el) => el.px(9).bg(t.solid).text_color(t.solid_foreground).text_size(11.5))
      .when(!hot, (el) => el.w(24).text_color(t.dim))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.resume(s); })
      .child(svg("mods/history/resume.svg").size(hot ? 10 : 11))
      .when(hot, (el) => el.child("继续"));
  }

  matchesQuery(s, q) {
    if (!q) return true;
    const label = hostLabel(sessionHost(s)).toLowerCase();
    return (
      s.title.toLowerCase().includes(q) ||
      (s.cwd ?? "").toLowerCase().includes(q) ||
      label.includes(q) ||
      sessionHost(s).toLowerCase().includes(q) ||
      (!s.cwd && "未归属".includes(q))
    );
  }

  visible() {
    const q = this.query.trim().toLowerCase();
    const pins = pinMap();
    const matched = this.sessions.filter((s) => {
      if (this.agent !== "all" && s.agent !== this.agent) return false;
      if (!inScope(s, this.scope, this.root, this.repo)) return false;
      if (this.scope === "global" && !inGlobalWindow(s) && !pins[pinKey(s)]) return false;
      return this.matchesQuery(s, q);
    });
    // Pinned sessions stay findable: show them even outside 本目录 / 近3天.
    const seen = new Set(matched.map((s) => pinKey(s)));
    for (const s of this.sessions) {
      if (!pins[pinKey(s)] || seen.has(pinKey(s))) continue;
      if (this.agent !== "all" && s.agent !== this.agent) continue;
      if (!this.matchesQuery(s, q)) continue;
      matched.push(s);
      seen.add(pinKey(s));
    }
    matched.sort((a, b) => {
      const pa = pins[pinKey(a)], pb = pins[pinKey(b)];
      if (Boolean(pa) !== Boolean(pb)) return pa ? -1 : 1;
      if (pa && pb) return (pb.at || 0) - (pa.at || 0);
      return (b.updated || 0) - (a.updated || 0);
    });
    return matched;
  }

  sessionRow(s, t) {
    const key = `${sessionHost(s)}-${s.agent}-${s.id}`;
    const hot = this.hot === key;
    const pinned = isPinned(s);
    const homePath = s._home || this.home;
    const showWhere = this.scope === "global" || this.scope === "all" || !s.cwd || pinned;
    return h_flex().id(`session-${key}`).flex_none().px(8).py(7).gap(8).items_center().rounded(8).cursor_pointer()
      .hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.show(s, cx))
      .on_hover((hovered, cx) => {
        if (hovered) this.hot = key; else if (this.hot === key) this.hot = null;
        cx.notify();
      })
      .child(div().id(`pin-${key}`).size(22).flex_none().flex().items_center().justify_center().rounded(5)
        .cursor_pointer().text_size(12).text_color(pinned ? t.accent : t.dim)
        .hover((st) => st.bg(t.hover).text_color(t.foreground))
        .tooltip(pinned ? "取消置顶" : "置顶（重启仍在）")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.togglePin(s, cx); })
        .child(pinned ? "★" : "☆"))
      .child(this.icon(s.agent, 16, t))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(12.5).truncate().child(s.title || "(untitled)"))
        .child(h_flex().gap(6).text_size(11).text_color(t.dim)
          .child(div().flex_none().child(ago(s.updated)))
          .child(div().flex_none().child(`· ${s.turns} 次提问`))
          .when(this.scope === "global" || pinned, (el) => el.child(div().flex_none().child(`· ${hostLabel(sessionHost(s))}`)))
          .when(showWhere, (el) => el.child(div().min_w(0).truncate().child(`· ${s.cwd ? short(s.cwd, homePath) : "未归属"}`)))))
      .when(Boolean(AGENTS[s.agent]?.resume), (el) => el.child(this.quickResume(s, hot, t)));
  }

  moreRow(shown, total, t) {
    return h_flex().id("history-more").flex_none().mt(4).mx(2).h(32).px(12).gap(8).items_center().justify_center()
      .rounded(8).border_1().border_color(t.border).cursor_pointer().text_size(12).text_color(t.muted)
      .hover((st) => st.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => this.loadMore(cx))
      .child(`加载更多 · 已显示 ${shown}/${total}`);
  }

  icon(agent, size, t) {
    const a = AGENTS[agent];
    if (!a) return div().size(size);
    return a.tint ? svg(a.icon).size(size).flex_none().text_color(t.foreground) : image(a.icon).size(size).flex_none();
  }

  chip(id, label, on, t, action, icon) {
    return h_flex().id(id).h(24).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer().text_size(11.5)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).border_1().border_color(on ? t.border : t.background)
      .hover((s) => s.bg(t.hover)).on_click(action)
      .when(Boolean(icon), (el) => el.child(icon)).child(label);
  }

  header(t, children) {
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border).children(children);
  }

  renderList(t) {
    const all = this.filtered();
    const limit = Math.min(this.shown || PAGE, all.length);
    const rows = all.slice(0, limit);
    const more = all.length - rows.length;
    const counts = {};
    const latest = {}; // agent -> newest session updated (for chip order)
    let orphanCount = 0;
    for (const s of this.sessions) {
      if (this.scope === "global" && !inGlobalWindow(s) && !isPinned(s)) continue;
      if (!s.cwd) orphanCount += 1;
      if (inScope(s, this.scope, this.root, this.repo) || isPinned(s)) {
        counts[s.agent] = (counts[s.agent] ?? 0) + 1;
        latest[s.agent] = Math.max(latest[s.agent] || 0, s.updated || 0);
      }
    }
    if (this.scope !== "all" && this.scope !== "global") orphanCount = 0;
    // Chips: whichever agent has the newest session floats first (Codex today, Devin tomorrow…).
    const present = Object.keys(AGENTS).filter((a) => counts[a])
      .sort((a, b) => (latest[b] || 0) - (latest[a] || 0));
    const empty = this.error
      || (this.loading && !this.sessions.length ? (this.loadingLabel || "正在加载会话…")
        : this.scope !== "all" && this.scope !== "global" && !this.root ? "无当前目录"
          : this.query ? "没有匹配的会话"
            : this.scope === "here" ? "此目录没有会话"
              : this.scope === "repo" ? "此仓库没有会话"
                : this.scope === "global" ? `近 ${GLOBAL_DAYS} 天没有会话`
                  : "没有会话");
    const pathHint = this.scope === "repo" ? (this.repo || this.root) : this.root;
    return v_flex().size_full().min_h(0)
      .child(this.header(t, [
        div().font_semibold().child("历史"),
        div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${all.length}`),
        div().flex_1(),
        this.chip("scope-here", "本目录", this.scope === "here", t, (_e, cx) => this.setFilter("scope", "here", cx)),
        this.chip("scope-repo", "本仓库", this.scope === "repo", t, (_e, cx) => this.setFilter("scope", "repo", cx)),
        this.chip("scope-all", "全部", this.scope === "all", t, (_e, cx) => this.setFilter("scope", "all", cx)),
        this.chip("scope-global", "全局", this.scope === "global", t, (_e, cx) => this.setFilter("scope", "global", cx)),
        div().id("history-refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx))
          .child(svg("mods/history/history.svg").size(14).when(this.loading, (el) => el.spin(900))),
      ]))
      .when(this.scope === "global", (el) => el.child(div().flex_none().px(14).py(6).border_b(1).border_color(t.border)
        .text_size(11).text_color(t.dim).truncate()
        .child(`近 ${GLOBAL_DAYS} 天 · ${knownHosts().map((h) => hostLabel(h.host)).join("、")}`)))
      .when(this.scope !== "all" && this.scope !== "global" && Boolean(pathHint), (el) => el.child(div().flex_none().px(14).py(6).border_b(1).border_color(t.border)
        .text_size(11).text_color(t.dim).truncate().child(short(pathHint, this.home))))
      .when(Boolean(this.loadingLabel && this.sessions.length), (el) => el.child(
        div().flex_none().px(14).py(5).border_b(1).border_color(t.border).text_size(11).text_color(t.muted).child(this.loadingLabel)))
      .child(v_flex().flex_none().px(10).pt(10).pb(8).gap(8).border_b(1).border_color(t.border)
        .child(div().id("history-search").h(30).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(h_flex().id("history-agents").gap(4).overflow_x_scrollbar()
          .child(this.chip("agent-all", "全部", this.agent === "all", t, (_e, cx) => this.setFilter("agent", "all", cx)))
          .children(present.map((a) => this.chip(`agent-${a}`, `${AGENTS[a].name} ${counts[a]}`, this.agent === a, t,
            (_e, cx) => this.setFilter("agent", this.agent === a ? "all" : a, cx), this.icon(a, 13, t))))
          .when(orphanCount > 0, (el) => el.child(div().text_size(11).text_color(t.dim).px(4).child(`未归属 ${orphanCount}`)))))
      .child(v_flex().id("history-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .when(!rows.length, (row) => row.child(div().p(8).text_color(t.dim).child(empty)))
        .children(rows.map((s) => this.sessionRow(s, t)))
        .when(more > 0, (row) => row.child(this.moreRow(rows.length, all.length, t))));
  }

  message(m, i, t) {
    const agent = AGENTS[this.open.agent]?.name ?? "智能体";
    if (m.role === "tool") {
      const lines = m.text.split("\n"), shown = lines.slice(0, TOOL_LINES);
      return v_flex().flex_none().mx(12).px(10).py(5).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5).text_color(t.dim)
        .children(shown.map((line) => div().truncate().child(`▸ ${line}`)))
        .when(lines.length > TOOL_LINES, (el) => el.child(div().child(`… 还有 ${lines.length - TOOL_LINES} 条工具调用`)));
    }
    const user = m.role === "user";
    return v_flex().flex_none().mx(12).gap(4).when(user, (el) => el.px(10).py(8).rounded(8).bg(t.raised))
      .child(h_flex().gap(6).text_size(10.5).text_color(t.dim)
        .child(div().font_semibold().text_color(user ? t.accent : t.muted).child(user ? "你" : agent))
        .child(div().child(clock(m.time))))
      .child(div().text_size(12.5).text_color(t.foreground).child(TextView.markdown(`msg-${i}`, m.text).selectable()));
  }

  renderSession(t) {
    const s = this.open, a = AGENTS[s.agent], can = Boolean(a?.resume);
    const pinned = isPinned(s);
    const tr = this.transcript;
    const homePath = s._home || this.home;
    return v_flex().size_full().min_h(0)
      .child(this.header(t, [
        div().id("history-back").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_size(16).text_color(t.muted)
          .hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.open = null; this.transcript = null; cx.notify(); }).child("‹"),
        this.icon(s.agent, 16, t),
        div().flex_1().min_w(0).font_semibold().truncate().child(s.title || "(untitled)"),
        div().flex_none().px(6).py(2).rounded(5).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(`地图 ${s.turns || 0}`),
        div().id("history-pin").size(28).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer()
          .text_size(14).text_color(pinned ? t.accent : t.dim)
          .hover((st) => st.bg(t.hover).text_color(t.foreground))
          .tooltip(pinned ? "取消置顶" : "置顶（重启仍在）")
          .on_click((_e, cx) => this.togglePin(s, cx))
          .child(pinned ? "★" : "☆"),
      ]))
      .child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().child([hostLabel(sessionHost(s)), short(s.cwd, homePath) || "未知文件夹"].filter(Boolean).join(" · ")))
          .child(div().truncate().child(`${a?.name ?? s.agent} · ${clock(s.created)} → ${ago(s.updated)}`)))
        .child(div().id("history-resume").h(28).px(12).flex_none().flex().items_center().rounded(7).text_size(12)
          .bg(can ? t.solid : t.raised).text_color(can ? t.solid_foreground : t.dim).when(can, (el) => el.cursor_pointer())
          .on_click(() => this.resume(s)).child(can ? "继续" : "仅查看")))
      .when(!tr, (el) => el.child(div().px(14).py(12).text_color(this.loadError ? t.ansi1 : t.dim).child(this.loadError ?? "Loading transcript…")))
      .when(Boolean(tr && tr.total > tr.messages.length), (el) => el.child(div().flex_none().px(14).pt(8).text_size(11).text_color(t.dim)
        .child(`显示最近 ${tr.messages.length}/${tr.total} 条`)))
      .when(Boolean(tr && !tr.messages.length), (el) => el.child(div().px(14).py(12).text_color(t.dim).child("没有消息")))
      .when(Boolean(tr?.messages.length), (el) => el.child(this.renderTranscript(tr.messages, t)));
  }

  // Conversation map: right-edge tick rail, one short bar per user turn.
  // Hover for the prompt; click jumps the transcript to that turn. The lazy
  // list can't scroll from code, so a jump starts the list there (fresh list
  // id) and a bar above brings earlier messages back.
  renderTranscript(messages, t) {
    const turns = [];
    messages.forEach((m, i) => { if (m.role === "user") turns.push(i); });
    const start = Math.min(this.start, messages.length - 1), shown = messages.length - start;
    // Rows are drawn during layout, after render; the first one drawn last
    // time is the message at the top of the view.
    if (this.drawnTop !== Infinity) this.top = this.drawnTop;
    this.drawnTop = Infinity;
    let current = 0;
    turns.forEach((i, k) => { if (i <= this.top) current = k; });
    const id = `history-transcript-${start}`;
    return h_flex().flex_1().min_h(0)
      .child(v_flex().flex_1().min_w(0).h_full()
        .when(start > 0, (el) => el.child(h_flex().id("history-earlier").flex_none().mx(12).mt(8).h(26).px(10).gap(6).items_center().justify_center()
          .rounded(6).border_1().border_color(t.border).cursor_pointer().text_size(11).text_color(t.muted)
          .hover((st) => st.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.start = 0; this.top = 0; cx.notify(); })
          .child(`↑ 显示更早的 ${start} 条`)))
        .child(div().id(`${id}-box`).relative().flex_1().min_h(0)
          .on_scroll_wheel((_e, cx) => { cx.notify(); cx.timer.after(50, (cx) => cx.notify()); })
          .child(list(id, shown, (i) => `m${start + i}`, (i) => {
            const at = start + i;
            if (at < this.drawnTop) this.drawnTop = at;
            return div().w_full().pt(i === 0 ? 12 : 0).pb(i === shown - 1 ? 12 : 10).child(this.message(messages[at], at, t));
          }).size_full())
          .child(Scrollbar.vertical(id).absolute().inset_0())))
      .when(turns.length > 0, (el) => el.child(this.conversationMap(turns, messages, current, t)));
  }

  // Conversation map — CodeBridge-style: vertical rail of short horizontal ticks.
  conversationMap(turns, messages, current, t) {
    return v_flex().id("history-conversation-map").w(24).flex_none().h_full().py(10).items_center().justify_center()
      .border_l(1).border_color(t.border).bg(t.chrome)
      .tooltip("会话地图")
      .children(turns.map((i, k) => {
        const on = k === current;
        const text = (messages[i].text || "").replace(/\s+/g, " ").trim();
        const title = text.length > 28 ? `${text.slice(0, 28)}…` : (text || `第 ${k + 1} 轮`);
        const tip = `Turn ${k + 1}/${turns.length} · ${title}${text.length > 28 ? `\n${text.slice(0, 120)}${text.length > 120 ? "…" : ""}` : ""}`;
        return div().id(`turn-${k}`).w_full().flex_1().min_h(6).max_h(16).flex().items_center().justify_center().cursor_pointer()
          .on_click((_e, cx) => { this.start = k === 0 ? 0 : i; this.top = i; cx.notify(); })
          .tooltip(tip)
          .child(div().flex_none().rounded(99).h(on ? 3 : 2)
            .w(on ? 18 : 11).bg(on ? t.accent : t.muted)
            .hover((s) => s.w(18).bg(t.accent)));
      }));
  }

  render(cx) {
    this.syncRoot(cx);
    const t = theme();
    return v_flex().id("history").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.typing) { this.typing = false; this.handle.focus(); }
        else if (this.open) { this.open = null; this.transcript = null; }
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(this.open ? this.renderSession(t) : this.renderList(t));
  }
}
