#!/bin/sh
# omarchy-eventloom installer — zero-touch, idempotent.
# Copies sources out of this repo, wires adapters, verifies the result.
set -eu

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$HOME/.local/lib/agentlog"
BIN_DIR="$HOME/.local/bin"
LOG_DIR="$HOME/.local/state/omarchy/agents/logs"

say() { printf '  %s\n' "$*"; }

# --- 1. runtime: bun preferred (no npm step), node >= 20 fallback ------------
RUNTIME=""
if command -v bun >/dev/null 2>&1; then
  RUNTIME="bun"
elif command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] || { echo "node >= 20 required (found $NODE_MAJOR). Install bun: https://bun.sh" >&2; exit 1; }
  RUNTIME="node"
else
  echo "Neither bun nor node found. Install bun: https://bun.sh (or: sudo pacman -S bun)" >&2
  exit 1
fi
say "runtime: $RUNTIME"

# --- 2. files ----------------------------------------------------------------
mkdir -p "$LIB_DIR" "$BIN_DIR" "$LOG_DIR"
cp "$REPO_DIR/lib/engine.mjs" "$REPO_DIR/lib/agentlog.mjs" "$REPO_DIR/lib/adapters.json" "$LIB_DIR/"
cp "$REPO_DIR/bin/agentlog" "$REPO_DIR/bin/omarchy-agent-log" "$REPO_DIR/bin/omarchy-agent-inspect" "$BIN_DIR/"
chmod +x "$BIN_DIR/agentlog" "$BIN_DIR/omarchy-agent-log" "$BIN_DIR/omarchy-agent-inspect"
say "installed cli -> $BIN_DIR/agentlog"

# --- 3. node fallback needs the pinned runtime; bun does not -----------------
if [ "$RUNTIME" = "node" ] && [ ! -d "$LIB_DIR/node_modules/@eventloom/runtime" ]; then
  say "node selected: installing @eventloom/runtime (one-time)"
  (cd "$LIB_DIR" && npm install --no-fund --no-audit --silent @eventloom/runtime@1)
fi

# --- 4. omp adapter: only when omp is present --------------------------------
if [ -d "$HOME/.omp/agent" ] || command -v omp >/dev/null 2>&1; then
  mkdir -p "$HOME/.omp/agent/extensions"
  cp "$REPO_DIR/extensions/agentlog.ts" "$HOME/.omp/agent/extensions/"
  say "omp adapter installed (loads on next omp session)"
fi

# --- 5. claude adapter: idempotent settings merge ----------------------------
HOOK="$HOME/.claude/hooks/agentlog-hook.sh"
if [ -d "$HOME/.claude" ] || command -v claude >/dev/null 2>&1; then
  mkdir -p "$HOME/.claude/hooks"
  cp "$REPO_DIR/hooks/agentlog-hook.sh" "$HOOK"
  chmod +x "$HOOK"
  "$HOME/.local/bin/agentlog" wire-claude-hooks "$HOOK"
  say "claude adapter wired (SessionStart/Stop/PostToolUse)"
fi

# --- 6. acceptance gate ------------------------------------------------------
"$HOME/.local/bin/agentlog" verify >/dev/null 2>&1 || true   # no shard yet = ok
"$HOME/.local/bin/agentlog" inspect
say "install complete."
