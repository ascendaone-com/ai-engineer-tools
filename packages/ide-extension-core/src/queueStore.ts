import * as fs from "fs";
import * as path from "path";
import { AscendaEventPayload } from "@ascenda-one/tool-contract";

/**
 * The on-disk copy of the telemetry queue (issue #51).
 *
 * The queue in TelemetryService is in memory, and the common path stays
 * there: an event is tracked, batched, accepted, gone. This file exists for
 * the backlog that could not be delivered — written when a flush fails and the
 * batch is put back, when the final flush at shutdown fails, and when the
 * service is disposed with events still queued. Before it, each of those was
 * silent data loss: a reload or a crash while the backend was unreachable
 * threw away whatever had accumulated, and `stop()` ignored the result of its
 * own last flush.
 *
 * Payloads are persisted exactly as they sit in the queue. The
 * `idempotencyKey` minted in `track()` travels with each one, so a restored
 * backlog that overlaps something the previous session did deliver is
 * answered `duplicate` by the server rather than counted twice. That key is
 * what made this file safe to build.
 *
 * Bounded by count and by age (measured from `occurredAt`, which `track()`
 * stamps at the same moment the event enters the queue). Every eviction is
 * written into the file's own `discarded` record and reported through the
 * caller's log — a silent truncation would reproduce the original defect one
 * level down.
 *
 * Nothing here throws. The store is a safety net for telemetry; it must never
 * become the thing that breaks the editor.
 */

export const PERSISTED_QUEUE_VERSION = 1;
export const PERSISTED_QUEUE_FILE_NAME = "telemetry-queue.json";

/** Roughly a week of an ordinary day's events at the count cap, and a week of age regardless of count. */
export const DEFAULT_QUEUE_MAX_ENTRIES = 10_000;
export const DEFAULT_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type QueueDiscardReason = "age" | "count" | "unreadable";

export type QueueDiscard = {
  count: number;
  reasons: Partial<Record<QueueDiscardReason, number>>;
  /** The oldest `occurredAt` among the discarded, so a reader can see how far back the loss reaches. */
  oldestOccurredAt?: string;
};

/** Cumulative, so it survives the successful flushes that follow a loss. */
export type QueueDiscardRecord = {
  total: number;
  lastAt: string;
  lastCount: number;
  lastReasons: Partial<Record<QueueDiscardReason, number>>;
  lastOldestOccurredAt?: string;
};

export type QueueBounds = {
  maxEntries: number;
  maxAgeMs: number;
};

export type PersistedQueueFile = {
  version: typeof PERSISTED_QUEUE_VERSION;
  savedAt: string;
  discarded?: QueueDiscardRecord;
  events: AscendaEventPayload[];
};

/**
 * Where the file lives. Synchronous on purpose: `dispose()` is synchronous in
 * the editor's contract, and a persist that could not complete before the
 * extension host tears the process down would protect nothing.
 */
export interface QueueStorage {
  /** The file's text, or `undefined` when there is no file. */
  read(): string | undefined;
  write(text: string): void;
  remove(): void;
}

/** `<globalStorageUri>/telemetry-queue.json`, written atomically via rename. */
export class FileQueueStorage implements QueueStorage {
  constructor(private readonly filePath: string) {}

  read(): string | undefined {
    try {
      return fs.readFileSync(this.filePath, "utf8");
    } catch {
      return undefined;
    }
  }

  write(text: string): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    // Write-then-rename, so a crash mid-write leaves the previous complete
    // file rather than a torn one that the next activation would count as
    // unreadable and discard.
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  remove(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // Already gone; nothing to recover.
    }
  }
}

export function persistedQueueFilePath(globalStorageDir: string): string {
  return path.join(globalStorageDir, PERSISTED_QUEUE_FILE_NAME);
}

export type ReadPersistedQueue = {
  events: AscendaEventPayload[];
  discarded?: QueueDiscardRecord;
  /** Entries (or the whole file) that did not parse. The caller journals them as discarded. */
  unreadable: number;
};

/**
 * `undefined` when there is no file at all — distinct from a file with no
 * events, which still carries a discard record worth keeping.
 */
