import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IngestResult } from "@ascenda-one/tool-contract";
import { sanitizeFilePart } from "./tokenStore";

/**
 * Everything a send attempt can end in. {@link IngestResult} is what the
 * ingest endpoint can say; the rest are attempts that never reached it.
 *
 * `skipped_no_installation_id`: the hook ran, had events to ship, and could
 * not name the installation — no environment variable, no credentials file,
 * and no single token file to fall back on. Recorded because an attempt that
 * exits without touching the journal is indistinguishable from a collector
 * that never ran, which hid a twelve-hour gap on 26–27 Aug 2026.
 */
export type SendOutcome = IngestResult | "skipped_no_installation_id" | "outbox_discarded";

/**
 * Why a queued event was dropped from the outbox without being delivered.
 * `age` and `count` are the bounds biting; `unreadable` is a line that did
 * not parse; `rejected` is a verdict from the batch door that replaying
 * cannot change.
 */
export type OutboxDiscardReason = "age" | "count" | "unreadable" | "rejected";

/**
 * The running record of outbox evictions. Cumulative, so it survives the
 * successes that follow — unlike `consecutiveFailures`, which the first
 * accepted send resets. A gap that has since closed is still a gap in the
 * data, and this is the one place on the machine that says so.
 */
export type OutboxDiscardRecord = {
  total: number;
  lastAt: string;
  lastCount: number;
  lastReasons: Partial<Record<OutboxDiscardReason, number>>;
  /** How far back the most recent loss reached. */
  lastOldestQueuedAt?: string;
};

/**
 * The collector's send journal: one file per installation, rewritten on every
 * attempt, success included.
 *
 * Written because on 17 Aug 2026 a collector stopped delivering for 21 hours
 * and nothing on the machine could say so. The transport had classified the
 * failure correctly and written a clear line to stderr — but a hook that exits
 * 0 has its stderr discarded by the host, so the classification reached nobody.
 * Every other channel had the same defect in a different costume: `lastSeenAt`
 * cannot tell a dead token from a night's sleep, because both are "no events".
 *
 * Hence the rule this file exists to enforce: *an operation that can fail
 * silently must record every outcome, including success.* Recording only
 * failures reproduces the original bug — an absent file would mean both
 * "healthy" and "never ran", which is exactly the ambiguity that cost the
 * afternoon. A journal whose `lastAttemptAt` is minutes old and whose
 * `lastOutcome` is `accepted` is positive evidence of health; one that is
 * hours stale says the collector never ran at all, which is a different fault
 * with a different fix.
 *
 * Nothing here throws. A telemetry journal that could take down a user's turn
 * would be a worse bug than the one it documents.
 */
export type CollectorState = {
  toolInstallationId: string;
  /** Every attempt stamps this, which is what makes "never ran" detectable. */
  lastAttemptAt: string;
  /** Survives later failures — the answer to "when did this last work?". */
  lastSuccessAt?: string;
  lastOutcome: SendOutcome;
  /** Reset to 0 by any success. Non-zero means the collector is failing now. */
  consecutiveFailures: number;
  httpStatus?: number;
  errorCode?: string;
  /** Short human-readable cause, e.g. a fetch error message. Never a token. */
  detail?: string;
  /**
   * When the current unbroken run of failures began; absent while healthy.
   * Identifies the *episode* rather than the attempt, so the one-time notice
   * fires once per outage instead of once per tool call.
   */
  failingSince?: string;
  /** The `failingSince` value already announced. Equal ⇒ already told them. */
  notifiedFailingSince?: string;
  /** Present once the outbox has ever evicted an event on this installation. */
  outboxDiscarded?: OutboxDiscardRecord;
};

/**
 * Default location: `~/.ascenda/state/<toolInstallationId>.json`, or
 * `$ASCENDA_STATE_DIR/<toolInstallationId>.json` when that is set.
 *
 * The override exists because the journal is the one part of this package that
 * writes outside its own process on a path nobody passes explicitly — a caller
 * that omits `stateFilePath` silently lands in the developer's real `$HOME`.
 * That is wrong in three places at once: a test suite leaves fixtures behind
 * that `doctor` then reports as real installations, CI writes into a shared
 * home, and a sandboxed host may have no writable `$HOME` at all.
 */
export function defaultStateFilePath(toolInstallationId: string): string {
  const dir = process.env.ASCENDA_STATE_DIR?.trim();
  const base = dir ? dir : path.join(os.homedir(), ".ascenda", "state");
  return path.join(base, `${sanitizeFilePart(toolInstallationId)}.json`);
}

/**
 * The placeholder an attempt is journalled under when it could not name its
 * installation — see `skipped_no_installation_id` in {@link SendOutcome}.
 * The journal is keyed by installation id, and this is the one outcome that
 * by definition has none, so it gets a fixed name per tool type instead.
 */
export function unresolvedToolInstallationId(toolType: string): string {
  return `${toolType}:unresolved`;
}

/**
 * Where skipped-for-want-of-an-id attempts are journalled: the same directory
 * as every other journal, under the placeholder id above. Resolvable with no
 * installation id at all, which is the whole point.
 */
