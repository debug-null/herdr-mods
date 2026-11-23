#!/usr/bin/env bash
# install.sh — 一键安装 / 同步全套 Herdr Desktop Mods、主题、CLI 与 Agent Skills
# 安全幂等：自动备份已有 keys.json / scm.json，且绝不覆盖已有的 jobs.json / tasks.json / prompts.json。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
TS="$(date +%Y%m%d-%H%M%S)"
WITH_SETTINGS=0

for arg in "$@"; do
  case "$arg" in
    --with-settings) WITH_SETTINGS=1 ;;
  esac
done

echo "==> 目标目录: $APP"
mkdir -p "$APP/mods" "$APP/layouts" "$APP/themes" "$APP/sched" "$APP/board" "$APP/reflections/digests" "$HOME/.local/bin"

# 1. Backup existing scm.json & keys.json if present
[ -f "$APP/layouts/scm.json" ] && cp "$APP/layouts/scm.json" "$APP/layouts/scm.json.bak-$TS"
[ -f "$APP/keys.json" ] && cp "$APP/keys.json" "$APP/keys.json.bak-$TS"

# 2. Sync mods, layouts, themes
echo "==> 同步 mods / layouts / themes..."
rsync -a --exclude='gpui-kit.d.ts' --exclude='jsconfig.json' --exclude='__pycache__' --exclude='*.pyc' --exclude='.DS_Store' \
  "$SRC/mods/" "$APP/mods/"
cp "$SRC/layouts/scm.json" "$APP/layouts/scm.json"
[ -f "$SRC/layouts/main-usage.json" ] && cp "$SRC/layouts/main-usage.json" "$APP/layouts/main-usage.json"
rsync -a "$SRC/themes/" "$APP/themes/"
cp "$SRC/keys.json" "$APP/keys.json"

if [ "$WITH_SETTINGS" = "1" ] || [ ! -f "$APP/settings.json" ]; then
  cp "$SRC/settings.json" "$APP/settings.json"
fi

# 3. Prompts default seed (preserve user edits if already present)
if [ ! -f "$APP/prompts.json" ] && [ -f "$SRC/prompts.json" ]; then
  cp "$SRC/prompts.json" "$APP/prompts.json"
fi

# 4. Backend CLIs & engines (preserve jobs.json / tasks.json / reflections/*.md)
echo "==> 同步 sched / board / reflections 引擎与 CLI..."
cp "$SRC/sched/engine.py" "$SRC/sched/sched" "$SRC/sched/AGENTS.md" "$APP/sched/"
chmod +x "$APP/sched/engine.py" "$APP/sched/sched"
[ -f "$APP/sched/jobs.json" ] || printf '{\n  "jobs": []\n}\n' > "$APP/sched/jobs.json"

cp "$SRC/board/board" "$SRC/board/AGENTS.md" "$APP/board/"
chmod +x "$APP/board/board"
[ -f "$APP/board/tasks.json" ] || printf '{\n  "version": 1,\n  "tasks": []\n}\n' > "$APP/board/tasks.json"

cp "$SRC/reflections/reflect.py" "$SRC/reflections/prompt.md" "$APP/reflections/"
chmod +x "$APP/reflections/reflect.py"

# 5. Symlink CLIs into ~/.local/bin
ln -sfn "$APP/sched/sched" "$HOME/.local/bin/herdr-sched"
ln -sfn "$APP/board/board" "$HOME/.local/bin/herdr-board"
ln -sfn "$APP/reflections/reflect.py" "$HOME/.local/bin/herdr-reflect"

# 6. Install & symlink Agent Skills across Claude / Cursor / Codex
echo "==> 同步 Agent Skills (herdr-sched / herdr-board)..."
mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.cursor/skills" "$HOME/.codex/skills"
for sk in herdr-sched herdr-board; do
  if [ -d "$SRC/skills/$sk" ]; then
    mkdir -p "$HOME/.agents/skills/$sk"
    cp "$SRC/skills/$sk/SKILL.md" "$HOME/.agents/skills/$sk/SKILL.md"
    ln -sfn "../../.agents/skills/$sk" "$HOME/.claude/skills/$sk"
    ln -sfn "../../.agents/skills/$sk" "$HOME/.cursor/skills/$sk"
    ln -sfn "../../.agents/skills/$sk" "$HOME/.codex/skills/$sk"
  fi
done

echo "==> 完成！请确认 Herdr 已切换到 scm 布局（⌘⇧L）。"
