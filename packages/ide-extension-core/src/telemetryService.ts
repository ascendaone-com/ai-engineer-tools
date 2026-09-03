import * as crypto from "crypto";
import * as vscode from "vscode";
import { AscendaApi, IngestResult } from "./ascendaApi";
import { AscendaConfig } from "./config";
import { getHostDisplayName, getToolType, resolveTelemetrySource } from "./host";
import { liveEventFor } from "./liveSignals";
import { PairingService } from "./pairingService";
import {
  QueueBounds,
  QueueDiscard,
  QueueDiscardRecord,
  QueueStorage,
  ReadPersistedQueue,
  accumulateDiscard,
  describeDiscard,
  enforceQueueBounds,
  readPersistedQueue,
  writePersistedQueue
} from "./queueStore";
import {
  ASCENDA_CONSENT_SCOPE,
  ASCENDA_PROVENANCE,
  AscendaEventMetadata,
  AscendaEventPayload,
  AscendaSeverity,
  AscendaTelemetryEventType
} from "@ascenda-one/tool-contract";
import { emitLiveSignal, isAfterHours, mintIdempotencyKey } from "@ascenda-one/tool-kit";
import { getProjectHash, getWorkspaceHash } from "./privacy";

export type TelemetryServiceOptions = {
  /** Disk copy of the undelivered backlog. Absent means the queue is memory-only, as it was before #51. */
  store?: QueueStorage;
  /** Where a discard or a persistence failure is written so a person can find it. Defaults to the console. */
  log?: (line: string) => void;
  /**
   * Whether a backlog restored from disk may be sent, as opposed to kept and
   * bounded. Defaults to the `ascenda.telemetry.drainPersistedQueue` setting,
   * which defaults to off: a drain against an ingest door that does not yet
   * dedupe on `idempotencyKey` would land every restored event a second time,
   * and that double-count is the reason this queue could not be built until
   * the key existed. Turn it on once the deployed backend is confirmed to
   * answer a replay with `duplicate`.
   */
  drainPersistedQueue?: boolean;
  maxQueueEntries?: number;
  maxQueueAgeMs?: number;
};

