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
  SEMANTIC_WORK_SIGNAL_EVENT_TYPES,
  TOOL_EVENT_DELIVERED_STATUSES
} from "@ascenda-one/tool-contract";
import { EventLogEntry, appendEventLog, resolveEventLogPath } from "./eventLog";
import { IngestOutcome, isRetryableStatus, postToolEvent, postToolEventsBatch, renewToolToken } from "./http";
import {
  DEFAULT_OUTBOX_DRAIN_BATCH_SIZE,
  DEFAULT_OUTBOX_MAX_AGE_MS,
  DEFAULT_OUTBOX_MAX_ENTRIES,
  OutboxDiscard,
  OutboxEntry,
  appendToOutbox,
  claimOutbox,
  defaultOutboxFilePath,
  enforceOutboxBounds,
  outboxDrainEnabled
} from "./outbox";
import { persistEventWriteToken } from "./tokenStore";
import { CollectorState, OutboxDiscardReason, defaultStateFilePath, recordOutboxDiscard, recordSendOutcome } from "./stateStore";
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
  /** Durable outbox location. Defaults to ~/.ascenda/state/<installationId>.outbox.jsonl. */
  outboxFilePath?: string;
  /**
   * Whether the outbox may be *sent*, as opposed to kept and bounded. Defaults
   * to `ASCENDA_OUTBOX_DRAIN`, which defaults to off: a drain against an
   * ingest door that does not yet dedupe on `idempotencyKey` would land every
   * queued event a second time, and that double-count is the reason this
   * queue could not be built until the key existed. Turn it on once the
   * deployed backend is confirmed to answer a replay with `duplicate`.
   */
  outboxDrain?: boolean;
  outboxMaxEntries?: number;
  outboxMaxAgeMs?: number;
  outboxDrainBatchSize?: number;
};

/** Who an event is from. The subset of sender config a payload is built out of. */
export type EventIdentity = {
  toolInstallationId: string;
  source: AscendaTelemetrySource;
  sessionId?: string | null;
  workspaceHash?: string | null;
  projectHash?: string | null;
};

