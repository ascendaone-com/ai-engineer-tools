/**
 * Local handoff into the desktop app's sandbox container.
 *
 * The problem this solves: the macOS app is sandboxed and can never read
 * `~/.claude` or `~/.ascenda`, but it CAN read its own container — and the
 * live-presence bus already establishes the pattern of an unsandboxed
 * collector writing into `~/Library/Containers/<bundle>/Data/.ascenda/`
 * (see tool-kit's `liveBusSocketCandidates`). The importer writes its
 * session digest there and the app picks it up with no entitlement, no
 * Powerbox prompt, and no backend round-trip.
 *
 * Why local at all, when the events already ship to the backend: the
 * timeline is a local-first surface, and the demand view that would
 * otherwise carry this is Pro-gated. Historical notches are part of the
 * free first-run experience, so they must not depend on an entitlement or
 * on the network.
 *
 * This file is a TRANSFER BUFFER, not a store of record. The app copies
 * what it needs into its own journal and may delete it afterwards; a lost
 * or stale handoff costs a re-run of the importer, nothing more.
 *
 * Privacy: this file never leaves the machine, so it may carry the
 * human-readable project label the app needs to name a notch. It still
 * carries no prompt text, response text, or file contents — the same
 * metrics-only rule as the wire, minus the hashing that only exists to
 * keep paths from reaching a server.
 */
import { LOCAL_TIMEZONE, SessionDaySlice } from "./daySlice.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NormalizedHistoricalEvent } from "./types.js";

const APP_BUNDLE_ID = "one.ascenda.ascendaMissionControl";

/** Schema version of the handoff file. The app must refuse a version it
 * does not know rather than guess at fields — same rule the extractors
 * apply to upstream stores. */
/**
 * Bumped to 2 for per-day session slices (`days`, `timezone`). Additive —
 * every schema-1 field is still written and still means what it meant — but
 * a reader has to be able to tell a handoff that omits `days` from one whose
 * sessions genuinely span no extra day, because the fallback for the first
 * (place the session on its end day) would be wrong for the second.
 *
 * Bumped to 3 for `toolCallCount` on all three stores' session shapes (plus
 * `subagentToolCallCount` on Claude Code's and `toolCallsUndated` on
 * Cursor's). Additive on the same terms, and the same reason for the bump:
 * a schema-2 handoff omits the field entirely, which is "not collected", and
 * a schema-3 handoff writing 0 means the session genuinely made no tool
 * call. A reader that could not tell those apart would render the first as
 * the second — the absent-not-zero rule this package applies to every other
 * uncollectable field.
 */
export const HANDOFF_SCHEMA = 3;

export function handoffDir(home: string = os.homedir()): string {
  return path.join(home, "Library", "Containers", APP_BUNDLE_ID, "Data", ".ascenda", "history-import");
}

/** One handoff file per store — `store` names the file (`claude_code.json`,
 * `cursor.json`, …) so each extractor's digest lands separately and a
 * missing/stale one never clobbers another store's. */
export function handoffFilePath(home: string = os.homedir(), store: string = "claude_code"): string {
  return path.join(handoffDir(home), `${store}.json`);
}

export interface HandoffSession {
  /**
   * Per-local-day slices, oldest first. A session spanning days holds one
   * entry per day it actually had prompts on — never one per day between
   * its ends, which would claim work on days that had none. Empty where the
   * store gave no usable timestamps.
   */
  days: SessionDaySlice[];

