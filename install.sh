#!/bin/sh
# omarchy-eventloom installer — zero-touch, idempotent.
# Copies sources out of this repo, wires adapters, verifies the result.
set -eu

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$HOME/.local/lib/eventloom"
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
cp "$REPO_DIR/lib/engine.mjs" "$REPO_DIR/lib/eventloom.mjs" "$REPO_DIR/lib/adapters.json" "$LIB_DIR/"
mkdir -p "$LIB_DIR/../tapestry"
cp "$REPO_DIR/tapestry/server.mjs" "$REPO_DIR/tapestry/index.html" "$REPO_DIR/tapestry/weave.js" "$LIB_DIR/../tapestry/"
cp "$REPO_DIR/bin/eventloom" "$REPO_DIR/bin/omarchy-eventloom" "$REPO_DIR/bin/omarchy-eventloom-inspect" "$BIN_DIR/"
chmod +x "$BIN_DIR/eventloom" "$BIN_DIR/omarchy-eventloom" "$BIN_DIR/omarchy-eventloom-inspect"
say "installed cli -> $BIN_DIR/eventloom"

# --- 3. always provision the node fallback ----------------------------------
# A graphical/login shell may discover Bun while an interactive terminal only
# has Node on PATH. Keep both launch paths valid after one installation.
if [ ! -d "$LIB_DIR/node_modules/@eventloom/runtime" ]; then
  say "installing @eventloom/runtime for the node fallback"
  npm install --prefix "$LIB_DIR" --no-fund --no-audit --silent @eventloom/runtime@1
fi

# --- 4. omp adapter: only when omp is present --------------------------------
if [ -d "$HOME/.omp/agent" ] || command -v omp >/dev/null 2>&1; then
  mkdir -p "$HOME/.omp/agent/extensions"
  cp "$REPO_DIR/extensions/eventloom.ts" "$HOME/.omp/agent/extensions/"
  say "omp adapter installed (loads on next omp session)"
fi

# --- 5. claude adapter: idempotent settings merge ----------------------------
HOOK="$HOME/.claude/hooks/eventloom-hook.sh"
if [ -d "$HOME/.claude" ] || command -v claude >/dev/null 2>&1; then
  mkdir -p "$HOME/.claude/hooks"
  cp "$REPO_DIR/hooks/eventloom-hook.sh" "$HOOK"
  chmod +x "$HOOK"
  "$HOME/.local/bin/eventloom" wire-claude-hooks "$HOOK"
  say "claude adapter wired (SessionStart/Stop/PostToolUse)"
fi

# --- 6. acceptance gate ------------------------------------------------------
"$HOME/.local/bin/eventloom" verify >/dev/null 2>&1 || true   # no shard yet = ok
"$HOME/.local/bin/eventloom" inspect
say "install complete."
