#!/usr/bin/env node
// agentlog — universal append-only agent event log for Omarchy, powered by @eventloom/runtime.
// Log path: ~/.local/state/agentlog/YYYY-MM-DD.jsonl (daily shard, hash-chained, tamper-evident).
import { appendExternalEvent, createRuntime } from "@eventloom/runtime";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { LOG_DIR, applyCaptureMode, sessionProvenance, EventTypes, loadAdapters, adaptersManifestPath, todayPath } from "./engine.mjs";

const LOG_FALLBACK = path.join(homedir(), ".local", "state", "agentlog");

function localTodayPath() {
  // Legacy fallback location used by the first smoke tests.
  const day = new Date().toISOString().slice(0, 10);
  return path.join(LOG_FALLBACK, `${day}.jsonl`);
}

function fail(msg) {
  console.error(`agentlog: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  let [cmd, ...rest] = argv;
  const opts = { type: null, actor: "unknown", payload: "{}", thread: "thread_main", limit: 20, log: null, actorGiven: false };
  // omarchy-agent-* wrappers pass the subcommand as a positional alias.
  if (rest.length && !rest[0].startsWith("--") && ["tail", "verify", "doctor", "path", "inspect"].includes(rest[0]) && cmd !== rest[0]) {
    cmd = rest.shift();
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--actor") { opts.actor = rest[++i]; opts.actorGiven = true; }
    else if (a === "--payload") opts.payload = rest[++i];
    else if (a === "--thread") opts.thread = rest[++i];
    else if (a === "--limit") opts.limit = parseInt(rest[++i], 10);
    else if (a === "--log") opts.log = rest[++i];
    else if (a === "--correlation") opts.correlation = rest[++i];
    else if (a === "--cwd") opts.cwd = rest[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("--") && cmd === "append") {
      if (opts.type === null) opts.type = a;
      else fail(`unexpected argument: ${a}`);
    } else if (!a.startsWith("--")) {
      if (cmd === "wire-claude-hooks") opts.hookPath = a;
      else fail(`unexpected argument: ${a}`);
    }
  }
  return { cmd, opts };
}

const HELP = `agentlog — universal append-only agent event log for Omarchy

Usage:
  agentlog append <event.type> [--actor <id>] [--thread <id>] [--payload '<json>']
                  [--correlation <id>] [--cwd <path>]
  agentlog tail [--limit N] [--actor <id>] [--log <path>]
  agentlog verify [--log <path>]
  agentlog doctor          # adapter install status
  agentlog path

Log: ~/.local/state/omarchy/agents/logs/YYYY-MM-DD.jsonl (daily shard, hash-chained)
Capture modes: AGENTLOG_MODE=full (default) | summary | metadata
Exit codes: 0 ok, 1 usage error, 2 tampered/corrupt log.`;

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (opts.help || !cmd) { console.log(HELP); return; }

  const logPath = opts.log ?? todayPath();
  if (cmd === "path") { console.log(logPath); return; }

  if (cmd === "append") {
    if (!opts.type) fail("append requires an event type, e.g. agent.session.started");
    let payload;
    try { payload = JSON.parse(opts.payload); } catch { fail("--payload must be valid JSON"); }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      fail("--payload must be a JSON object");
    }
    if (opts.correlation) payload.correlation_id = opts.correlation;
    if (opts.cwd) payload.cwd = opts.cwd;
    // Redact secrets and apply capture mode before sealing (irreversible chain).
    const clean = applyCaptureMode(payload);
    mkdirSync(LOG_DIR, { recursive: true });
    const sealed = await appendExternalEvent({
      path: logPath,
      type: opts.type,
      actorId: opts.actor,
      threadId: opts.thread,
      payload: clean,
    });
    console.log(JSON.stringify({ id: sealed.id, type: sealed.type, hash: sealed.integrity?.hash }));
    return;
  }

  if (cmd === "tail") {
    if (!existsSync(logPath)) { console.log("(empty)"); return; }
    // replay() returns projections only; read the sealed JSONL directly for tail.
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    let shown = lines.map((l) => JSON.parse(l));
    if (opts.actorGiven) shown = shown.filter((e) => e.actorId === opts.actor);
    for (const e of shown.slice(-opts.limit)) {
      console.log(JSON.stringify({ ts: e.timestamp, type: e.type, actor: e.actorId, thread: e.threadId, payload: e.payload }));
    }
    return;
  }

  if (cmd === "verify") {
    if (!existsSync(logPath)) fail(`log not found: ${logPath}`);
    const runtime = createRuntime(logPath);
    const report = await runtime.verify();
    const ok = report?.ok ?? report?.integrity?.ok ?? false;
    console.log(JSON.stringify({ ok, diagnostics: report?.diagnostics ?? [], errors: report?.errors ?? [] }));
    if (!ok) process.exit(2);
    return;
  }

  if (cmd === "wire-claude-hooks") {
    // Idempotent registration of the agentlog hook in ~/.claude/settings.json.
    // Used by install.sh; safe to re-run (never duplicates entries).
    const hookPath = opts.hookPath ?? `${homedir()}/.claude/hooks/agentlog-hook.sh`;
    const absHook = hookPath.replace(/^~/, homedir());
    const settingsPath = `${homedir()}/.claude/settings.json`;
    let settings = {};
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* fresh machine: create minimal */ }
    settings.hooks ??= {};
    const HOOK_EVENTS = [["SessionStart", "session_start"], ["Stop", "session_stop"], ["PostToolUse", "post_tool"]];
    let added = 0;
    for (const [event, arg] of HOOK_EVENTS) {
      const entries = (settings.hooks[event] ??= []);
      const entry = entries.find((e) => (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes("agentlog-hook.sh") && (/ [\w-]+$/.exec(h.command)?.[0] === ` ${arg}`)));
      if (entry) { entry.hooks[0].command = `bash '${absHook}' ${arg}`; continue; } // refresh path, no duplicate
      entries.push({
        matcher: "*",
        hooks: [{ type: "command", command: `bash '${absHook}' ${arg}`, timeout: 10 }],
      });
      added++;
    }
    mkdirSync(`${homedir()}/.claude`, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log(JSON.stringify({ ok: true, added, preserved: Object.keys(settings.hooks).filter((k) => k.startsWith("Session") || k === "Stop" || k === "PostToolUse").length }));
    return;
  }

  if (cmd === "inspect" || cmd === "doctor") {
    // Adapter health check (consideration 7): is each declared adapter installed?
    const manifest = loadAdapters();
    console.log(`log dir:    ${LOG_DIR}`);
    console.log(`adapters:   ${adaptersManifestPath()}`);
    if (!manifest.adapters.length) { console.log("  (none declared)"); return; }
    for (const a of manifest.adapters) {
      const installed = a.hook_path ? existsSync(a.hook_path.replace(/^~/, homedir())) : false;
      console.log(`  ${a.agent.padEnd(12)} ${installed ? "installed" : "MISSING "} ${installed ? "" : a.hook_path} ${a.method ? `(${a.method})` : ""}`);
    }
    return;
  }

  fail(`unknown command: ${cmd} (see --help)`);
}

main().catch((err) => {
  console.error("agentlog:", err?.message ?? err);
  process.exit(1);
});
