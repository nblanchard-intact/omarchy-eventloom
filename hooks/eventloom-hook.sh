#!/bin/sh
# eventloom claude adapter — reads hook JSON from stdin, appends to the universal agent log.
# Opt-out: EVENTLOOM_DISABLE=1. Managed by the eventloom prototype; reinstalling overwrites.
command -v eventloom >/dev/null 2>&1 || exit 0
[ "${EVENTLOOM_DISABLE:-0}" = "1" ] && exit 0

event="$1"
[ -n "$event" ] || exit 0
input="$(cat)"

parsed="$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print(json.dumps({
    "session_id": d.get("session_id") or d.get("sessionId") or "unknown",
    "cwd": d.get("cwd"),
    "hook_event": d.get("hook_event_name") or d.get("hookEventName"),
    "tool": d.get("tool_name") or d.get("toolName"),
    "tool_input_keys": sorted((d.get("tool_input") or d.get("toolInput") or {}).keys()),
}))
' 2>/dev/null)" || exit 0

payload="$(printf '%s' "$parsed" | python3 -c 'import json,sys; print(json.dumps({k:v for k,v in json.load(sys.stdin).items() if v is not None}))')"
thread="$(printf '%s' "$parsed" | python3 -c 'import json,sys; print("claude-" + (json.load(sys.stdin).get("session_id") or "unknown"))')"

case "$event" in
  session_start) eventloom append agent.session.started  --actor claude --thread "$thread" --payload "$payload" >/dev/null 2>&1 & ;;
  session_stop)  eventloom append agent.session.completed --actor claude --thread "$thread" --payload "$payload" >/dev/null 2>&1 & ;;
  post_tool)     eventloom append agent.tool.completed   --actor claude --thread "$thread" --payload "$payload" >/dev/null 2>&1 & ;;
esac
exit 0
