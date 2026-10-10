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
  context_compression_manual: "context.compacted",
  context_compression_auto: "context.compacted",
  subagent_started: "subagent.started",
  subagent_stopped: "subagent.stopped"
};

/** The source names agents by tool type; `metadata.host` names the agent. VS Code has no host. */
function agentOf(payload: AscendaEventPayload): string {
  const host = stringField(payload.metadata?.host);
  if (host) return host;
  return payload.source === "vscode_extension" ? "vscode" : payload.source;
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
  const tool = kind.startsWith("tool.") ? stringField(metadata.toolName) : undefined;
  const outcome = stringField(metadata.outcome);
  return {
    schema: AGENT_EVENT_SCHEMA,
    id: payload.idempotencyKey ?? `${payload.toolInstallationId}:${payload.occurredAt}:${payload.eventType}`,
    time: payload.occurredAt,
    ...(typeof payload.utcOffsetMinutes === "number" ? { utcOffsetMinutes: payload.utcOffsetMinutes } : {}),
    agent: agentOf(payload),
    kind,
    ...(stringField(payload.sessionId) ? { sessionId: payload.sessionId as string } : {}),
    ...(stringField(metadata.subagentId) ? { subagentId: metadata.subagentId as string } : {}),
    ...(tool ? { tool } : {}),
    ...(outcome && outcome !== "unknown" ? { outcome } : {}),
    ...(stringField(metadata.durationBucket) ? { durationBucket: metadata.durationBucket as string } : {}),
    ...(stringField(payload.projectHash) ? { projectHash: payload.projectHash as string } : {}),
    ...(stringField(metadata.collectorVersion) ? { collectorVersion: metadata.collectorVersion as string } : {}),
    sourceType: payload.eventType
  };
}
