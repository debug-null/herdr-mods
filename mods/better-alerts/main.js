// Better Alerts (macOS): system notification when an agent needs you, or finishes
// while you aren't looking. Click opens that agent and brings Herdr forward.
// Uses terminal-notifier (brew install terminal-notifier). Draws nothing; run it
// as an empty floating block. Never runs a program from render.
import { View, div } from "gpui-kit";
import { agents, checking, exec, focused, home, terminals, window } from "herdr";
import { loadSettings } from "./settings.js";

const DEFAULT_SETTINGS = { alerts: { blocked: true, done: true } };
const WORDS = { blocked: "needs you", done: "finished" };
const BUSY = new Set(["working", "blocked"]);
const CHECK_MS = 500;
const BUNDLE_ID = "dev.herdr.app";

const NOTIFIER_CANDIDATES = [
  "/opt/homebrew/bin/terminal-notifier",
  "/usr/local/bin/terminal-notifier",
  "terminal-notifier",
];

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function looking(agent) {
  if (!window()?.active) return false;
  return focused()?.tab === agent.tab;
}

function agentName(agent) {
  return agent.program?.name || agent.app || agent.title || agent.address;
}

class BetterAlerts extends View {
  init(_props, cx) {
    this.settings = DEFAULT_SETTINGS;
    this.seen = new Map(agents().map((a) => [a.address, a.status]));
    this.warned = false;
    this.notifier = null;
    this.herdrApp = `${home()}/.local/bin/herdr-app`;

    if (window()?.platform !== "macos") return;
    if (checking()) return;

    cx.spawn(async (cx) => {
      const { settings, problems } = await loadSettings("better-alerts", DEFAULT_SETTINGS);
      this.settings = settings;
      for (const problem of problems) console.warn(`better-alerts mod.json settings: ${problem}`);

      this.notifier = await this.resolveNotifier();
      if (!this.notifier) {
        console.warn(
          "better-alerts: terminal-notifier not found. Install with: brew install terminal-notifier",
        );
        cx.notify();
        return;
      }

      const which = await exec("sh", ["-c", "command -v herdr-app || true"]).catch(() => null);
      const found = which?.stdout?.trim();
      if (found) this.herdrApp = found;

      cx.notify();
    });

    cx.timer.every(CHECK_MS, () => this.check());
  }

  async resolveNotifier() {
    for (const candidate of NOTIFIER_CANDIDATES) {
      if (candidate.includes("/")) {
        const probe = await exec("sh", ["-c", `test -x ${shQuote(candidate)} && echo ok`]).catch(
          () => null,
        );
        if (probe?.stdout?.trim() === "ok") return candidate;
        continue;
      }
      const which = await exec("sh", ["-c", "command -v terminal-notifier || true"]).catch(
        () => null,
      );
      const found = which?.stdout?.trim();
      if (found) return found;
    }
    return null;
  }

  check() {
    if (!this.notifier) return;
    const live = new Set();
    const subAgents = new Set(terminals().filter((t) => t?.parent).map((t) => t.address));
    for (const a of agents()) {
      live.add(a.address);
      const before = this.seen.get(a.address);
      this.seen.set(a.address, a.status);
      if (before === a.status || subAgents.has(a.address)) continue;
      if (!this.settings.alerts[a.status]) continue;
      if (a.status === "done" && (!BUSY.has(before) || looking(a))) continue;
      this.post(a);
    }
    for (const address of this.seen.keys()) if (!live.has(address)) this.seen.delete(address);
  }

  post(agent) {
    const title = `${agentName(agent)} ${WORDS[agent.status]}`;
    const body = `${agent.space_name} / ${agent.tab_name}`;
    const execute = `${this.herdrApp} do agent.focus --terminal ${shQuote(agent.address)}`;
    exec(this.notifier, [
      "-title",
      title,
      "-message",
      body,
      "-group",
      `herdr-better-alerts:${agent.address}`,
      "-activate",
      BUNDLE_ID,
      "-execute",
      execute,
    ]).catch((error) => {
      if (this.warned) return;
      this.warned = true;
      console.warn(`better-alerts: couldn't post a notification: ${error}`);
    });
  }

  render() {
    return div();
  }
}

export default BetterAlerts;