  /** End of the session — where the notch sits on the timeline. */
  at: string;
  /** Start of the session — null when the extractor's fold somehow has no
   * usable first timestamp, which `buildHandoff` filters out before this
   * point in practice, but the type stays honest about the source field's
   * own nullability rather than asserting a value that isn't guaranteed. */
  startedAt: string | null;
  /** Session id, so a re-import can replace rather than duplicate. */
  sessionRef: string | null;
  /** Human-readable project name (last path segment of the cwd). Local only. */
  projectLabel: string | null;
  promptCount: number;
  durationBucket: string;
  afterHoursPrompts: number;
  primaryModel: string | null;
  /** Gap-split minutes (5m idle threshold) — the non-idle-inflated
   * alternative to wall-clock duration. See claudeCode.ts's activeMinutesOf. */
  activeMinutes: number;
  /** `system` lines with subtype `compact_boundary` — how many times this
   * session's context got compacted, manual or auto. */
  compactionCount: number;
  /** `toolUseResult` `is_error` markers plus `system` `api_error` lines —
   * positive friction evidence, additive fix for the historical-import
   * honesty audit's F1 (absence of this field previously read as a
   * fabricated "no friction at all" rather than "not collected"). */
  toolFailureCount: number;
  /** Peak (input + cache_read + cache_creation) tokens across the session's
   * assistant turns, as a fraction of an assumed 200k-token window.
   *
   * No longer clamped at 1.0 — see `contextWindowPeakPctOf`. A session on a
   * 1M-token context legitimately reports >1 here, which is the point: the
   * old clamp collapsed 59% of a real store onto exactly 1.0 and destroyed
   * the field's variance. Prefer [contextWindowPeakTokens]. */
  contextWindowPeakPct: number;
  /** Peak (input + cache_read + cache_creation) tokens — the measured
   * quantity, with no assumed denominator. This is what a within-person
   * baseline should be computed against. */
  contextWindowPeakTokens: number;
  /** `toolUseResult.userModified === true` count — edits the human corrected
   * by hand after the AI proposed them.
   *
   * **Null means the store could not answer**, and on Claude Code today it
   * always will be: the field is present 20,133 times in a real store and
   * `false` every time. Never write 0 here — a fabricated "no corrections"
   * is exactly the F1 finding this package's honesty audit raised. */
  userModifiedEditCount: number | null;
  /** `tool_use` items the main thread issued — the same quantity the backend's
   * demand rail derives by counting `ai_tool_call_started` rows, carried here
   * because the local timeline has no event stream to count. */
  toolCallCount: number;
  /** The same, for calls issued inside this session's subagent transcripts.
   * Kept apart the way `subagentTranscripts` is: a session that spent its
   * tool budget through subagents did something visibly different from one
   * that made every call on the main thread. Sum the two for the session's
   * real total. */
  subagentToolCallCount: number;
  /** Subagent (Task-tool) transcripts folded into this session, so a session
   * that leaned on subagents doesn't look identical to one that didn't. */
  subagentTranscripts: number;
  /** `historical_direct` | `historical_derived` — the app renders derived
   * entries as inferred, never as something the user recorded. */
  provenance: string;
}

export interface HandoffFile {
  schema: number;
  extractionId: string;
  generatedAt: string;
  /**
   * IANA zone the day slices were cut in — the extracting machine's own, on
   * purpose: "did I work on Tuesday" is a question about the person's
   * Tuesday, not UTC's. Recorded so a reader can tell which zone rather than
   * assume its own. Null where the host could not name one.
   */
  timezone: string | null;
  store: string;
  windowOldest: string | null;
  windowNewest: string | null;
  sessions: HandoffSession[];
}

/** Cursor's handoff session — a distinct shape from Claude Code's, because
 * Cursor's unique signals (lines added/removed, human-vs-AI edit
 * attribution, post-edit lint state) don't exist on the Claude side and
 * vice versa (compaction, tool failures). Forcing both into one interface
 * would mean every field is optional on every store — worse for the app,
 * which has to render "not collected" for a field its own store never had a
 * chance to fill either way. */
export interface CursorHandoffSession {
  /**
   * Per-local-day slices, oldest first. A session spanning days holds one
   * entry per day it actually had prompts on — never one per day between
   * its ends, which would claim work on days that had none. Empty where the
   * store gave no usable timestamps.
   */
  days: SessionDaySlice[];

