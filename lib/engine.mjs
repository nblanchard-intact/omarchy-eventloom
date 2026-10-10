// agentlog engine — shared helpers for the shim and adapters.
// Path policy, provenance, redaction, and event-type vocabulary live here.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

export const LOG_DIR = path.join(homedir(), ".local", "state", "omarchy", "agents", "logs");

export function todayPath(now = new Date()) {
  return path.join(LOG_DIR, `${now.toISOString().slice(0, 10)}.jsonl`);
}

// --- Provenance -------------------------------------------------------------
// Every session.started event carries Omarchy context (consideration 6).

let omarchyVersionCache;

export function omarchyVersion() {
  if (omarchyVersionCache !== undefined) return omarchyVersionCache;
  try {
    omarchyVersionCache = execFileSync("omarchy", ["--version"], { encoding: "utf8", timeout: 2000 }).trim();
  } catch {
    omarchyVersionCache = null;
  }
  return omarchyVersionCache;
}

export function gitProvenance(cwd) {
  const out = {};
  if (!cwd || !existsSync(path.join(cwd, ".git"))) return out;
  try {
    out.git_branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", timeout: 1000 }).trim();
    out.git_commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8", timeout: 1000 }).trim();
    out.git_dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 1000 }).trim().length > 0;
  } catch {
    // not a repo or git failed — provenance is best-effort
  }
  return out;
}

export function sessionProvenance(agent, cwd) {
  return {
    agent,
    host: hostname(),
    omarchy: omarchyVersion(),
    cwd: cwd ?? process.cwd(),
    ...gitProvenance(cwd ?? process.cwd()),
  };
}

// --- Redaction (consideration 4) --------------------------------------------
// Secrets must never be sealed into the hash chain; sealing is irreversible.

const REDACT_PATTERNS = [
  // env-style assignments and common token shapes
  { re: /\b((?:api[_-]?key|token|secret|password|passwd|authorization|private[_-]?key)["'\s:=]+)([^\s"'`,;)}]{8,})/gi, replacement: "$1[REDACTED]" },
  { re: /\b(sk|pk)-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_KEY]" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED_GH]" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED_SLACK]" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED_JWT]" },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, replacement: "[REDACTED_PEM]" },
];

export function redactString(s) {
  let out = s;
  for (const { re, replacement } of REDACT_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function redact(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[redactString(k)] = redact(v, depth + 1);
    return out;
  }
  return value;
}

// --- Capture mode (consideration 4) ------------------------------------------
// AGENTLOG_MODE: full (default) | summary | metadata

export function captureMode() {
  const m = (process.env.AGENTLOG_MODE || "full").toLowerCase();
  return ["full", "summary", "metadata"].includes(m) ? m : "full";
}

export function applyCaptureMode(payload) {
  const mode = captureMode();
  if (mode === "full") return redact(payload);
  if (mode === "metadata") {
    // keep only structural fields, never content
    const keep = {};
    for (const k of ["agent", "session_id", "correlation_id", "cwd", "host", "omarchy", "git_branch", "git_commit", "git_dirty", "tool", "tool_name", "model", "status", "exit_code", "duration_ms"]) {
      if (payload[k] !== undefined) keep[k] = payload[k];
    }
    return redact(keep);
  }
  // summary: content fields replaced by short excerpts
  const out = redact(payload);
  for (const k of Object.keys(out)) {
    if (typeof out[k] === "string" && out[k].length > 200) out[k] = out[k].slice(0, 200) + "…";
  }
  return out;
}

// --- Event vocabulary (consideration 3) ---------------------------------------
// Envelope stays eventloom-strict; agent specifics live in payload.

export const EventTypes = {
  sessionStarted: "agent.session.started",
  sessionResumed: "agent.session.resumed",
  sessionCompleted: "agent.session.completed",
  sessionFailed: "agent.session.failed",
  modelStarted: "agent.model.started",
  modelCompleted: "agent.model.completed",
  toolStarted: "agent.tool.started",
  toolCompleted: "agent.tool.completed",
  toolFailed: "agent.tool.failed",
  approvalRequested: "agent.approval.requested",
  approvalResolved: "agent.approval.resolved",
  fileMutated: "agent.file.mutated",
  gitMutated: "agent.git.mutated",
  handoff: "agent.handoff",
  note: "agent.note.added",
};

// --- Adapter manifest (considerations 1 & 7) ----------------------------------
// Community-extensible: an adapter declares the agent it captures, how, and
// which hook file it installs. The doctor command checks each entry.

export function adaptersManifestPath() {
  return path.join(homedir(), ".local", "lib", "agentlog", "adapters.json");
}

export function loadAdapters() {
  const p = adaptersManifestPath();
  if (!existsSync(p)) return { adapters: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { adapters: [] };
  }
}