/** What one outbox pass did, for a caller that wants to say so. */
export type OutboxDrainReport = {
  /** Entries on disk when the pass began, claim files included. */
  found: number;
  /** Evicted by a bound, unreadable, or refused with a verdict — and journaled. */
  discarded: number;
  /** Confirmed on the server this pass: `accepted` plus `duplicate`. */
  delivered: number;
  /** Left for the next hook invocation. */
  remaining: number;
  /** Set when the pass stopped on a failure and the live send was skipped because of it. */
  halted?: IngestResult;
  /** False when `ASCENDA_OUTBOX_DRAIN` (or `outboxDrain`) kept the pass from sending. */
  sendEnabled: boolean;
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
  private lastDrain: OutboxDrainReport | undefined;
  /** One outbox pass per sender, i.e. per hook process. The hook is on the user's critical path. */
  private outboxServiced = false;

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
   *
   * The outbox is serviced first, once per process. If that pass just watched
   * the ingest door refuse a batch, the live event is not offered to the same
   * door a second time in the same instant: it inherits the pass's outcome,
   * and a retryable one puts it straight in the queue. That is what keeps a
   * hook during an outage to one bounded round trip instead of three.
   */
  private async post(payload: AscendaEventPayload): Promise<IngestResult> {
    const halted = await this.serviceOutbox();

    let outcome: IngestOutcome;
    let queued = false;
    if (halted) {
      outcome = halted;
      queued = this.isRetryable(outcome) && this.enqueue(payload);
    } else {
      outcome = await this.attempt(payload);
      queued = this.isRetryable(outcome) && this.enqueue(payload);
    }

    this.lastState = recordSendOutcome(this.stateFilePath(), this.config.toolInstallationId, outcome.result, {
      httpStatus: outcome.httpStatus,
      errorCode: outcome.errorCode,
      detail: queued ? withNote(outcome.detail, "queued in outbox") : outcome.detail
    });
    // The two sinks answer different questions and both are written here: the
    // journal is an always-on summary of whether this collector is healthy, the
    // event log is an opt-in record of what individual events left the machine.
    this.log(payload, outcome.result, queued ? "queued" : undefined);
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
   *
   * When the retry fails too, the caller queues the payload: anything longer
   * than the pause here is the outbox's job, not another in-process wait.
   */
  private async attempt(payload: AscendaEventPayload): Promise<IngestOutcome> {
    const outcome = await postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload, this.signal());

    if (outcome.result === "auth_failed") {
      if (!(await this.renewEventToken())) return outcome;
      return postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload, this.signal());
    }

    // `httpStatus === undefined` is a network-level failure (DNS, reset,
    // timeout) — retryable for the same reason a 503 is.
    if (this.isRetryable(outcome)) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload, this.signal());
    }

    return outcome;
  }

  /** A failure that never reached a verdict. Replaying can change the answer. */
  private isRetryable(outcome: IngestOutcome): boolean {
    return outcome.result === "transport_error" && (outcome.httpStatus === undefined || isRetryableStatus(outcome.httpStatus));
  }

  /**
   * Keeps a refused payload for a later drain. Returns whether it is now on
   * disk; when it is not (read-only home, full disk) the event is lost and the
   * journal's detail says so instead of implying it was kept.
   */
  private enqueue(payload: AscendaEventPayload): boolean {
    return appendToOutbox(this.outboxFilePath(), payload);
  }

  /**
   * One pass over the outbox: claim it, apply the bounds, and — when sending
   * is enabled — offer one batch, oldest first, to the batch door.
   *
   * Entries are deleted on `accepted` or `duplicate`, decided on `status`
   * alone; `reason` is for a person reading their logs. A per-item `rejected`
   * is a verdict, and replaying a verdict cannot change it, so those are
   * discarded and journaled rather than kept forever. A whole-batch
   * `validation_failed` is the same verdict for every item. Anything else
   * stops the pass with everything still on disk, and is returned so the live
   * send can skip a door that just refused.
   *
   * Never loops, never backs off, never sends more than one batch: the next
   * hook invocation is usually seconds away, and a hook sitting in a retry
   * loop delays the tool call the user is waiting on.
   */
  private async serviceOutbox(): Promise<IngestOutcome | undefined> {
    if (this.outboxServiced) return undefined;
    this.outboxServiced = true;

    const sendEnabled = this.config.outboxDrain ?? outboxDrainEnabled();
    const claimed = claimOutbox(this.outboxFilePath());
    if (!claimed) {
      this.lastDrain = { found: 0, discarded: 0, delivered: 0, remaining: 0, sendEnabled };
      return undefined;
    }

    const found = claimed.entries.length + claimed.unreadable;
    const { kept, discarded } = enforceOutboxBounds(claimed.entries, {
      maxEntries: this.config.outboxMaxEntries ?? DEFAULT_OUTBOX_MAX_ENTRIES,
      maxAgeMs: this.config.outboxMaxAgeMs ?? DEFAULT_OUTBOX_MAX_AGE_MS
    });
    if (claimed.unreadable > 0) {
      discarded.count += claimed.unreadable;
      discarded.reasons.unreadable = claimed.unreadable;
    }
    let discardedTotal = this.journalDiscard(discarded);

    if (!sendEnabled || kept.length === 0) {
      claimed.release(kept);
      this.lastDrain = { found, discarded: discardedTotal, delivered: 0, remaining: kept.length, sendEnabled };
      return undefined;
    }

    const batchSize = this.config.outboxDrainBatchSize ?? DEFAULT_OUTBOX_DRAIN_BATCH_SIZE;
    const batch = kept.slice(0, batchSize);
    const rest = kept.slice(batchSize);
    const outcome = await this.attemptBatch(batch.map((entry) => entry.payload));

    let delivered: OutboxEntry[] = [];
    let rejected: OutboxEntry[] = [];
    let undecided: OutboxEntry[] = [];
    let halted: IngestOutcome | undefined;

    if (outcome.result === "accepted") {
      if (outcome.results === undefined) {
        // A 2xx with no per-item verdicts: the door accepted the request as
        // a whole, which is the single-door shape and the only reading under
        // which nothing is silently lost.
        delivered = batch;
      } else {
        const byIndex = new Map(outcome.results.map((item) => [item.index, item.status] as const));
        for (const [index, entry] of batch.entries()) {
          const status = byIndex.get(index);
          if (status !== undefined && (TOOL_EVENT_DELIVERED_STATUSES as readonly string[]).includes(status)) delivered.push(entry);
          else if (status === "rejected") rejected.push(entry);
          else undecided.push(entry);
        }
      }
    } else if (outcome.result === "validation_failed") {
      rejected = batch;
    } else {
      undecided = batch;
      halted = outcome;
    }

    if (rejected.length > 0) {
      discardedTotal += this.journalDiscard({ count: rejected.length, reasons: { rejected: rejected.length }, oldestQueuedAt: rejected[0]?.queuedAt });
    }
    if (!halted) {
      // A completed pass is a real send attempt and is journaled as one; a
      // halted pass leaves that to the live send, which inherits its outcome,
      // so an outage costs one failure per hook rather than two.
      this.lastState = recordSendOutcome(this.stateFilePath(), this.config.toolInstallationId, outcome.result, {
        httpStatus: outcome.httpStatus,
        errorCode: outcome.errorCode,
        detail: withNote(outcome.detail, `outbox drain: ${delivered.length} delivered`)
      });
    }
    for (const entry of delivered) this.log(entry.payload, "accepted", "drained");

    const remainder = [...undecided, ...rest];
    claimed.release(remainder);
    this.lastDrain = {
      found,
      discarded: discardedTotal,
      delivered: delivered.length,
      remaining: remainder.length,
      sendEnabled,
      ...(halted ? { halted: halted.result } : {})
    };
    return halted;
  }

  /** The batch door, with the same single token renewal as the live path and no in-process retry. */
  private async attemptBatch(payloads: AscendaEventPayload[]): Promise<IngestOutcome> {
    const outcome = await postToolEventsBatch(this.config.apiBaseUrl, this.eventWriteToken, payloads, this.signal());
    if (outcome.result !== "auth_failed") return outcome;
    if (!(await this.renewEventToken())) return outcome;
    return postToolEventsBatch(this.config.apiBaseUrl, this.eventWriteToken, payloads, this.signal());
  }

  private journalDiscard(discard: OutboxDiscard): number {
    if (discard.count === 0) return 0;
    const reasons: Partial<Record<OutboxDiscardReason, number>> = discard.reasons;
    this.lastState = recordOutboxDiscard(this.stateFilePath(), this.config.toolInstallationId, {
      count: discard.count,
      reasons,
      oldestQueuedAt: discard.oldestQueuedAt
    });
    return discard.count;
  }

  /**
   * The state written by the most recent send, so a caller can decide whether
   * to surface a one-time notice without re-reading the journal it just wrote.
   */
  get state(): CollectorState | undefined {
    return this.lastState;
  }

  /** What this sender's one outbox pass did; undefined before the first send. */
  get drain(): OutboxDrainReport | undefined {
    return this.lastDrain;
  }

  stateFilePath(): string {
    return this.config.stateFilePath ?? defaultStateFilePath(this.config.toolInstallationId);
  }

  outboxFilePath(): string {
    return this.config.outboxFilePath ?? defaultOutboxFilePath(this.config.toolInstallationId);
  }

  /**
   * Every send path funnels through {@link post}, so semantic and
   * collaboration signals are logged on the same terms as host events — the
   * log would be misleading as an audit of what left the machine otherwise.
   *
   * An unreachable backend used to be logged as `other` from a catch block.
   * It is now `transport_error` through the ordinary path, because the
   * transport returns that outcome instead of throwing.
   */
  private log(payload: AscendaEventPayload, delivery: IngestResult, outbox?: EventLogEntry["outbox"]): void {
    const logFile = this.config.eventLogFile === undefined ? resolveEventLogPath() : this.config.eventLogFile;
    if (!logFile) return;
    appendEventLog(logFile, { loggedAt: new Date().toISOString(), delivery, payload, ...(outbox ? { outbox } : {}) });
  }

  /** Never throws: a renewal that errors is a failed renewal, not a failed turn. */
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

function withNote(detail: string | undefined, note: string): string {
  return detail ? `${detail} (${note})` : note;
}
