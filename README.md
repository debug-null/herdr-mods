# herdr-mods

Personal [Herdr Desktop](https://herdr.ai) mod suite: history, open-in-editor, spaces icons, SCM layout, alerts, and related UI clones — packaged to drop into `~/.config/herdr-app`.

Previously published alone: [`herdr-open-in-editor`](https://github.com/debug-null/herdr-open-in-editor) (now included under `mods/open-in-editor`).

## What's inside

| Path | Notes |
|------|--------|
| `mods/history` | Agent session history (Claude/Codex/Cursor/Devin/…), multi-machine |
| `mods/open-in-editor` | Open current space in Cursor / VS Code / Zed / … |
| `mods/spaces` | Sidebar spaces with project favicon/logo + letter fallback |
| `mods/tabs-history` | Tabs bar with History / Editor entry points |
| `mods/better-alerts` | macOS-friendly agent alerts |
| `mods/changes-scm` | SCM-oriented changes pane |
| `mods/files-md` | Files + markdown helpers |
| `mods/status-usage` | Status / usage strip |
| `mods/md-preview` / `mods/web` | Preview helpers |
| `mods/herdr-web-browser*` | In-app browser set |
| `mods/*-edited` | Personal clones (`agents` / `spaces` / `pane`) |
| `layouts/scm.json` | SCM-focused layout |
| `layouts/main-usage.json` | Main layout with usage strip |
| `keys.json` | Keybindings to merge |
| `programs.json` / `settings.json` | Companion config |

## Install

```bash
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
git clone https://github.com/debug-null/herdr-mods.git /tmp/herdr-mods

# Mods
rsync -a /tmp/herdr-mods/mods/ "$APP/mods/"

# Layouts (optional)
rsync -a /tmp/herdr-mods/layouts/ "$APP/layouts/"

# Merge keys carefully if you already customized bindings
cp "$APP/keys.json" "$APP/keys.json.bak-$(date +%Y%m%d)" 2>/dev/null || true
cp /tmp/herdr-mods/keys.json "$APP/keys.json"
cp /tmp/herdr-mods/settings.json "$APP/settings.json"
# programs.json points at the local herdr-web-browser binary — edit the
# REPLACE_WITH_… path (or merge only the keys you need) before copying.
# cp /tmp/herdr-mods/programs.json "$APP/programs.json"
```

Then reload or restart Herdr Desktop and pick `scm` / `main-usage` from layouts if you want those trees.

## Notes

- Do **not** copy `shared.json`, `view.json`, `window.json`, `cache/`, or `data/` between machines — those are session/machine local.
- `mods/spaces` replaces Herdr's shipped spaces mod (favicon probe + letter avatar). Keep a backup if you want the stock one back.
- Generated `gpui-kit.d.ts` / `jsconfig.json` are omitted; Herdr recreates them on check/load.

## License

Mods you wrote: MIT (see below). Vendored / third-party pieces (e.g. win98 assets if added later, browser mod origins) keep their upstream terms.
