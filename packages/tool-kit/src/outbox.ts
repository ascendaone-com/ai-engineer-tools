import * as fs from "fs";
import * as path from "path";
import { AscendaEventPayload } from "@ascenda-one/tool-contract";
import { OutboxDiscardReason, defaultStateFilePath } from "./stateStore";
import { sanitizeFilePart } from "./tokenStore";

/**
 * The durable outbox: where an event goes when the live send has exhausted its
 * one retry on a failure that never reached a verdict.
 *
 * Before this file, the collector's delivery policy tolerated 250 ms of
 * unavailability. A laptop waking from sleep, a VPN reconnecting, a restarting
 * instance — anything longer and the event went out of scope with no copy on
 * disk. The journal recorded that *something* failed; nothing held *what*.
 *
 * Shape: one JSON object per line, appended with O_APPEND so overlapping hook
 * processes (Claude Code fires PreToolUse and PostToolUse from separate
 * processes) cannot corrupt each other's lines. Separate from the opt-in event
 * log on purpose — that file answers "what left this machine", this one
 * answers "what still has to", and it is always on.
 *
 * Draining is claim-by-rename. The drainer renames the outbox out from under
 * concurrent appenders (atomic, so exactly one process wins and the others
 * keep appending to a fresh file), works on its private copy, and appends
 * whatever it could not deliver back. Nothing is ever deleted before the
 * server has confirmed it; a crash between the two leaves a claim file that
 * the next drain sweeps back in. Replaying a batch the server already holds is
 * safe because every payload carries the `idempotencyKey` minted when it was
 * built, and a replay answers `duplicate`.
 *
 * Nothing here throws. A queue that could take down a user's turn would be a
 * worse bug than the one it holds.
 */

/** Set to `1`/`true` to let the drain send. Off by default until the ingest doors are confirmed to dedupe live events. */
export const OUTBOX_DRAIN_ENV_VAR = "ASCENDA_OUTBOX_DRAIN";

/**
 * Bounds. Roughly a week of an ordinary day's events at the count cap, and a
 * week of age regardless of count. Both are enforced on every hook invocation
 * whether or not the drain is allowed to send, and every eviction is journaled
 * — a silent truncation would reproduce the original defect one level down.
 */
export const DEFAULT_OUTBOX_MAX_ENTRIES = 10_000;
export const DEFAULT_OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One batch per hook invocation. The hook is on the user's critical path. */
export const DEFAULT_OUTBOX_DRAIN_BATCH_SIZE = 100;

/** A claim file older than this belongs to a drainer that died mid-way. */
const ORPHANED_CLAIM_AGE_MS = 60_000;

const CLAIM_SUFFIX = ".draining";

export type OutboxEntry = {
  /** When the live send gave up on it — the age bound is measured from here. */
  queuedAt: string;
  payload: AscendaEventPayload;
};

export type OutboxBounds = {
  maxEntries: number;
  maxAgeMs: number;
};

export type OutboxDiscard = {
  count: number;
  reasons: Partial<Record<OutboxDiscardReason, number>>;
  /** The oldest `queuedAt` among the discarded, so a reader can see how far back the loss reaches. */
  oldestQueuedAt?: string;
};

export function outboxDrainEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[OUTBOX_DRAIN_ENV_VAR]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** Sibling of the journal: `<state dir>/<toolInstallationId>.outbox.jsonl`. */
export function defaultOutboxFilePath(toolInstallationId: string): string {
  const dir = path.dirname(defaultStateFilePath(toolInstallationId));
  return path.join(dir, `${sanitizeFilePart(toolInstallationId)}.outbox.jsonl`);
}

/**
 * Appends one event. Returns false when the write failed (read-only home,
 * full disk) so the caller can journal that the event was lost rather than
 * queued — the one case this file cannot make durable.
 */
