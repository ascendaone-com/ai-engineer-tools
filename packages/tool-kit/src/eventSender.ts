import {
  ASCENDA_CONSENT_SCOPE,
  ASCENDA_PROVENANCE,
  ASCENDA_SEMANTIC_CONSENT_SCOPE,
  ASCENDA_COLLABORATION_CONSENT_SCOPE,
  COLLABORATION_EVENT_TYPES,
  ASCENDA_SEMANTIC_PROVENANCE,
  AscendaEventMetadata,
  AscendaEventPayload,
  AscendaSeverity,
  AscendaTelemetryEventType,
  AscendaTelemetrySource,
  IngestResult,
  SEMANTIC_WORK_SIGNAL_EVENT_TYPES
} from "@ascenda-one/tool-contract";
import { appendEventLog, resolveEventLogPath } from "./eventLog";
import { postToolEvent, renewToolToken } from "./http";
import { persistEventWriteToken } from "./tokenStore";

export type MappedEvent = {
  eventType: AscendaTelemetryEventType;
  severity: AscendaSeverity;
  metadata?: AscendaEventMetadata;
};

/**
 * A semantic (agent-observed) event — never a deterministic hook mapping.
 * `skillVersion` is mandatory here, not merely documented on the wire type,
 * so a caller that forgets it fails at the call site rather than producing
 * an event the backend will reject.
 */
export type MappedSemanticEvent = {
  eventType: AscendaTelemetryEventType;
  metadata: AscendaEventMetadata & { skillVersion: string };
};

export class AscendaSemanticEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AscendaSemanticEventError";
  }
}

export type EventSenderConfig = {
  apiBaseUrl: string;
  toolInstallationId: string;
  source: AscendaTelemetrySource;
  eventWriteToken: string;
  tokenFilePath: string;
  sessionId?: string | null;
  workspaceHash?: string | null;
  /** Hard cap per HTTP call. Hook-path telemetry must fail fast, never stall the agent. */
  timeoutMs?: number;
  /** Local JSONL sink. Defaults to ASCENDA_EVENT_LOG_FILE; absent means no logging. */
  eventLogFile?: string | null;
};

/** Who an event is from. The subset of sender config a payload is built out of. */
export type EventIdentity = {
  toolInstallationId: string;
  source: AscendaTelemetrySource;
  sessionId?: string | null;
  workspaceHash?: string | null;
};

/**
 * The canonical wire payload for a standard-scope host event. Shared so a
 * caller that logs an event without sending it records byte-for-byte what a
 * send would have put on the wire — otherwise the local log slowly stops being
 * evidence of anything.
 *
 * The semantic and collaboration senders build their own payloads: their
 * consent scope, provenance and severity are properties of what the event is,
 * and folding them in here would mean an options bag that lets the wrong pair
 * be passed by accident.
 */
export function buildEventPayload(identity: EventIdentity, mapped: MappedEvent): AscendaEventPayload {
  return {
    toolInstallationId: identity.toolInstallationId,
    source: identity.source,
    occurredAt: new Date().toISOString(),
    sessionId: identity.sessionId ?? undefined,
    workspaceHash: identity.workspaceHash ?? undefined,
    consentScope: ASCENDA_CONSENT_SCOPE,
    provenance: ASCENDA_PROVENANCE,
    privacyMode: "metadata_only",
    ...mapped,
    metadata: mapped.metadata ?? {}
  };
}

/**
 * Shared one-shot event sender for agent hook adapters (Claude Code, Codex).
 * Sends metadata-only events with the standard consent scope and provenance,
 * renews the event write token once on auth failure, and persists rotations.
 */
export class AscendaEventSender {
  private eventWriteToken: string;

  constructor(private readonly config: EventSenderConfig) {
    this.eventWriteToken = config.eventWriteToken;
  }

  async send(mapped: MappedEvent): Promise<IngestResult> {
    return this.post(buildEventPayload(this.config, mapped));
  }

