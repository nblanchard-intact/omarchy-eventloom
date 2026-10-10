// agentlog omp adapter — captures omp session lifecycle, tool calls, approvals,
// and model events into the Omarchy universal agent log (eventloom hash chain).
// Installed beside the herdr extension; follows the same plugin interface.
// @ts-nocheck

import { execFile } from "node:child_process";

const HOME = process.env.HOME ?? "";
const AGENTLOG = `${HOME}/.local/bin/agentlog`;

function enabled() {
  return HOME !== "" && process.env.AGENTLOG_DISABLE !== "1";
}

function cwdOf(ctx) {
  return ctx?.cwd ?? ctx?.session?.cwd ?? process.cwd();
}

// Fire-and-forget: the agent path must never block on logging (consideration 6).
function append(type, payload) {
  execFile(AGENTLOG, ["append", type, "--actor", "omp", "--payload", JSON.stringify(payload)], { timeout: 5000 }, () => {}).unref?.();
}

export default function (pi) {
  if (!enabled()) return;

  let sessionKey = undefined;
  let correlationId = undefined;

  function activate(ctx, reason) {
    const cwd = cwdOf(ctx);
    if (sessionKey === undefined) {
      sessionKey = `${ctx?.sessionId ?? Date.now()}`;
      correlationId = `omp-${sessionKey}`;
      append("agent.session.started", {
        session_id: sessionKey,
        correlation_id: correlationId,
        cwd,
        reason: reason ?? "start",
      });
    } else {
      append("agent.session.resumed", {
        session_id: sessionKey,
        correlation_id: correlationId,
        cwd,
        reason: reason ?? "resume",
      });
    }
  }

  pi.on("session_start", (_event, ctx) => activate(ctx, "start"));
  pi.on("session_switch", (event, ctx) => activate(ctx, event?.reason ?? "switch"));

  pi.on("agent_start", (_event, ctx) => {
    activate(ctx, "agent_start");
    const model = ctx?.model ?? ctx?.session?.model;
    if (model) {
      append("agent.model.started", {
        session_id: sessionKey,
        correlation_id: correlationId,
        model,
      });
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    activate(ctx, "tool");
    append("agent.tool.started", {
      session_id: sessionKey,
      correlation_id: correlationId,
      tool: event?.toolName,
      args_summary: typeof event?.args === "object" ? Object.keys(event?.args ?? {}) : undefined,
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    activate(ctx, "tool");
    const failed = event?.isError ?? event?.error != null;
    append(failed ? "agent.tool.failed" : "agent.tool.completed", {
      session_id: sessionKey,
      correlation_id: correlationId,
      tool: event?.toolName,
      exit_code: event?.exitCode,
      duration_ms: event?.durationMs,
    });
  });

  pi.on("tool_approval_requested", (event, ctx) => {
    activate(ctx, "approval");
    append("agent.approval.requested", {
      session_id: sessionKey,
      correlation_id: correlationId,
      tool: event?.toolName,
      reason: event?.reason,
    });
  });

  pi.on("tool_approval_resolved", (event, ctx) => {
    activate(ctx, "approval");
    append("agent.approval.resolved", {
      session_id: sessionKey,
      correlation_id: correlationId,
      tool: event?.toolName,
      decision: event?.decision ?? event?.approved,
    });
  });

  pi.on("agent_end", (event) => {
    const failed = event?.isError ?? event?.error != null;
    append(failed ? "agent.session.failed" : "agent.session.completed", {
      session_id: sessionKey,
      correlation_id: correlationId,
      duration_ms: event?.durationMs,
    });
    sessionKey = undefined;
    correlationId = undefined;
  });

  pi.on("session_shutdown", () => {
    if (sessionKey !== undefined) {
      append("agent.session.completed", {
        session_id: sessionKey,
        correlation_id: correlationId,
        reason: "shutdown",
      });
      sessionKey = undefined;
      correlationId = undefined;
    }
  });
}
