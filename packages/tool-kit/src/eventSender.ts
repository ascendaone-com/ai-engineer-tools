import { utcOffsetMinutesAt } from "./afterHours";
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
import { IngestOutcome, isRetryableStatus, postToolEvent, renewToolToken } from "./http";
import { persistEventWriteToken } from "./tokenStore";
import { CollectorState, defaultStateFilePath, recordSendOutcome } from "./stateStore";
import { mintIdempotencyKey } from "./payload";

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
  projectHash?: string | null;
  /** Hard cap per HTTP call. Hook-path telemetry must fail fast, never stall the agent. */
  timeoutMs?: number;
  /** Send journal location. Defaults to ~/.ascenda/state/<installationId>.json. */
  stateFilePath?: string;
  /** Local JSONL sink. Defaults to ASCENDA_EVENT_LOG_FILE; absent means no logging. */
  eventLogFile?: string | null;
};

/** Who an event is from. The subset of sender config a payload is built out of. */
export type EventIdentity = {
  toolInstallationId: string;
  source: AscendaTelemetrySource;
  sessionId?: string | null;
  workspaceHash?: string | null;
  projectHash?: string | null;
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
 *
 * The `idempotencyKey` is minted here, at construction, for the same reason
 * `occurredAt` is: both are properties of the event, not of any one attempt
 * to deliver it. `post`/`attempt` below resend this same object, so a retry
 * carries the key the first attempt carried.
 */
export function buildEventPayload(identity: EventIdentity, mapped: MappedEvent): AscendaEventPayload {
  return {
    toolInstallationId: identity.toolInstallationId,
    source: identity.source,
    occurredAt: new Date().toISOString(),
    idempotencyKey: mintIdempotencyKey(),
    utcOffsetMinutes: utcOffsetMinutesAt(new Date()),
    sessionId: identity.sessionId ?? undefined,
    workspaceHash: identity.workspaceHash ?? undefined,
    projectHash: identity.projectHash ?? undefined,
    consentScope: ASCENDA_CONSENT_SCOPE,
    provenance: ASCENDA_PROVENANCE,
    privacyMode: "metadata_only",
    ...mapped,
    metadata: mapped.metadata ?? {}
  };
}

/**
 * Applied when a caller sets no `timeoutMs`. Previously the absence of one
 * meant no timeout at all: a hung connection stalled the hook until the host's
 * own hook timeout killed it, dropping the event with nothing written anywhere.
 * Telemetry is never worth making a user wait, so the cap is short and the
 * failure is recorded rather than raised.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/** One retry only, and a short pause — this runs between a user and their agent. */
const RETRY_DELAY_MS = 250;

/**
 * Shared one-shot event sender for agent hook adapters (Claude Code, Codex).
 * Sends metadata-only events with the standard consent scope and provenance,
 * renews the event write token once on auth failure, and persists rotations.
 */
export class AscendaEventSender {
  private eventWriteToken: string;
  private lastState: CollectorState | undefined;

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
      idempotencyKey: mintIdempotencyKey(),
      utcOffsetMinutes: utcOffsetMinutesAt(new Date()),
      severity: "low",
      sessionId: this.config.sessionId ?? undefined,
      workspaceHash: this.config.workspaceHash ?? undefined,
      projectHash: this.config.projectHash ?? undefined,
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
      idempotencyKey: mintIdempotencyKey(),
      utcOffsetMinutes: utcOffsetMinutesAt(new Date()),
      severity: "low",
      sessionId: this.config.sessionId ?? undefined,
      workspaceHash: this.config.workspaceHash ?? undefined,
      projectHash: this.config.projectHash ?? undefined,
      consentScope: ASCENDA_COLLABORATION_CONSENT_SCOPE,
      provenance: ASCENDA_PROVENANCE,
      privacyMode: "metadata_only",
      metadata: mapped.metadata ?? {}
    };
    return this.post(payload);
  }

  /**
   * The single choke point every event passes through, and therefore the only
   * honest place to journal one. Recording here rather than in each adapter is
   * deliberate: Claude Code, Codex, the GitHub collector and the MCP server all
   * send through this method, and the defect being fixed showed up in three
   * separate components because each was left to notice its own failures.
   */
  private async post(payload: AscendaEventPayload): Promise<IngestResult> {
    const outcome = await this.attempt(payload);
    this.lastState = recordSendOutcome(this.stateFilePath(), this.config.toolInstallationId, outcome.result, {
      httpStatus: outcome.httpStatus,
      errorCode: outcome.errorCode,
      detail: outcome.detail
    });
    // The two sinks answer different questions and both are written here: the
    // journal is an always-on summary of whether this collector is healthy, the
    // event log is an opt-in record of what individual events left the machine.
    this.log(payload, outcome.result);
    return outcome.result;
  }

  /**
   * Two recoveries, each tried once. A rejected token gets a renewal and one
   * replay — rotation is expected and should heal unattended. A transport
   * error gets one retry, because the common cases (a restarting instance, a
   * proxy blip, a 429) clear in well under a second and the alternative is
   * losing the event outright.
   *
   * Both recoveries resend the same `payload` object, so the `idempotencyKey`
   * minted at construction is what the server sees on every attempt. That is
   * what lets a retry of a request the server actually processed (a timeout
   * after the write, a 502 from a proxy in front of a 200) come back
   * `duplicate` instead of landing twice. Never rebuild the payload here.
   */
  private async attempt(payload: AscendaEventPayload): Promise<IngestOutcome> {
    const outcome = await postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload, this.signal());

    if (outcome.result === "auth_failed") {
      if (!(await this.renewEventToken())) return outcome;
      return postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload, this.signal());
    }

    // `httpStatus === undefined` is a network-level failure (DNS, reset,
    // timeout) — retryable for the same reason a 503 is.
    if (outcome.result === "transport_error" && (outcome.httpStatus === undefined || isRetryableStatus(outcome.httpStatus))) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload, this.signal());
    }

    return outcome;
  }

  /**
   * The state written by the most recent send, so a caller can decide whether
   * to surface a one-time notice without re-reading the journal it just wrote.
   */
  get state(): CollectorState | undefined {
    return this.lastState;
  }

  stateFilePath(): string {
    return this.config.stateFilePath ?? defaultStateFilePath(this.config.toolInstallationId);
  }

  /** Never throws: a renewal that errors is a failed renewal, not a failed turn. */
  /**
   * Every send path funnels through {@link post}, so semantic and
   * collaboration signals are logged on the same terms as host events — the
   * log would be misleading as an audit of what left the machine otherwise.
   *
   * An unreachable backend used to be logged as `other` from a catch block.
   * It is now `transport_error` through the ordinary path, because the
   * transport returns that outcome instead of throwing.
   */
  private log(payload: AscendaEventPayload, delivery: IngestResult): void {
    const logFile = this.config.eventLogFile === undefined ? resolveEventLogPath() : this.config.eventLogFile;
    if (!logFile) return;
    appendEventLog(logFile, { loggedAt: new Date().toISOString(), delivery, payload });
  }

  async renewEventToken(): Promise<boolean> {
    try {
      const renewed = await renewToolToken(this.config.apiBaseUrl, this.eventWriteToken, this.signal());
      if (!renewed) return false;
      this.eventWriteToken = renewed.eventWriteToken;
      persistEventWriteToken(this.config.tokenFilePath, renewed.eventWriteToken);
      return true;
    } catch {
      return false;
    }
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }
}
