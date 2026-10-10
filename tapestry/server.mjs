// tapestry server — reads eventloom shards, serves the weave-spec + canvas app.
// Read-only projection: the sealed log is never touched.
//   eventloom tapestry [--port 4747] [--days N]
import { createServer } from "node:http";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LOG_DIR = `${homedir()}/.local/state/omarchy/agents/logs`;
const EVENT_FAMILY = {
  "agent.session.started": "lifecycle",
  "agent.session.resumed": "lifecycle",
  "agent.session.completed": "lifecycle",
  "agent.session.failed": "lifecycle",
  "agent.tool.started": "tool",
  "agent.tool.completed": "tool",
  "agent.tool.failed": "tool",
  "agent.approval.requested": "approval",
  "agent.approval.resolved": "approval",
  "agent.model.started": "model",
  "agent.model.completed": "model",
  "agent.handoff": "handoff",
  "agent.file.mutated": "file",
  "agent.git.mutated": "git",
  "agent.note.added": "note",
};

// A deliberately representative, in-memory weave. It is only used with
// --demo, never merged with or written to a user's sealed shard.
export function demoEvents() {
  const at = (minutes) => new Date(Date.UTC(2026, 9, 10, 8, minutes)).toISOString();
  const event = (id, minutes, type, actor, session, payload = {}) => ({
    id, day: "2026-10-10", line: 0, ts: at(minutes), type,
    family: EVENT_FAMILY[type] ?? "other", actor, thread: actor + "-main",
    session, correlation: payload.correlation_id ?? null, tool: payload.tool ?? null,
    duration: payload.duration_ms ?? 0, exit: payload.exit_code ?? null,
    ok: (payload.exit_code ?? 0) === 0 && !type.endsWith(".failed"),
    payload, hash: null, prevHash: null,
  });
  return [
    event("demo-01", 0, "agent.session.started", "omp", "research"),
    event("demo-02", 4, "agent.tool.completed", "omp", "research", { tool: "rg", duration_ms: 400 }),
    event("demo-03", 8, "agent.tool.completed", "omp", "research", { tool: "bash", duration_ms: 1900 }),
    event("demo-04", 12, "agent.approval.requested", "omp", "research"),
    event("demo-05", 18, "agent.handoff", "omp", "research", { to_session_id: "build", correlation_id: "release" }),
    event("demo-06", 22, "agent.session.completed", "omp", "research"),
    event("demo-07", 14, "agent.session.started", "claude", "review"),
    event("demo-08", 18, "agent.tool.completed", "claude", "review", { tool: "read", duration_ms: 700 }),
    event("demo-09", 31, "agent.session.resumed", "claude", "review"),
    event("demo-10", 33, "agent.tool.completed", "claude", "review", { tool: "edit", duration_ms: 2200 }),
    event("demo-11", 42, "agent.session.completed", "claude", "review"),
    event("demo-12", 20, "agent.session.started", "codex", "build"),
    event("demo-13", 24, "agent.tool.completed", "codex", "build", { tool: "apply_patch", duration_ms: 6300 }),
    event("demo-14", 26, "agent.tool.completed", "codex", "build", { tool: "test", duration_ms: 8400 }),
    event("demo-15", 35, "agent.file.mutated", "codex", "build"),
    event("demo-16", 43, "agent.session.completed", "codex", "build", { goal_completed: true }),
    event("demo-17", 29, "agent.session.started", "omp", "experiment"),
    event("demo-18", 36, "agent.tool.failed", "omp", "experiment", { tool: "bash", exit_code: 1 }),
    event("demo-19", 40, "agent.session.failed", "omp", "experiment"),
  ];
}

function loadShards(days) {
  if (!existsSync(LOG_DIR)) return [];
  const files = readdirSync(LOG_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-days);
  const events = [];
  for (const f of files) {
    const day = f.slice(0, 10);
    const text = readFileSync(path.join(LOG_DIR, f), "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        events.push({
          id: e.id,
          day,
          line: i,
          ts: e.timestamp ?? e.ts ?? new Date(0).toISOString(),
          type: e.type,
          family: EVENT_FAMILY[e.type] ?? "other",
          actor: e.actorId ?? e.actor ?? "unknown",
          thread: e.threadId ?? e.thread ?? null,
          correlation: e.payload?.correlation_id ?? null,
          session: e.payload?.session_id ?? null,
          tool: e.payload?.tool ?? null,
          duration: e.payload?.duration_ms ?? null,
          exit: e.payload?.exit_code ?? null,
          ok: (e.payload?.exit_code ?? 0) === 0 && !/failed/.test(e.type),
          payload: e.payload ?? {},
          hash: e.integrity?.hash ?? null,
          prevHash: e.integrity?.previousHash ?? null,
        });
      } catch { /* skip corrupt line; verify reports it */ }
    }
  }
  return events;
}