  at: string;
  startedAt: string | null;
  sessionRef: string | null;
  projectLabel: string | null;
  promptCount: number;
  durationBucket: string;
  afterHoursPrompts: number;
  primaryModel: string | null;
  linesAdded: number;
  linesRemoved: number;
  filesChangedCount: number;
  contextUsagePercent: number | null;
  /** Sum of `humanChanges` array lengths across the session's bubbles —
   * human-vs-AI edit attribution. */
  humanChangesCount: number;
  /** Sum of `approximateLintErrors` array lengths — post-AI-edit quality. */
  approximateLintErrorsCount: number;
  /** Distinct `toolFormerData.toolCallId`s under this composer, subagents
   * folded in. Distinct, not bubbles: Cursor writes several bubbles per call. */
  toolCallCount: number;
  /** Of those, the ones every recording bubble left undated — counted here
   * and absent from the shipped event stream, because there is no instant to
   * place them at. A non-zero value means this session's rail contribution is
   * smaller than its `toolCallCount`. */
  toolCallsUndated: number;
  /** Distinct Cursor "explore" subagent composers folded into this session. */
  subagentComposers: number;
  provenance: string;
}

export interface CursorHandoffFile {
  schema: number;
  extractionId: string;
  generatedAt: string;
  /**
   * IANA zone the day slices were cut in — the extracting machine's own, on
   * purpose: "did I work on Tuesday" is a question about the person's
   * Tuesday, not UTC's. Recorded so a reader can tell which zone rather than
   * assume its own. Null where the host could not name one.
   */
  timezone: string | null;
  store: string;
  windowOldest: string | null;
  windowNewest: string | null;
  sessions: CursorHandoffSession[];
}

/**
 * One (day, workspace) Chat-Edit tally from Timeline local history. Not a
 * session — VS Code's Timeline store has no session concept, only
 * independent per-file snapshots — so this rides alongside `chatSessions`
 * (Copilot's genuine sessions) in the same handoff file rather than being
 * forced into `VsCodeHandoffSession`'s shape.
 */
export interface VsCodeHandoffEditDay {
  date: string;
  projectLabel: string | null;
  chatEditCount: number;
  totalEntryCount: number;
  provenance: string;
}

/** A Copilot chat session (`workspaceStorage/*\/chatSessions/*.json`) —
 * genuinely session-shaped, unlike the Timeline edit days above. */
export interface VsCodeHandoffSession {
  /**
   * Per-local-day slices, oldest first. A session spanning days holds one
   * entry per day it actually had prompts on — never one per day between
   * its ends, which would claim work on days that had none. Empty where the
   * store gave no usable timestamps.
   */
  days: SessionDaySlice[];

  at: string;
  startedAt: string | null;
  sessionRef: string | null;
  projectLabel: string | null;
  requestCount: number;
  durationBucket: string;
  afterHoursRequests: number;
  primaryModel: string | null;
  canceledCount: number;
  errorCount: number;
  /** `toolInvocationSerialized` response parts across the session's requests
   * — Copilot's own per-call records, not a turn count standing in for one. */
  toolCallCount: number;
  provenance: string;
}

export interface VsCodeHandoffFile {
  schema: number;
  extractionId: string;
  generatedAt: string;
  /**
   * IANA zone the day slices were cut in — the extracting machine's own, on
   * purpose: "did I work on Tuesday" is a question about the person's
   * Tuesday, not UTC's. Recorded so a reader can tell which zone rather than
   * assume its own. Null where the host could not name one.
   */
  timezone: string | null;
  store: string;
  windowOldest: string | null;
  windowNewest: string | null;
  editDays: VsCodeHandoffEditDay[];
  chatSessions: VsCodeHandoffSession[];
}

/** Last path segment of a repo path — "my-service" from a full cwd.
 * Falls back to the raw ref when it is already a slug. */
export function projectLabelOf(repoRef: string | null): string | null {
  if (!repoRef) return null;
  const trimmed = repoRef.replace(/\/+$/, "");
  const segment = trimmed.split("/").filter(Boolean).pop() ?? null;
  return segment && segment.length > 0 ? segment : null;
}