export class TelemetryService implements vscode.Disposable {
  private readonly queue: AscendaEventPayload[] = [];
  /**
   * Restored from disk while draining is switched off. Never sent, never
   * dropped except by the bounds; written back on every persist so it is
   * still there for the activation that is allowed to send it.
   */
  private held: AscendaEventPayload[] = [];
  /** The batch currently on the wire. Persisted too: a dispose mid-send must not lose it. */
  private inFlight: AscendaEventPayload[] = [];
  private discarded: QueueDiscardRecord | undefined;
  /** Whether the disk copy currently holds queue events, so a confirmed delivery knows to clear it. */
  private diskHoldsQueue = false;
  /** Whether a file exists at all, as far as this process knows. Saves an unlink on every quiet dispose. */
  private onDisk = false;
  private readonly sessionId = `sess_${crypto.randomUUID()}`;
  private readonly disposables: vscode.Disposable[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private flushing = false;
  private consentWarningShown = false;

  constructor(
    private readonly api: AscendaApi,
    private readonly pairingService: PairingService,
    private readonly options: TelemetryServiceOptions = {}
  ) {}

  start(): void {
    const intervalMs = Math.max(5, AscendaConfig.flushIntervalSeconds) * 1000;
    this.flushTimer = setInterval(() => void this.flush(), intervalMs);
    void this.restore();
    this.track("create_focus_session", "low", { activity: "session_started" });
  }

  /**
   * The final flush is the one most likely to fail — the host is going away,
   * often because the machine is — and before #51 its result was ignored.
   * Whatever it could not deliver is persisted before returning, so a failed
   * final flush is a delay, not a loss: the restored drain re-sends it, and
   * the `idempotencyKey` on each payload keeps anything that did get through
   * from counting twice.
   */
  async stop(): Promise<void> {
    this.track("recovery_offline_period", "low", { activity: "session_ended" });
    await this.flush();
    this.persist();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /** The editor may dispose without ever calling stop(). Synchronous by contract, so the persist is too. */
  dispose(): void {
    this.persist();
    if (this.flushTimer) clearInterval(this.flushTimer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  /**
   * Loads what a previous session left on disk. Runs the bounds first, and
   * journals what they evict. Then either queues the survivors for the normal
   * flush — the same code path, the same eviction on `accepted` or `duplicate`
   * — or, while draining is switched off, holds them: still on disk, still
   * bounded, never sent.
   */
  restore(): Promise<void> {
    const store = this.options.store;
    if (!store) return Promise.resolve();

    let read: ReadPersistedQueue | undefined;
    try {
      read = readPersistedQueue(store);
    } catch (error) {
      this.log(`Could not read the persisted telemetry queue: ${describeError(error)}`);
      return Promise.resolve();
    }
    if (!read) return Promise.resolve();
    this.onDisk = true;
    this.discarded = read.discarded;

    const { kept, discarded } = enforceQueueBounds(read.events, this.bounds());
    if (read.unreadable > 0) {
      discarded.count += read.unreadable;
      discarded.reasons.unreadable = read.unreadable;
    }
    if (discarded.count > 0) this.recordDiscard(discarded);

    if (kept.length > 0) {
      if (this.drainEnabled()) {
        this.queue.unshift(...kept);
        this.diskHoldsQueue = true;
        this.log(`Restored ${kept.length} undelivered telemetry event(s) from the previous session; sending on the next flush.`);
      } else {
        this.held = kept;
        this.log(`Holding ${kept.length} undelivered telemetry event(s) from a previous session on disk. Enable ascenda.telemetry.drainPersistedQueue to send them.`);
      }
    }
    // Rewrite so the file reflects the bounds and carries the discard record;
    // when nothing survived and nothing was discarded this removes it.
    this.persist();
    return this.queue.length > 0 && this.drainEnabled() ? this.flush() : Promise.resolve();
  }

  track(eventType: AscendaTelemetryEventType, severity: AscendaSeverity = "low", metadata: AscendaEventMetadata = {}): void {
    if (!AscendaConfig.telemetryEnabled) return;

    // The desktop waterline, before the pairing guard below. It is a local
    // display cue over a socket on this machine, so it owes nothing to a
    // backend pairing — gating it there would leave the gauges dark for
    // people still setting Ascenda up. It stays under `telemetryEnabled`,
    // though: that switch is the user saying "stop reading my work", and it
    // means this too.
    const liveEvent = liveEventFor(eventType);
    if (liveEvent) {
      void emitLiveSignal({ tool: getToolType(), session: this.sessionId, event: liveEvent });
    }

    const toolInstallationId = this.pairingService.getToolInstallationId();
    if (!toolInstallationId) return;
    const afterHours = isAfterHours(new Date(), AscendaConfig.afterHoursStart, AscendaConfig.afterHoursEnd);
    const payload = this.buildPayload(toolInstallationId, eventType, severity, { ...metadata, afterHours });
    this.queue.push(payload);
    if (afterHours && eventType !== "after_hours_ai_session") {
      this.queue.push(this.buildPayload(toolInstallationId, "after_hours_ai_session", severity === "low" ? "medium" : severity, {
        reason: "after_hours",
        relatedEventType: eventType,
        afterHours: true
      }));
    }
    if (this.queue.length >= 10) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    if (!this.pairingService.isPaired()) return;
    let token = await this.pairingService.ensureEventWriteToken();
    if (!token) return;

    this.flushing = true;
    let drained = false;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, Math.min(10, this.queue.length));
        this.inFlight = batch;
        let result: IngestResult;
        try {
          result = batch.length === 1
            ? await this.api.sendEvent(batch[0], token)
            : await this.api.sendEventsBatch(batch, token);

          if (result === "auth_failed") {
            token = await this.pairingService.handleAuthFailure();
            if (!token) {
              this.requeue(batch);
              break;
            }
            result = batch.length === 1
              ? await this.api.sendEvent(batch[0], token)
              : await this.api.sendEventsBatch(batch, token);
          }
        } catch (error) {
          // 5xx and network failures throw rather than returning an IngestResult;
          // keep the batch for the next flush instead of dropping it.
          this.requeue(batch);
          throw error;
        }

        if (result === "consent_missing") {
          this.requeue(batch);
          if (!this.consentWarningShown) {
            this.consentWarningShown = true;
            vscode.window.showWarningMessage("Ascenda telemetry paused. Renew IDE telemetry consent in the Ascenda app.");
          }
          break;
        }

        // `accepted` covers a server-side `duplicate` too — the transport
        // collapses them, see AscendaApi. Every requeue above and below puts
        // the SAME payload objects back, so a re-sent batch carries the
        // idempotencyKeys minted in track(); that is what makes a retry of
        // something the server already has answer `duplicate` rather than
        // count twice.
        if (result !== "accepted") {
          this.requeue(batch);
          console.error("Ascenda telemetry ingest failed", result);
          break;
        }
        this.inFlight = [];
      }
      drained = this.queue.length === 0;
    } catch (error) {
      console.error("Ascenda telemetry flush failed", error);
    } finally {
      this.inFlight = [];
      this.flushing = false;
    }
    // Only a confirmed delivery clears the disk copy. Until then the file may
    // hold events the server already has; a replay of those is answered
    // `duplicate`, which is harmless, whereas clearing early is a loss.
    if (drained && this.diskHoldsQueue) this.persist();
  }

  /**
   * Every failure path in flush() lands here: the same objects go back to the
   * front of the queue, and the backlog goes to disk. Writing on failure
   * rather than on every event keeps the common path in memory and puts only
   * the at-risk backlog on disk.
   */
  private requeue(batch: AscendaEventPayload[]): void {
    this.queue.unshift(...batch);
    this.inFlight = [];
    this.persist();
  }

  /**
   * Writes the whole undelivered backlog — held, in flight, queued — after
   * applying the bounds to it. With nothing to keep and nothing to report,
   * removes the file. Never throws: a full disk or a read-only profile is
   * logged, and the in-memory queue carries on as before #51.
   */
  private persist(): void {
    const store = this.options.store;
    if (!store) return;

    const all = [...this.held, ...this.inFlight, ...this.queue];
    const { kept, discarded } = enforceQueueBounds(all, this.bounds());
    if (discarded.count > 0) {
      const keep = new Set(kept);
      this.held = this.held.filter((event) => keep.has(event));
      this.inFlight = this.inFlight.filter((event) => keep.has(event));
      this.queue.splice(0, this.queue.length, ...this.queue.filter((event) => keep.has(event)));
      this.recordDiscard(discarded);
    }

    try {
      if (kept.length === 0 && !this.discarded) {
        if (this.onDisk) store.remove();
        this.onDisk = false;
      } else {
        writePersistedQueue(store, kept, this.discarded);
        this.onDisk = true;
      }
      this.diskHoldsQueue = this.inFlight.length + this.queue.length > 0;
    } catch (error) {
      this.log(`Could not persist ${kept.length} undelivered telemetry event(s): ${describeError(error)}`);
    }
  }

  private recordDiscard(discard: QueueDiscard): void {
    this.discarded = accumulateDiscard(this.discarded, discard);
    this.log(describeDiscard(discard, this.discarded));
  }

  private bounds(): QueueBounds {
    return {
      maxEntries: this.options.maxQueueEntries ?? AscendaConfig.queueMaxEntries,
      maxAgeMs: this.options.maxQueueAgeMs ?? AscendaConfig.queueMaxAgeMs
    };
  }

  private drainEnabled(): boolean {
    return this.options.drainPersistedQueue ?? AscendaConfig.drainPersistedQueue;
  }

  private log(line: string): void {
    if (this.options.log) this.options.log(line);
    else console.warn(`Ascenda telemetry: ${line}`);
  }

  /**
   * Called from track(), which is the moment an event enters `queue` — and
   * therefore the only correct place to mint its `idempotencyKey`. Minting in
   * flush() would stamp a fresh key on every attempt: each failure path there
   * unshifts the same object back, so a flush-time key would change on every
   * retry and dedupe nothing. Minted here, the key travels with the object
   * through every re-queue, onto disk, and across a reload unchanged.
   */
  private buildPayload(
    toolInstallationId: string,
    eventType: AscendaTelemetryEventType,
    severity: AscendaSeverity,
    metadata: AscendaEventMetadata
  ): AscendaEventPayload {
    return {
      toolInstallationId,
      source: resolveTelemetrySource(toolInstallationId),
      eventType,
      occurredAt: new Date().toISOString(),
      idempotencyKey: mintIdempotencyKey(),
      severity,
      sessionId: this.sessionId,
      workspaceHash: getWorkspaceHash(),
      projectHash: getProjectHash(),
      consentScope: ASCENDA_CONSENT_SCOPE,
      provenance: ASCENDA_PROVENANCE,
      privacyMode: "metadata_only",
      // Forks share the vscode_extension source, so without this an
      // agent-first IDE is indistinguishable from stock VS Code in the data.
      // Caller-supplied metadata wins: it is the more specific claim.
      metadata: { host: getHostDisplayName(), ...metadata }
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