export function appendToOutbox(outboxFilePath: string, payload: AscendaEventPayload, now: Date = new Date()): boolean {
  try {
    const dir = path.dirname(outboxFilePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry: OutboxEntry = { queuedAt: now.toISOString(), payload };
    // A single write() with O_APPEND. A metadata-only line is a few hundred
    // bytes, far under PIPE_BUF, so concurrent hook processes interleave
    // whole lines and never fragments of them.
    fs.appendFileSync(outboxFilePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(outboxFilePath, 0o600);
    return true;
  } catch {
    return false;
  }
}

export type OutboxSummary = {
  /** Entries waiting, including any sitting in a claim file. */
  depth: number;
  oldestQueuedAt?: string;
  /** Lines that did not parse. Non-zero means a write was torn or the file was edited. */
  unreadableLines: number;
};

/**
 * A read-only look for `doctor`: depth and the oldest entry's age. Takes no
 * claim, so it can run while a hook is draining. `undefined` when there is
 * nothing on disk at all — distinct from an empty outbox, which is a file that
 * has been drained.
 */
export function readOutboxSummary(outboxFilePath: string): OutboxSummary | undefined {
  const files = [outboxFilePath, ...listClaimFiles(outboxFilePath)].filter((file) => fs.existsSync(file));
  if (files.length === 0) return undefined;

  let depth = 0;
  let unreadableLines = 0;
  let oldestQueuedAt: string | undefined;
  for (const file of files) {
    const { entries, unreadable } = readEntries(file);
    depth += entries.length;
    unreadableLines += unreadable;
    for (const entry of entries) {
      if (oldestQueuedAt === undefined || entry.queuedAt < oldestQueuedAt) oldestQueuedAt = entry.queuedAt;
    }
  }
  return { depth, unreadableLines, ...(oldestQueuedAt !== undefined ? { oldestQueuedAt } : {}) };
}

export type ClaimedOutbox = {
  /** Oldest first. */
  entries: OutboxEntry[];
  /** Lines that did not parse; the caller journals them as discarded. */
  unreadable: number;
  /**
   * Puts back what was not delivered and removes the claim. Must be called
   * exactly once. If the put-back write fails the claim file is left in place
   * so the next drain recovers it — the entries are never lost to a failed
   * release.
   */
  release(remainder: OutboxEntry[]): void;
};

/**
 * Takes exclusive ownership of everything queued right now, or returns
 * `undefined` when there is nothing to take or another process already has it.
 *
 * The rename is the lock: `rename(2)` is atomic, so of two hooks that reach
 * this line together exactly one gets the file, and appenders that arrive
 * afterwards create a fresh outbox that the *next* drain will find. Claim
 * files left by a drainer that died are swept into this claim once they are
 * old enough that their owner cannot still be running.
 */
export function claimOutbox(outboxFilePath: string, now: number = Date.now()): ClaimedOutbox | undefined {
  const claimPath = `${outboxFilePath}.${process.pid}${CLAIM_SUFFIX}`;
  const claimed: string[] = [];

  try {
    fs.renameSync(outboxFilePath, claimPath);
    claimed.push(claimPath);
  } catch {
    // Missing (nothing queued) or already claimed by a concurrent drainer.
  }

  // Orphans are claimed by rename too, so two sweepers cannot both read one.
  let orphanIndex = 0;
  for (const orphan of listClaimFiles(outboxFilePath)) {
    if (claimed.includes(orphan)) continue;
    try {
      if (now - fs.statSync(orphan).mtimeMs < ORPHANED_CLAIM_AGE_MS) continue;
      const mine = `${claimPath}.${orphanIndex++}`;
      fs.renameSync(orphan, mine);
      claimed.push(mine);
    } catch {
      // Gone, or another sweeper got there first.
    }
  }

  if (claimed.length === 0) return undefined;

  const entries: OutboxEntry[] = [];
  let unreadable = 0;
  for (const file of claimed) {
    const read = readEntries(file);
    entries.push(...read.entries);
    unreadable += read.unreadable;
  }
  entries.sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0));

  let released = false;
  return {
    entries,
    unreadable,
    release(remainder: OutboxEntry[]): void {
      if (released) return;
      released = true;
      if (remainder.length > 0) {
        try {
          fs.mkdirSync(path.dirname(outboxFilePath), { recursive: true, mode: 0o700 });
          // One write, so a concurrent appender's line lands before or after
          // the whole remainder, never inside it. Order within the file is not
          // load-bearing: the drain sorts by `queuedAt`, and the age bound
          // reads it per entry.
          fs.appendFileSync(outboxFilePath, remainder.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { encoding: "utf8", mode: 0o600 });
          if (process.platform !== "win32") fs.chmodSync(outboxFilePath, 0o600);
        } catch {
          // Leave the claim files: they are the only copy, and the next drain
          // will treat them as orphans and try again.
          return;
        }
      }
      for (const file of claimed) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Already gone; nothing to recover.
        }
      }
    }
  };
}

/**
 * Applies the age and count bounds to a sorted (oldest first) list. Count
 * evicts the oldest, since those are the entries the age bound would take
 * next anyway. The caller journals the discard; this only computes it.
 */
export function enforceOutboxBounds(entries: OutboxEntry[], bounds: OutboxBounds, now: number = Date.now()): { kept: OutboxEntry[]; discarded: OutboxDiscard } {
  const reasons: Partial<Record<OutboxDiscardReason, number>> = {};
  let oldestQueuedAt: string | undefined;
  const cutoff = new Date(now - bounds.maxAgeMs).toISOString();

  const fresh: OutboxEntry[] = [];
  for (const entry of entries) {
    if (entry.queuedAt < cutoff) {
      reasons.age = (reasons.age ?? 0) + 1;
      if (oldestQueuedAt === undefined || entry.queuedAt < oldestQueuedAt) oldestQueuedAt = entry.queuedAt;
    } else {
      fresh.push(entry);
    }
  }

  const excess = Math.max(0, fresh.length - bounds.maxEntries);
  if (excess > 0) {
    reasons.count = excess;
    const first = fresh[0]?.queuedAt;
    if (first !== undefined && (oldestQueuedAt === undefined || first < oldestQueuedAt)) oldestQueuedAt = first;
  }
  const kept = excess > 0 ? fresh.slice(excess) : fresh;

  const count = Object.values(reasons).reduce((sum, n) => sum + (n ?? 0), 0);
  return { kept, discarded: { count, reasons, ...(oldestQueuedAt !== undefined ? { oldestQueuedAt } : {}) } };
}

function listClaimFiles(outboxFilePath: string): string[] {
  const dir = path.dirname(outboxFilePath);
  const prefix = `${path.basename(outboxFilePath)}.`;
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.includes(CLAIM_SUFFIX))
      .map((name) => path.join(dir, name))
      .sort();
  } catch {
    return [];
  }
}

function readEntries(file: string): { entries: OutboxEntry[]; unreadable: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { entries: [], unreadable: 0 };
  }
  const entries: OutboxEntry[] = [];
  let unreadable = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<OutboxEntry>;
      if (!parsed || typeof parsed !== "object" || typeof parsed.queuedAt !== "string" || !parsed.payload || typeof parsed.payload !== "object") {
        unreadable += 1;
        continue;
      }
      entries.push({ queuedAt: parsed.queuedAt, payload: parsed.payload });
    } catch {
      unreadable += 1;
    }
  }
  return { entries, unreadable };
}
