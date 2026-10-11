/**
 * The agent event, v0: a small, public description of one thing a coding
 * agent did, written by Ascenda's collectors to a local file.
 *
 * Experimental. Fields can still be added, renamed or removed before v1; see
 * the package README for what may change and how changes are announced. The
 * JSON Schema in `schema/agent-event.v0.schema.json` and these types describe
 * the same shape, and a test holds them together.
 *
 * Metadata only. Nothing here carries prompt text, file contents, file names,
 * command lines or command output, and no field may be added that would.
 */

/** The `schema` value every v0 event carries. */
export const AGENT_EVENT_SCHEMA = "agent-event/v0";

/**
 * What happened. A consumer that meets a kind it doesn't know should treat
 * it as `other`: v0 may add kinds.
 */
export const AGENT_EVENT_KINDS = [
  "session.started",
  "session.ended",
  "prompt.submitted",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "turn.completed",
  "agent.waiting",
  "context.compacted",
  "subagent.started",
  "subagent.stopped",
  "other"
] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/**
 * The agents the collectors cover today. Open-ended on purpose: a collector
 * for a new agent sends its own name before this list learns it.
 */
export const KNOWN_AGENTS = ["claude_code", "codex", "cursor", "gemini_cli", "windsurf", "vscode"] as const;

export type AgentEventV0 = {
  schema: typeof AGENT_EVENT_SCHEMA;
  /** Unique per event. Seeing the same id twice means the same event. */
  id: string;
  /** When it happened, UTC, ISO 8601. */
  time: string;
  /** Minutes the machine's clock was ahead of UTC at `time` (Brisbane 600, Los Angeles -420). */
  utcOffsetMinutes?: number;
  /** Which agent: one of {@link KNOWN_AGENTS}, or another agent's own name. */
  agent: string;
  kind: AgentEventKind;
  /** The agent's own session id, when it gives one. */
  sessionId?: string;
  /** Set on events that happened inside a subagent, and on its start and stop. */
  subagentId?: string;
  /** The tool's name as the agent reports it (`Edit`, `Bash`, `read_file`), on `tool.*` kinds. */
  tool?: string;
  /** How a tool call ended, when the collector could tell: `success`, `failure` or `cancelled`. */
  outcome?: string;
  /** How long it took, as a bucket: `0-1m`, `1-5m`, `5-10m`, `10-30m`, `30-60m`, `60m+`. Never an exact duration. */
  durationBucket?: string;
  /**
   * A salted hash of the project the work was in. The salt never leaves the
   * machine, so the same project hashes the same way on one machine and
   * differently on another.
   */
  projectHash?: string;
  /** Version of the collector that wrote the event. */
  collectorVersion?: string;
  /**
   * The collector's own name for the event, for debugging. Not part of the
   * contract: it can change in any release.
   */
  sourceType?: string;
};

/** One line of the local event log. Only `event` is the contract; the rest is the collector's own. */
export type EventLogLine = {
  loggedAt?: string;
  event?: AgentEventV0;
  [key: string]: unknown;
};

/**
 * Checks the fields a consumer relies on. Lenient about everything else, so
 * an event from a newer v0 collector with an extra field still passes.
 */
export function isAgentEventV0(value: unknown): value is AgentEventV0 {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return e.schema === AGENT_EVENT_SCHEMA
    && typeof e.id === "string" && e.id.length > 0
    && typeof e.time === "string" && !Number.isNaN(Date.parse(e.time))
    && typeof e.agent === "string" && e.agent.length > 0
    && typeof e.kind === "string";
}

/**
 * The event on one log line, or undefined for a blank, partial or older line.
 * A line written by a collector before v0 has no `event` and is skipped.
 */
export function parseEventLogLine(line: string): AgentEventV0 | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed = JSON.parse(line) as EventLogLine;
    return isAgentEventV0(parsed?.event) ? parsed.event : undefined;
  } catch {
    return undefined;
  }
}

/** A kind this version doesn't know, read as `other`. */
export function normaliseKind(kind: string): AgentEventKind {
  return (AGENT_EVENT_KINDS as readonly string[]).includes(kind) ? (kind as AgentEventKind) : "other";
}