export function readPersistedQueue(storage: QueueStorage): ReadPersistedQueue | undefined {
  const text = storage.read();
  if (text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { events: [], unreadable: 1 };
  }
  if (!parsed || typeof parsed !== "object") return { events: [], unreadable: 1 };
  const file = parsed as Partial<PersistedQueueFile>;
  if (file.version !== PERSISTED_QUEUE_VERSION || !Array.isArray(file.events)) return { events: [], unreadable: 1 };

  const events: AscendaEventPayload[] = [];
  let unreadable = 0;
  for (const entry of file.events) {
    if (isPayload(entry)) events.push(entry);
    else unreadable += 1;
  }
  return { events, unreadable, ...(isDiscardRecord(file.discarded) ? { discarded: file.discarded } : {}) };
}

export function writePersistedQueue(storage: QueueStorage, events: AscendaEventPayload[], discarded: QueueDiscardRecord | undefined, now: Date = new Date()): void {
  const file: PersistedQueueFile = {
    version: PERSISTED_QUEUE_VERSION,
    savedAt: now.toISOString(),
    ...(discarded ? { discarded } : {}),
    events
  };
  storage.write(JSON.stringify(file));
}

/**
 * Applies the age and count bounds to a list in queue order (oldest first).
 * Count evicts from the front, since those are the entries the age bound
 * would take next anyway. Returns the surviving payload objects themselves,
 * not copies, so a caller can map the result back onto its own arrays by
 * identity.
 */
export function enforceQueueBounds(events: AscendaEventPayload[], bounds: QueueBounds, now: number = Date.now()): { kept: AscendaEventPayload[]; discarded: QueueDiscard } {
  const reasons: Partial<Record<QueueDiscardReason, number>> = {};
  let oldestOccurredAt: string | undefined;
  const cutoff = new Date(now - bounds.maxAgeMs).toISOString();
  const noteOldest = (occurredAt: string) => {
    if (oldestOccurredAt === undefined || occurredAt < oldestOccurredAt) oldestOccurredAt = occurredAt;
  };

  const fresh: AscendaEventPayload[] = [];
  for (const event of events) {
    if (event.occurredAt < cutoff) {
      reasons.age = (reasons.age ?? 0) + 1;
      noteOldest(event.occurredAt);
    } else {
      fresh.push(event);
    }
  }

  const excess = Math.max(0, fresh.length - Math.max(0, bounds.maxEntries));
  if (excess > 0) {
    reasons.count = excess;
    for (const event of fresh.slice(0, excess)) noteOldest(event.occurredAt);
  }
  const kept = excess > 0 ? fresh.slice(excess) : fresh;

  const count = Object.values(reasons).reduce((sum, n) => sum + (n ?? 0), 0);
  return { kept, discarded: { count, reasons, ...(oldestOccurredAt !== undefined ? { oldestOccurredAt } : {}) } };
}

export function accumulateDiscard(previous: QueueDiscardRecord | undefined, discard: QueueDiscard, now: Date = new Date()): QueueDiscardRecord {
  return {
    total: (previous?.total ?? 0) + discard.count,
    lastAt: now.toISOString(),
    lastCount: discard.count,
    lastReasons: discard.reasons,
    ...(discard.oldestOccurredAt !== undefined ? { lastOldestOccurredAt: discard.oldestOccurredAt } : {})
  };
}

/** One line for the output channel: what was lost, why, and the running total. */
export function describeDiscard(discard: QueueDiscard, record: QueueDiscardRecord): string {
  const reasons = Object.entries(discard.reasons)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([reason, n]) => `${reason}: ${n}`)
    .join(", ");
  const reach = discard.oldestOccurredAt ? `, oldest occurredAt ${discard.oldestOccurredAt}` : "";
  return `Discarded ${discard.count} queued telemetry event(s) (${reasons}${reach}); ${record.total} discarded in total since this queue was created.`;
}

function isPayload(value: unknown): value is AscendaEventPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AscendaEventPayload>;
  return typeof candidate.toolInstallationId === "string" && typeof candidate.eventType === "string" && typeof candidate.occurredAt === "string";
}

function isDiscardRecord(value: unknown): value is QueueDiscardRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QueueDiscardRecord>;
  return typeof candidate.total === "number" && typeof candidate.lastAt === "string" && typeof candidate.lastCount === "number";
}