// Derived, disposable session geometry. The raw stitches remain available for
// close inspection; this only gives the renderer a stable overview shape.
export function deriveSessions(stitches) {
  const grouped = new Map();
  for (const stitch of stitches) {
    const key = stitch.session ?? (stitch.actor + ":" + (stitch.thread ?? "unthreaded"));
    (grouped.get(key) ?? grouped.set(key, []).get(key)).push(stitch);
  }
  const sessions = [];
  for (const [sessionId, events] of grouped) {
    let segment = null, previous = null, ordinal = 0;
    for (const event of events) {
      const boundary = event.type === "agent.session.started" || event.type === "agent.session.resumed";
      if (!segment || boundary) {
        if (segment) sessions.push(segment);
        segment = {
          id: sessionId + ":" + ordinal++, sessionId, actor: event.actor, thread: event.thread,
          stitches: [], resumed: event.type === "agent.session.resumed", resumeOf: previous?.id ?? null,
        };
        previous = segment;
      }
      segment.stitches.push(event);
    }
    if (segment) sessions.push(segment);
  }
  return sessions.map((session) => {
    const entries = session.stitches;
    const start = Date.parse(entries[0].ts);
    const end = Math.max(start + 60_000, Date.parse(entries.at(-1).ts));
    const bins = Math.max(3, Math.min(12, Math.ceil((end - start) / (20 * 60_000))));
    const counts = Array.from({ length: bins }, () => 0);
    for (const entry of entries) {
      const i = Math.max(0, Math.min(bins - 1, Math.floor(((Date.parse(entry.ts) - start) / (end - start)) * bins)));
      counts[i] += 1 + Math.min(2, Math.log2(1 + (entry.duration ?? 0) / 1000));
    }
    const peak = Math.max(...counts, 1);
    const final = entries.at(-1);
    const status = final.type === "agent.session.completed" ? "completed"
      : final.type === "agent.session.failed" ? "failed" : "open";
    return {
      ...session, start, end, eventCount: entries.length, status,
      completion: status === "completed" || entries.some((entry) => entry.payload?.goal_completed === true),
      failure: status === "failed" || entries.some((entry) => !entry.ok),
      activity: counts.map((count, i) => ({ t: (i + .5) / bins, count, value: count / peak })),
    };
  });
}

// Weave-spec: the full weaving instruction for the canvas.
export function weaveSpec(events) {
  const actors = [...new Set(events.map((e) => e.actor))].sort();
  const warp = actors.map((actor, i) => ({ actor, x: i }));

  // Stitches: one per event, positioned on its actor's warp.
  const byTs = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const t0 = byTs[0]?.ts ?? 0;
  const t1 = byTs.at(-1)?.ts ?? 1;
  const span = Math.max(1, Date.parse(t1) - Date.parse(t0));
  const stitches = byTs.map((e) => ({
    ...e,
    warpIndex: actors.indexOf(e.actor),
    t: (Date.parse(e.ts) - Date.parse(t0)) / span, // 0..1 position on the cloth
  }));

  // Strands: correlation yarn between stitches of different warps/times.
  const byCorr = new Map();
  for (const s of stitches) {
    if (!s.correlation) continue;
    (byCorr.get(s.correlation) ?? byCorr.set(s.correlation, []).get(s.correlation)).push(s);
  }
  const strands = [];
  for (const [corr, group] of byCorr) {
    for (let i = 0; i + 1 < group.length; i++) {
      strands.push({ correlation: corr, from: group[i].id, to: group[i + 1].id, kind: "correlation" });
    }
  }
  // Handoff strands: dashed branch connections.
  const handoffs = stitches.filter((s) => s.family === "handoff" && s.payload?.from && s.payload?.to);

  // Session clusters -> procedural design parameters.
  const clusters = new Map();
  for (const s of stitches) {
    const key = s.session ?? `${s.actor}:anon`;
    (clusters.get(key) ?? clusters.set(key, []).get(key)).push(s);
  }
  const designs = [...clusters.entries()].map(([session, ss]) => {
    const n = ss.length;
    const tools = new Set(ss.map((s) => s.tool).filter(Boolean)).size;
    const errors = ss.filter((s) => !s.ok).length;
    const corr = new Set(ss.map((s) => s.correlation).filter(Boolean)).size;
    const dur = Math.max(...ss.map((s) => s.duration ?? 0));
    const density = Math.min(1, n / 30);
    return {
      session,
      anchor: ss[0].id,
      warpIndex: ss[0].warpIndex,
      t: ss[0].t,
      // Motif genome: density -> petal count, tool diversity -> symmetry order,
      // error rate -> jaggedness, duration -> radius, correlations -> knot.
      genome: {
        petals: 3 + Math.round(density * 9),
        symmetry: 1 + tools,
        jag: errors / Math.max(1, n),
        radius: 10 + Math.min(30, Math.log2(1 + dur / 100) * 8),
        knot: corr >= 2,
        density,
      },
    };
  });

  return { warp, stitches, sessions: deriveSessions(stitches), strands, handoffs, designs, span: { t0, t1 } };
}

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const JS = readFileSync(new URL("./weave.js", import.meta.url), "utf8");

export function main(argv) {
  let port = 4747, days = 7, demo = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") port = parseInt(argv[++i], 10);
    if (argv[i] === "--days") days = parseInt(argv[++i], 10);
    if (argv[i] === "--demo") demo = true;
  }
  const server = createServer((req, res) => {
    if (req.url === "/weave.json") {
      const spec = weaveSpec(demo ? demoEvents() : loadShards(days));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(spec));
      return;
    }
    if (req.url === "/weave.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(JS);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`tapestry: http://127.0.0.1:${port} (${demo ? "demo weave" : "last " + days + " day(s)"})`);
  });
}