export function buildHandoff(
  events: NormalizedHistoricalEvent[],
  extractionId: string,
  generatedAt: string
): HandoffFile {
  const sessions: HandoffSession[] = [];
  let windowOldest: string | null = null;
  let windowNewest: string | null = null;

  for (const event of events) {
    if (event.eventKind === "extraction_epoch") {
      const oldest = event.metrics.windowOldest;
      const newest = event.metrics.windowNewest;
      if (typeof oldest === "string") windowOldest = oldest;
      if (typeof newest === "string") windowNewest = newest;
      continue;
    }
    if (event.eventKind !== "create_focus_session") continue;
    sessions.push({
      at: event.occurredAt,
      startedAt: typeof event.metrics.sessionStartedAt === "string" ? event.metrics.sessionStartedAt : null,
      sessionRef: event.sessionRef,
      projectLabel: projectLabelOf(event.repoRef),
      promptCount: Number(event.metrics.promptCount ?? 0),
      durationBucket: String(event.metrics.durationBucket ?? "unknown"),
      afterHoursPrompts: Number(event.metrics.afterHoursPrompts ?? 0),
      primaryModel:
        typeof event.metrics.primaryModel === "string" ? event.metrics.primaryModel : null,
      activeMinutes: Number(event.metrics.activeMinutes ?? 0),
      compactionCount: Number(event.metrics.compactionCount ?? 0),
      toolFailureCount: Number(event.metrics.toolFailureCount ?? 0),
      contextWindowPeakPct: Number(event.metrics.contextWindowPeakPct ?? 0),
      contextWindowPeakTokens: Number(event.metrics.contextWindowPeakTokens ?? 0),
      // Null, never 0. `toolUseResult.userModified` occurs 20,133 times
      // across a real 363-session store and is `false` on every single one
      // — Claude Code does not appear to set it true. Shipping 0 says "no
      // AI edit was ever corrected by hand", which is a finding; the truth
      // is that this store cannot answer the question. The extractor keeps
      // counting it in case upstream starts populating it, and the handoff
      // reports the count only when it is non-zero.
      userModifiedEditCount:
        Number(event.metrics.userModifiedEditCount ?? 0) > 0
          ? Number(event.metrics.userModifiedEditCount)
          : null,
      toolCallCount: Number(event.metrics.toolCallCount ?? 0),
      subagentToolCallCount: Number(event.metrics.subagentToolCallCount ?? 0),
      subagentTranscripts: Number(event.metrics.subagentTranscripts ?? 0),
      days: event.dayBreakdown ?? [],
      provenance: event.provenance
    });
  }
  sessions.sort((a, b) => a.at.localeCompare(b.at));

  return {
    schema: HANDOFF_SCHEMA,
    extractionId,
    generatedAt,
    timezone: LOCAL_TIMEZONE,
    store: "claude_code",
    windowOldest,
    windowNewest,
    sessions
  };
}

export function buildCursorHandoff(
  events: NormalizedHistoricalEvent[],
  extractionId: string,
  generatedAt: string
): CursorHandoffFile {
  const sessions: CursorHandoffSession[] = [];
  let windowOldest: string | null = null;
  let windowNewest: string | null = null;

  for (const event of events) {
    if (event.eventKind === "extraction_epoch") {
      const oldest = event.metrics.windowOldest;
      const newest = event.metrics.windowNewest;
      if (typeof oldest === "string") windowOldest = oldest;
      if (typeof newest === "string") windowNewest = newest;
      continue;
    }
    if (event.eventKind !== "create_focus_session") continue;
    sessions.push({
      at: event.occurredAt,
      startedAt: typeof event.metrics.sessionStartedAt === "string" ? event.metrics.sessionStartedAt : null,
      sessionRef: event.sessionRef,
      projectLabel: projectLabelOf(event.repoRef),
      promptCount: Number(event.metrics.promptCount ?? 0),
      durationBucket: String(event.metrics.durationBucket ?? "unknown"),
      afterHoursPrompts: Number(event.metrics.afterHoursPrompts ?? 0),
      primaryModel:
        typeof event.metrics.primaryModel === "string" ? event.metrics.primaryModel : null,
      linesAdded: Number(event.metrics.linesAdded ?? 0),
      linesRemoved: Number(event.metrics.linesRemoved ?? 0),
      filesChangedCount: Number(event.metrics.filesChangedCount ?? 0),
      contextUsagePercent:
        typeof event.metrics.contextUsagePercent === "number" ? event.metrics.contextUsagePercent : null,
      humanChangesCount: Number(event.metrics.humanChangesCount ?? 0),
      approximateLintErrorsCount: Number(event.metrics.approximateLintErrorsCount ?? 0),
      toolCallCount: Number(event.metrics.toolCallCount ?? 0),
      toolCallsUndated: Number(event.metrics.toolCallsUndated ?? 0),
      subagentComposers: Number(event.metrics.subagentComposers ?? 0),
      days: event.dayBreakdown ?? [],
      provenance: event.provenance
    });
  }
  sessions.sort((a, b) => a.at.localeCompare(b.at));

  return {
    schema: HANDOFF_SCHEMA,
    extractionId,
    generatedAt,
    timezone: LOCAL_TIMEZONE,
    store: "cursor",
    windowOldest,
    windowNewest,
    sessions
  };
}

