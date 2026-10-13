import { AGENT_EVENT_SCHEMA, AgentEventKind, AgentEventV0 } from "@ascenda-one/agent-events";
import { AscendaEventPayload, AscendaTelemetryEventType } from "@ascenda-one/tool-contract";

/**
 * The public v0 event for one wire payload, written beside it on every line
 * of the local event log.
 *
 * The wire payload is the collector's own and changes when the backend's
 * contract does. This is the part outside readers build on, so it carries
 * less: what happened, in which agent and session, which tool, and how it
 * ended. Anything a field here can't say plainly stays out, and nothing that
 * isn't already metadata-only on the wire may come in.
 *
 * Every internal event type maps to a kind, `other` included, so a new type
 * shows up as `other` until someone gives it a kind here. Mapping it is
 * additive, which v0 allows.
 */
const KIND_BY_TYPE: Partial<Record<AscendaTelemetryEventType, AgentEventKind>> = {
  create_focus_session: "session.started",
  recovery_offline_period: "session.ended",
  ai_prompt_submitted: "prompt.submitted",
  ai_tool_call_started: "tool.started",
  ai_tool_call_completed: "tool.completed",
  ai_file_write: "tool.completed",
  ai_file_edit: "tool.completed",
  editor_verification_activity: "tool.completed",
  ai_tool_call_failed: "tool.failed",
  compile_error: "tool.failed",
  tool_failure: "tool.failed",
  ai_turn_completed: "turn.completed",
  supervision_interruption: "agent.waiting",
  permission_requested: "permission.requested",
  permission_denied: "permission.denied",
  context_compression_manual: "context.compacted",
  context_compression_auto: "context.compacted",
  subagent_started: "subagent.started",
  subagent_stopped: "subagent.stopped",
  pull_request_opened: "pull_request.opened",
  pull_request_closed: "pull_request.closed",
  pull_request_merged: "pull_request.merged"
};

/** The source names agents by tool type; `metadata.host` names the agent. VS Code has no host. */
function agentOf(payload: AscendaEventPayload): string {
  const host = stringField(payload.metadata?.host);
  if (host) return host;
  return payload.source === "vscode_extension" ? "vscode" : payload.source;
}

/**
 * The agent-event vocabulary for what the wire records as a git action or a
 * work milestone. Only the two that mark progress: a commit or push, and a pull
 * request opening or merging. Reversions and resets are a reading of the work,
 * not a fact about it, and stay off.
 */
function vcsActionOf(metadata: Record<string, unknown>): "commit" | "push" | "pr_created" | "pr_merged" | undefined {
  const milestone = stringField(metadata.milestoneKind);
  if (milestone === "pr_opened") return "pr_created";
  if (milestone === "pr_merged") return "pr_merged";
  const git = stringField(metadata.gitAction);
  return git === "commit" || git === "push" ? git : undefined;
}

/** Why the agent stopped to wait, in plain words. Absent for a kind we don't know. */
function waitReasonOf(metadata: Record<string, unknown>): "permission" | "idle" | "input" | "other" | undefined {
  switch (stringField(metadata.interruptionKind)) {
    case "permission_request": return "permission";
    case "input_request": return "input";
    case "idle_prompt": return "idle";
    case undefined: return undefined;
    default: return "other";
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function toAgentEvent(payload: AscendaEventPayload): AgentEventV0 {
  const metadata = payload.metadata ?? {};
  const kind = KIND_BY_TYPE[payload.eventType] ?? "other";
  // A tool name only means something on a tool event. Some other events
  // carry one for the backend's sake, and showing it there would read as a
  // tool call that never happened.
  const tool = kind.startsWith("tool.") || kind.startsWith("permission.") ? stringField(metadata.toolName) : undefined;
  const outcome = stringField(metadata.outcome);
  const vcsAction = kind === "tool.completed" ? vcsActionOf(metadata) : undefined;
  const reason = kind === "agent.waiting" ? waitReasonOf(metadata) : undefined;
  const model = kind === "session.started" ? stringField(metadata.modelId) : undefined;
  return {
    schema: AGENT_EVENT_SCHEMA,
    id: payload.idempotencyKey ?? `${payload.toolInstallationId}:${payload.occurredAt}:${payload.eventType}`,
    time: payload.occurredAt,
    // `+ 0` turns the -0 a UTC machine computes into 0, which is what JSON
    // writes anyway; without it the event in memory and the one on disk differ.
    ...(typeof payload.utcOffsetMinutes === "number" ? { utcOffsetMinutes: payload.utcOffsetMinutes + 0 } : {}),
    agent: agentOf(payload),
    kind,
    ...(stringField(payload.sessionId) ? { sessionId: payload.sessionId as string } : {}),
    ...(stringField(metadata.subagentId) ? { subagentId: metadata.subagentId as string } : {}),
    ...(tool ? { tool } : {}),
    ...(outcome && outcome !== "unknown" ? { outcome } : {}),
    ...(stringField(metadata.durationBucket) ? { durationBucket: metadata.durationBucket as string } : {}),
    ...(stringField(payload.projectHash) ? { projectHash: payload.projectHash as string } : {}),
    ...(stringField(metadata.repoKey) ? { repoKey: metadata.repoKey as string } : {}),
    ...(stringField(metadata.branchKey) ? { branchKey: metadata.branchKey as string } : {}),
    ...(stringField(metadata.autonomyMode) ? { permissionMode: metadata.autonomyMode as string } : {}),
    ...(stringField(metadata.headRepoKey) ? { headRepoKey: metadata.headRepoKey as string } : {}),
    ...(stringField(metadata.prCreatedAt) ? { prCreatedAt: metadata.prCreatedAt as string } : {}),
    ...(stringField(metadata.prClosedAt) ? { prClosedAt: metadata.prClosedAt as string } : {}),
    ...(stringField(metadata.prMergedAt) ? { prMergedAt: metadata.prMergedAt as string } : {}),
    ...(stringField(metadata.promptId) ? { promptId: metadata.promptId as string } : {}),
    ...(vcsAction ? { vcsAction } : {}),
    ...(reason ? { reason } : {}),
    ...(model ? { model } : {}),
    ...(stringField(metadata.collectorVersion) ? { collectorVersion: metadata.collectorVersion as string } : {}),
    sourceType: payload.eventType
  };
}