  /**
   * Sends one of the six agent-observed types (dark-flow-gap-analysis §2.1).
   * Distinct from {@link send} rather than an option on it, because the
   * differences are non-negotiable, not caller preference:
   *
   *  - `consentScope`/`provenance` are always the semantic pair — a lease on
   *    `ide_telemetry` alone does not cover these.
   *  - `severity` is always `"low"`. The emitter has no baseline to judge
   *    against; an elevated reading can only come from the backend's own
   *    z-scored evaluation, never from this payload.
   *  - `metadata.skillVersion` is required by the type, not merely
   *    documented, and checked again here in case a caller building the
   *    object dynamically bypasses the type system.
   *
   * Rejects locally (never reaches the network) for an eventType outside
   * {@link SEMANTIC_WORK_SIGNAL_EVENT_TYPES} or a missing/blank
   * `skillVersion` — a malformed semantic event is a bug in the caller, not
   * something the backend should have to catch.
   */
  async sendSemanticSignal(mapped: MappedSemanticEvent): Promise<IngestResult> {
    if (!SEMANTIC_WORK_SIGNAL_EVENT_TYPES.includes(mapped.eventType)) {
      throw new AscendaSemanticEventError(
        `"${mapped.eventType}" is not a semantic work-signal type. Use send() for a deterministic host event.`
      );
    }
    if (!mapped.metadata.skillVersion || !mapped.metadata.skillVersion.trim()) {
      throw new AscendaSemanticEventError(
        `metadata.skillVersion is required for semantic event "${mapped.eventType}".`
      );
    }

    const payload: AscendaEventPayload = {
      toolInstallationId: this.config.toolInstallationId,
      source: this.config.source,
      eventType: mapped.eventType,
      occurredAt: new Date().toISOString(),
      severity: "low",
      sessionId: this.config.sessionId ?? undefined,
      workspaceHash: this.config.workspaceHash ?? undefined,
      consentScope: ASCENDA_SEMANTIC_CONSENT_SCOPE,
      provenance: ASCENDA_SEMANTIC_PROVENANCE,
      privacyMode: "metadata_only",
      metadata: mapped.metadata
    };
    return this.post(payload);
  }

  /**
   * Sends a collaboration event under `workflow_telemetry`.
   *
   * A separate method rather than an option on {@link send}, for the same
   * reason {@link sendSemanticSignal} is: the consent scope is a property of
   * what the event *is*, and an options bag would let the wrong one be passed
   * by accident. Rejects locally for anything outside
   * {@link COLLABORATION_EVENT_TYPES}.
   */
  async sendCollaborationSignal(mapped: MappedEvent): Promise<IngestResult> {
    if (!COLLABORATION_EVENT_TYPES.includes(mapped.eventType)) {
      throw new AscendaSemanticEventError(
        `"${mapped.eventType}" is not a collaboration event type. Use send() for a deterministic host event.`
      );
    }

    const payload: AscendaEventPayload = {
      toolInstallationId: this.config.toolInstallationId,
      source: this.config.source,
      eventType: mapped.eventType,
      occurredAt: new Date().toISOString(),
      severity: "low",
      sessionId: this.config.sessionId ?? undefined,
      workspaceHash: this.config.workspaceHash ?? undefined,
      consentScope: ASCENDA_COLLABORATION_CONSENT_SCOPE,
      provenance: ASCENDA_PROVENANCE,
      privacyMode: "metadata_only",
      metadata: mapped.metadata ?? {}
    };
    return this.post(payload);
  }

  private async post(payload: AscendaEventPayload): Promise<IngestResult> {
    let result: IngestResult;
    try {
      result = await postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload, this.signal());
      if (result === "auth_failed") {
        const renewed = await this.renewEventToken();
        result = renewed
          ? await postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload, this.signal())
          : "auth_failed";
      }
    } catch (error) {
      // An unreachable backend is exactly when the local log earns its keep, so
      // record the event before letting the caller see the failure.
      this.log(payload, "other");
      throw error;
    }

    this.log(payload, result);
    return result;
  }

  /**
   * Every send path funnels through {@link post}, so semantic and
   * collaboration signals are logged on the same terms as host events — the
   * log would be misleading as an audit of what left the machine otherwise.
   */
  private log(payload: AscendaEventPayload, delivery: IngestResult): void {
    const logFile = this.config.eventLogFile === undefined ? resolveEventLogPath() : this.config.eventLogFile;
    if (!logFile) return;
    appendEventLog(logFile, { loggedAt: new Date().toISOString(), delivery, payload });
  }

  async renewEventToken(): Promise<boolean> {
    const renewed = await renewToolToken(this.config.apiBaseUrl, this.eventWriteToken, this.signal());
    if (!renewed) return false;
    this.eventWriteToken = renewed.eventWriteToken;
    persistEventWriteToken(this.config.tokenFilePath, renewed.eventWriteToken);
    return true;
  }

  private signal(): AbortSignal | undefined {
    return this.config.timeoutMs ? AbortSignal.timeout(this.config.timeoutMs) : undefined;
  }
}