export function buildVsCodeHandoff(
  events: NormalizedHistoricalEvent[],
  extractionId: string,
  generatedAt: string
): VsCodeHandoffFile {
  const editDays: VsCodeHandoffEditDay[] = [];
  const chatSessions: VsCodeHandoffSession[] = [];
  let windowOldest: string | null = null;
  let windowNewest: string | null = null;

  for (const event of events) {
    if (event.eventKind === "extraction_epoch") {
      const oldest = event.metrics.windowOldest;
      const newest = event.metrics.windowNewest;
      if (typeof oldest === "string") windowOldest = oldest;
      if (typeof newest === "string") windowNewest = newest;
      continue;
    }
    if (event.eventKind === "editor_activity") {
      editDays.push({
        date: typeof event.metrics.date === "string" ? event.metrics.date : event.occurredAt.slice(0, 10),
        projectLabel: projectLabelOf(event.repoRef),
        chatEditCount: Number(event.metrics.chatEditCount ?? 0),
        totalEntryCount: Number(event.metrics.totalEntryCount ?? 0),
        provenance: event.provenance
      });
      continue;
    }
    if (event.eventKind !== "create_focus_session") continue;
    chatSessions.push({
      at: event.occurredAt,
      startedAt: typeof event.metrics.sessionStartedAt === "string" ? event.metrics.sessionStartedAt : null,
      sessionRef: event.sessionRef,
      projectLabel: projectLabelOf(event.repoRef),
      requestCount: Number(event.metrics.requestCount ?? 0),
      durationBucket: String(event.metrics.durationBucket ?? "unknown"),
      afterHoursRequests: Number(event.metrics.afterHoursRequests ?? 0),
      primaryModel: typeof event.metrics.primaryModel === "string" ? event.metrics.primaryModel : null,
      canceledCount: Number(event.metrics.canceledCount ?? 0),
      errorCount: Number(event.metrics.errorCount ?? 0),
      toolCallCount: Number(event.metrics.toolCallCount ?? 0),
      days: event.dayBreakdown ?? [],
      provenance: event.provenance
    });
  }
  editDays.sort((a, b) => a.date.localeCompare(b.date) || (a.projectLabel ?? "").localeCompare(b.projectLabel ?? ""));
  chatSessions.sort((a, b) => a.at.localeCompare(b.at));

  return {
    schema: HANDOFF_SCHEMA,
    extractionId,
    generatedAt,
    timezone: LOCAL_TIMEZONE,
    store: "vscode",
    windowOldest,
    windowNewest,
    editDays,
    chatSessions
  };
}

/**
 * Write the handoff atomically: the app may be reading this file at any
 * moment, and a half-written JSON document is indistinguishable from a
 * corrupt one. Write-then-rename makes the swap atomic on the same volume.
 *
 * Returns null (rather than throwing) when the container does not exist —
 * the app simply is not installed, which is a normal state for a CLI that
 * also serves people who only ship to the backend.
 */
export async function writeHandoff(
  handoff: HandoffFile | CursorHandoffFile | VsCodeHandoffFile,
  home: string = os.homedir()
): Promise<string | null> {
  const containerRoot = path.join(home, "Library", "Containers", APP_BUNDLE_ID, "Data");
  try {
    await fs.stat(containerRoot);
  } catch {
    return null;
  }
  const dir = handoffDir(home);
  await fs.mkdir(dir, { recursive: true });
  const target = handoffFilePath(home, handoff.store);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, JSON.stringify(handoff, null, 2) + "\n", "utf8");
  await fs.rename(temp, target);
  return target;
}
