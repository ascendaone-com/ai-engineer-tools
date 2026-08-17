import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IngestResult } from "@ascenda-one/tool-contract";
import { sanitizeFilePart } from "./tokenStore";

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
  lastOutcome: IngestResult;
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
};

/** Default location: ~/.ascenda/state/<toolInstallationId>.json */
export function defaultStateFilePath(toolInstallationId: string): string {
  return path.join(os.homedir(), ".ascenda", "state", `${sanitizeFilePart(toolInstallationId)}.json`);
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
  outcome: IngestResult,
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
      : {})
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
