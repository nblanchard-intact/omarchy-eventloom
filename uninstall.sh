#!/bin/sh
# omarchy-eventloom uninstaller — removes installed files, strips its hook
# entries from Claude settings, leaves every other hook (herdr, etc.) intact.
set -eu

LIB_DIR="$HOME/.local/lib/eventloom"
BIN_DIR="$HOME/.local/bin"
LOG_DIR="$HOME/.local/state/omarchy/agents/logs"

say() { printf '  %s\n' "$*"; }

# --- claude hooks: remove only eventloom entries -----------------------------
if [ -f "$HOME/.claude/settings.json" ] && command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const p = process.env.HOME + "/.claude/settings.json";
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const ev of Object.keys(s.hooks ?? {})) {
      s.hooks[ev] = (s.hooks[ev] ?? []).filter((e) =>
        !(e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes("eventloom-hook.sh")));
      if (!s.hooks[ev].length) delete s.hooks[ev];
    }
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
  '
  say "claude hooks stripped"
fi
rm -f "$HOME/.claude/hooks/eventloom-hook.sh"

# --- files --------------------------------------------------------------------
rm -f "$HOME/.omp/agent/extensions/eventloom.ts"
rm -rf "$LIB_DIR" "$HOME/.local/lib/tapestry"
rm -f "$BIN_DIR/eventloom" "$BIN_DIR/omarchy-eventloom" "$BIN_DIR/omarchy-eventloom-inspect"
say "cli, lib, omp adapter removed"

# --- logs: kept unless --purge -------------------------------------------------
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$LOG_DIR"
  say "logs purged"
else
  say "logs kept at $LOG_DIR (run with --purge to delete)"
fi
say "uninstall complete."