export function unresolvedStateFilePath(toolType: string): string {
  return defaultStateFilePath(unresolvedToolInstallationId(toolType));
}

export function readCollectorState(stateFilePath: string): CollectorState | undefined {
  try {
    if (!fs.existsSync(stateFilePath)) return undefined;
    const raw = fs.readFileSync(stateFilePath, "utf8").trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CollectorState;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    // A corrupt or unreadable journal reads as "no journal". Diagnostics must
    // degrade to silence, never to a thrown error on the hook path.
    return undefined;
  }
}

export type OutcomeDetail = {
  httpStatus?: number;
  errorCode?: string;
  detail?: string;
};

/**
 * Records one send attempt and returns the resulting state.
 *
 * Returns the state even when persistence fails, so a read-only home directory
 * costs the caller its one-time notice rather than its telemetry.
 */
export function recordSendOutcome(
  stateFilePath: string,
  toolInstallationId: string,
  outcome: SendOutcome,
  detail: OutcomeDetail = {}
): CollectorState {
  const now = new Date().toISOString();
  const previous = readCollectorState(stateFilePath);
  const accepted = outcome === "accepted";

  const next: CollectorState = {
    toolInstallationId,
    lastAttemptAt: now,
    lastSuccessAt: accepted ? now : previous?.lastSuccessAt,
    lastOutcome: outcome,
    consecutiveFailures: accepted ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
    ...(detail.httpStatus !== undefined ? { httpStatus: detail.httpStatus } : {}),
    ...(detail.errorCode !== undefined ? { errorCode: detail.errorCode } : {}),
    ...(detail.detail !== undefined ? { detail: truncate(detail.detail) } : {}),
    // A success closes the episode; a failure either opens one or continues
    // the one already open. Carrying `notifiedFailingSince` across a
    // continuing episode is what keeps the notice to once per outage.
    ...(accepted ? {} : { failingSince: previous?.failingSince ?? now }),
    ...(accepted ? {} : previous?.notifiedFailingSince !== undefined
      ? { notifiedFailingSince: previous.notifiedFailingSince }
      : {}),
    // Cumulative by design: a send outcome, success included, never erases
    // the record of what the outbox had to throw away.
    ...(previous?.outboxDiscarded !== undefined ? { outboxDiscarded: previous.outboxDiscarded } : {})
  };

  writeStateFile(stateFilePath, next);
  return next;
}

/**
 * Records that the outbox evicted events it will never deliver. Not a send
 * attempt — `lastAttemptAt`, `consecutiveFailures` and the failure episode
 * are left exactly as they were — but it is the most recent thing that
 * happened to this installation's data, so `lastOutcome` says so. The
 * cumulative `outboxDiscarded` record is what `doctor` reads, and it survives
 * every later success.
 */
export function recordOutboxDiscard(
  stateFilePath: string,
  toolInstallationId: string,
  discard: { count: number; reasons: Partial<Record<OutboxDiscardReason, number>>; oldestQueuedAt?: string }
): CollectorState {
  const now = new Date().toISOString();
  const previous = readCollectorState(stateFilePath);
  const next: CollectorState = {
    ...(previous ?? { lastAttemptAt: now, consecutiveFailures: 0 }),
    toolInstallationId,
    lastOutcome: "outbox_discarded",
    outboxDiscarded: {
      total: (previous?.outboxDiscarded?.total ?? 0) + discard.count,
      lastAt: now,
      lastCount: discard.count,
      lastReasons: discard.reasons,
      ...(discard.oldestQueuedAt !== undefined ? { lastOldestQueuedAt: discard.oldestQueuedAt } : {})
    }
  };
  writeStateFile(stateFilePath, next);
  return next;
}

/**
 * Whether the user should be told about this episode, given a state.
 *
 * Split from {@link markFailureNotified} because the two happen at different
 * moments: the decision is made wherever the failure lands, but the telling
 * can only happen on a hook that owns an `additionalContext` channel.
 */
export function shouldAnnounceFailure(state: CollectorState | undefined): boolean {
  if (!state || state.consecutiveFailures === 0 || !state.failingSince) return false;
  return state.notifiedFailingSince !== state.failingSince;
}

export function markFailureNotified(stateFilePath: string, state: CollectorState): void {
  if (!state.failingSince) return;
  writeStateFile(stateFilePath, { ...state, notifiedFailingSince: state.failingSince });
}

/**
 * Atomic because hooks run concurrently — Claude Code fires `PreToolUse` and
 * `PostToolUse` from separate processes, and a half-written journal would be
 * read back as no journal at all, losing exactly the evidence this file exists
 * to keep. Owner-only for the same reason the token store is: the journal
 * names the installation and its failure history.
 */
function writeStateFile(stateFilePath: string, state: CollectorState): void {
  const temporaryPath = `${stateFilePath}.${process.pid}.tmp`;
  try {
    const dir = path.dirname(stateFilePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, stateFilePath);
    if (process.platform !== "win32") fs.chmodSync(stateFilePath, 0o600);
  } catch {
    // Best-effort by design: see this module's contract note.
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // Nothing further to try, and nothing worth a word in the transcript.
    }
  }
}

/** Bounds an error body so a verbose upstream cannot bloat the journal. */
function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}
