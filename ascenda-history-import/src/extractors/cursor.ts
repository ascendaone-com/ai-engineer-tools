/**
 * Cursor extractor — second in the evaporation order (no purge observed, but
 * the richest per-message structure: 71-field bubbles with tokenCount,
 * human-vs-AI edit attribution, and post-edit lint state).
 *
 * Store: `state.vscdb` (SQLite, WAL). Extraction reads the STAGED copy only
 * — `snapshotDir` is the directory `src/staging.ts` copied `state.vscdb`
 * (plus its `-wal`/`-shm` siblings) into. Unlike `scan.ts`'s live read
 * (`mode=ro&immutable=1`, because it can't safely mutate the real file),
 * this file opens the staged copy PLAIN: it is our own throwaway copy, so
 * letting SQLite replay the WAL and create its own `-shm` is not just safe,
 * it is required — `immutable=1` tells SQLite the file will not change and,
 * per its own docs, is licensed to ignore the WAL entirely. Opening a WAL-mode
 * db immutable would silently read PAST the very transactions `staging.ts`
 * copied the `-wal` sibling to preserve — exactly the newest sessions a user
 * would notice missing. Read-write on a private copy has no such trap.
 *
 * Tables (observed 2026-08-18, Cursor installed 2026-02-24, 147
 * composerHeaders / 146 composerData / 17,727 bubbles):
 *  - `composerHeaders` — one row per conversation. `composerId`, `createdAt`,
 *    `lastUpdatedAt` and `isSubagent` are real columns; everything else
 *    (`totalLinesAdded`/`totalLinesRemoved`/`filesChangedCount`,
 *    `contextUsagePercent`, `unifiedMode`, `trackedGitRepos`,
 *    `workspaceIdentifier`, `subagentInfo`) lives inside a `value` TEXT
 *    column holding one JSON blob per row. That blob self-labels
 *    `"type": "head"` — the closest thing to a version tag a header carries,
 *    dispatched on the same way `_v` is (see `sniffCursorHeaderRow`).
 *  - `cursorDiskKV` — a flat key/value table. `composerData:<id>` (146 rows,
 *    duplicates each header's own bubble list plus full prompt/response text)
 *    is deliberately never read: nothing this extractor needs isn't already
 *    on `composerHeaders` or the bubbles. `bubbleId:<composerId>:<bubbleId>`
 *    (17,727 rows) are the message bubbles; each is a 71-field JSON blob
 *    self-labelling `_v` (uniformly 3 on the verified store), `type` (1 =
 *    human message, 603 observed; 2 = assistant turn, 17,124 observed —
 *    Cursor fragments one assistant reply across many bubbles, tool calls
 *    and thinking included, unlike Claude Code's near-1:1 line ratio),
 *    `tokenCount`, `humanChanges`/`approximateLintErrors` (both empty-array
 *    on the verified store — the fields exist and are read regardless, since
 *    a machine with real usage of Cursor's diff-review flow would populate
 *    them), and `modelInfo.modelName`.
 *
 * Content never enters this process, not just "never leaves the machine":
 * every bubble query below selects individual `json_extract`/
 * `json_array_length` scalars, never the bubble's own `value` column, so the
 * 71-field blob's `text`/`richText`/`allThinkingBlocks`/`gitDiffs` — the
 * fields that actually hold prompt and response content — are never even
 * parsed into a JS object, let alone shipped. `composerHeaders.value` IS read
 * whole (it is one order of magnitude smaller — 147 rows, not 17,727 — and
 * has no prompt/response text field, only `name`/`subtitle` UI labels similar
 * in kind to the `cwd`/`gitBranch` fields the Claude extractor already reads
 * directly off transcript lines).
 *
 * Cursor's own subagent feature (`isSubagent: 1`, ~19% of headers on the
 * verified store — Cursor's "explore" agent spawned via a tool call) is the
 * same shape as Claude Code's Task-tool subagents and gets the same fix:
 * `subagentInfo.parentComposerId` links a subagent composer back to the one
 * a human was actually driving. Its single task-instruction bubble is not
 * something a human typed (never `ai_prompt_submitted`, never `promptCount`);
 * its real work still happened in service of the parent, so token/turn
 * counts fold into the parent's `subagent*` breakdown instead of vanishing
 * or inflating the parent's own numbers silently.
 *
 * SQLite access shells to `/usr/bin/sqlite3` (`scan.ts`'s precedent) rather
 * than adding `better-sqlite3`: this package ships as an `npx`-run CLI, and
 * a native module would need a prebuilt binary per platform/Node ABI before
 * the first real user could run `import` at all. macOS ships `sqlite3` with
 * JSON1 compiled in, so `json_extract`/`json_array_length` are available
 * without a `.load` — verified against the real store while writing this.
 *
 * Session-level events come from `composerHeaders` alone (outcome metrics
 * are already folded there); bubbles are aggregated per composer for
 * prompt-iteration counts, token totals, and human/AI attribution — NEVER
 * emitted as their own event (17,727 of them on one observed machine).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bucketDurationMs, isAfterHours } from "@ascenda-one/tool-kit";
import { HISTORICAL_PROVENANCE, NormalizedHistoricalEvent } from "../types.js";

const execFileAsync = promisify(execFile);

/** Bubble schema version this extractor knows how to read (`_v` on
 * `bubbleId:<composer>:<bubble>` records). Every bubble on the verified
 * 17,727-bubble store self-labels `_v: 3`; a bubble outside this set is
 * unparsed — none of its fields are trusted, only counted. */
export const KNOWN_CURSOR_BUBBLE_VERSIONS = new Set([3]);

/** `value.type` on `composerHeaders` rows. composerHeaders carries no `_v`,
 * so this field is the nearest thing to a self-labelled version and is
 * dispatched on the same way. Every row on the verified store is `"head"`. */
export const KNOWN_CURSOR_HEADER_TYPES = new Set(["head"]);

/** Bubble `type`: 1 = a human message, 2 = an assistant turn. */
const BUBBLE_TYPE_USER = 1;
const BUBBLE_TYPE_ASSISTANT = 2;

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Most-frequent key in a counted map, or null for an empty one. Shared by
 * `primaryModel` and the session's dominant bubble `_v`. */
function pickTop(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

const MAX_QUERY_BUFFER = 256 * 1024 * 1024; // 256 MB — generous headroom over
// the ~17k-bubble/147-header verified store; a raised ceiling here is cheap
// insurance against `stdout maxBuffer exceeded`, not a scale promise (see
// the module doc's native-module tradeoff note for what happens past it).

async function queryJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
    maxBuffer: MAX_QUERY_BUFFER
  });
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  return JSON.parse(trimmed) as T[];
}

const HEADER_QUERY = `
SELECT
  composerId,
  createdAt,
  lastUpdatedAt,
  recency,
  checkpointAt,
  isSubagent,
  json_extract(value,'$.type') AS recordType,
  json_extract(value,'$.totalLinesAdded') AS linesAdded,
  json_extract(value,'$.totalLinesRemoved') AS linesRemoved,
  json_extract(value,'$.filesChangedCount') AS filesChangedCount,
  json_extract(value,'$.contextUsagePercent') AS contextUsagePercent,
  json_extract(value,'$.unifiedMode') AS mode,
  json_extract(value,'$.trackedGitRepos') AS trackedGitReposJson,
  json_extract(value,'$.workspaceIdentifier.uri.fsPath') AS workspaceFsPath,
  json_extract(value,'$.subagentInfo.parentComposerId') AS parentComposerId
FROM composerHeaders;
`;

const BUBBLE_QUERY = `
SELECT
  key,
  json_extract(value,'$._v') AS v,
  json_extract(value,'$.type') AS btype,
  json_extract(value,'$.createdAt') AS createdAt,
  json_extract(value,'$.tokenCount.inputTokens') AS inputTokens,
  json_extract(value,'$.tokenCount.outputTokens') AS outputTokens,
  coalesce(json_array_length(value,'$.humanChanges'),0) AS humanChangesCount,
  coalesce(json_array_length(value,'$.approximateLintErrors'),0) AS lintErrorsCount,
  json_extract(value,'$.modelInfo.modelName') AS modelName
FROM cursorDiskKV WHERE key LIKE 'bubbleId:%';
`;

interface RawHeaderRow {
  composerId: string;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  recency: number | null;
  checkpointAt: number | null;
  isSubagent: number | null;
  recordType: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChangedCount: number | null;
  contextUsagePercent: number | null;
  mode: string | null;
  trackedGitReposJson: string | null;
  workspaceFsPath: string | null;
  parentComposerId: string | null;
}

interface RawBubbleRow {
  key: string;
  v: number | null;
  btype: number | null;
  createdAt: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  humanChangesCount: number | null;
  lintErrorsCount: number | null;
  modelName: string | null;
}

/** Pulled out of `trackedGitRepos`/`workspaceIdentifier` — the repo path and
 * branch a header's `value` blob names, or null when neither is present. */
interface RepoInfo {
  repoRef: string | null;
  gitBranch: string | null;
}

function repoInfoOf(row: RawHeaderRow): RepoInfo {
  let repoRef: string | null = null;
  let gitBranch: string | null = null;
  if (row.trackedGitReposJson) {
    try {
      const repos = JSON.parse(row.trackedGitReposJson) as unknown;
      if (Array.isArray(repos) && repos.length > 0) {
        const first = repos[0] as Record<string, unknown>;
        if (typeof first.repoPath === "string") repoRef = first.repoPath;
        const branches = first.branches;
        if (Array.isArray(branches) && branches.length > 0) {
          const branch = branches[0] as Record<string, unknown>;
          if (typeof branch.branchName === "string") gitBranch = branch.branchName;
        }
      }
    } catch {
      // Malformed trackedGitRepos JSON — fall through to the workspace path.
    }
  }
  if (!repoRef && row.workspaceFsPath) repoRef = row.workspaceFsPath;
  return { repoRef, gitBranch };
}

export type SniffedCursorHeader =
  | ({ kind: "head" } & RepoInfo & {
        linesAdded: number;
        linesRemoved: number;
        filesChangedCount: number;
        contextUsagePercent: number | null;
        mode: string | null;
        isSubagent: boolean;
        parentComposerId: string | null;
      })
  /** Valid row, but `value.type` is not one this extractor reads. */
  | { kind: "unknown"; type: string }
  /** `value` did not parse to an object with a string `type` — real drift. */
  | { kind: "unparsed" };

export function sniffCursorHeaderRow(row: RawHeaderRow): SniffedCursorHeader {
  if (row.recordType === null) return { kind: "unparsed" };
  if (!KNOWN_CURSOR_HEADER_TYPES.has(row.recordType)) {
    return { kind: "unknown", type: row.recordType };
  }
  const { repoRef, gitBranch } = repoInfoOf(row);
  return {
    kind: "head",
    linesAdded: asNumber(row.linesAdded),
    linesRemoved: asNumber(row.linesRemoved),
    filesChangedCount: asNumber(row.filesChangedCount),
    contextUsagePercent: typeof row.contextUsagePercent === "number" ? row.contextUsagePercent : null,
    mode: row.mode,
    repoRef,
    gitBranch,
    isSubagent: row.isSubagent === 1,
    parentComposerId: row.parentComposerId
  };
}

export type SniffedCursorBubble =
  | {
      kind: "user" | "assistant";
      composerId: string;
      createdAt: string | null;
      inputTokens: number;
      outputTokens: number;
      humanChangesCount: number;
      lintErrorsCount: number;
      modelName: string | null;
      sourceVersion: string;
    }
  /** Known `_v`, but `type` is neither the human-message nor assistant-turn
   * value this extractor assigns meaning to. */
  | { kind: "unknown"; composerId: string }
  /** `_v` missing or outside `KNOWN_CURSOR_BUBBLE_VERSIONS`, or the key
   * itself doesn't split into `bubbleId:<composer>:<bubble>` — nothing about
   * the row is trusted past that point. */
  | { kind: "unparsed"; composerId: string | null };

export function sniffCursorBubbleRow(row: RawBubbleRow): SniffedCursorBubble {
  const parts = row.key.split(":");
  const composerId = parts.length >= 3 && parts[0] === "bubbleId" ? parts[1] : null;
  if (row.v === null || !KNOWN_CURSOR_BUBBLE_VERSIONS.has(row.v) || composerId === null) {
    return { kind: "unparsed", composerId };
  }
  if (row.btype !== BUBBLE_TYPE_USER && row.btype !== BUBBLE_TYPE_ASSISTANT) {
    return { kind: "unknown", composerId };
  }
  return {
    kind: row.btype === BUBBLE_TYPE_USER ? "user" : "assistant",
    composerId,
    createdAt: row.createdAt,
    inputTokens: asNumber(row.inputTokens),
    outputTokens: asNumber(row.outputTokens),
    humanChangesCount: asNumber(row.humanChangesCount),
    lintErrorsCount: asNumber(row.lintErrorsCount),
    modelName: row.modelName,
    sourceVersion: String(row.v)
  };
}

interface ComposerFold {
  composerId: string;
  createdAtMs: number | null;
  lastUpdatedAtMs: number | null;
  /** Fallbacks for a null `lastUpdatedAt`: `recency` and `checkpointAt` off
   * the header row, and the newest bubble timestamp folded in below. */
  recencyMs: number | null;
  checkpointAtMs: number | null;
  lastBubbleMs: number | null;
  mode: string | null;
  linesAdded: number;
  linesRemoved: number;
  filesChangedCount: number;
  contextUsagePercent: number | null;
  repoRef: string | null;
  gitBranch: string | null;
  humanPrompts: number;
  afterHoursPrompts: number;
  assistantTurns: number;
  inputTokens: number;
  outputTokens: number;
  humanChangesCount: number;
  lintErrorsCount: number;
  unknownBubbles: number;
  unparsedBubbles: number;
  models: Map<string, number>;
  bubbleVersions: Map<string, number>;
  /** Timestamps of the composer's OWN human-message bubbles only — never a
   * subagent's task instruction. Timestamps, never text. */
  humanPromptTimestamps: (string | null)[];
  /** Distinct subagent composerIds whose work folded into this one. */
  subagentComposerIds: Set<string>;
  subagentPromptCount: number;
  subagentAssistantTurns: number;
  subagentTokensTotal: number;
}

function newFold(row: RawHeaderRow, sniffed: Extract<SniffedCursorHeader, { kind: "head" }>): ComposerFold {
  return {
    composerId: row.composerId,
    createdAtMs: Number.isFinite(row.createdAt) ? (row.createdAt as number) : null,
    lastUpdatedAtMs: Number.isFinite(row.lastUpdatedAt) ? (row.lastUpdatedAt as number) : null,
    recencyMs: Number.isFinite(row.recency) ? (row.recency as number) : null,
    checkpointAtMs: Number.isFinite(row.checkpointAt) ? (row.checkpointAt as number) : null,
    lastBubbleMs: null,
    mode: sniffed.mode,
    linesAdded: sniffed.linesAdded,
    linesRemoved: sniffed.linesRemoved,
    filesChangedCount: sniffed.filesChangedCount,
    contextUsagePercent: sniffed.contextUsagePercent,
    repoRef: sniffed.repoRef,
    gitBranch: sniffed.gitBranch,
    humanPrompts: 0,
    afterHoursPrompts: 0,
    assistantTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    humanChangesCount: 0,
    lintErrorsCount: 0,
    unknownBubbles: 0,
    unparsedBubbles: 0,
    models: new Map(),
    bubbleVersions: new Map(),
    humanPromptTimestamps: [],
    subagentComposerIds: new Set(),
    subagentPromptCount: 0,
    subagentAssistantTurns: 0,
    subagentTokensTotal: 0
  };
}

/** Where a composer's end timestamp came from. `header` is `lastUpdatedAt`
 * itself; the rest are fallbacks, reported per-extraction so a store leaning
 * on them is visible rather than merely plausible. */
export type CursorTimelineSource = "header" | "bubbles" | "recency" | "checkpoint";

export interface ResolvedTimeline {
  endedAtMs: number;
  source: CursorTimelineSource;
}

/**
 * The end of a composer's timeline, falling back when `lastUpdatedAt` is null.
 *
 * `lastUpdatedAt` is nullable and Cursor leaves it unset on real conversations
 * — 42 of 151 headers on the reference machine. This function exists because
 * the emit loop used to `continue` past exactly those, silently: no event, no
 * counter, and no way to tell a dropped conversation from one that never
 * happened. On that machine the 15 non-subagent casualties were all empty, so
 * nothing was lost; nothing in the schema ties a null `lastUpdatedAt` to
 * emptiness, so on another machine they would not be.
 *
 * Order is by how directly each field witnesses the conversation ending:
 *  - `bubbles` — the newest message's own timestamp. Content truth: a message
 *    exists and it happened then. Preferred over any header field.
 *  - `recency` — a millisecond epoch that equals `lastUpdatedAt` on all 109
 *    reference-machine headers carrying both, which is why it is trusted at
 *    all; the name still suggests it could track opening rather than editing,
 *    so a bubble outranks it.
 *  - `checkpointAt` — last, present on only 27 of the 42 and describing a
 *    checkpoint rather than the conversation.
 *
 * A candidate before `createdAtMs` is not an end and is skipped, so a
 * repaired timeline can never invent a negative duration.
 */
export function resolveTimeline(fold: ComposerFold): ResolvedTimeline | null {
  if (fold.createdAtMs === null) return null;
  if (fold.lastUpdatedAtMs !== null) return { endedAtMs: fold.lastUpdatedAtMs, source: "header" };
  const candidates: [number | null, CursorTimelineSource][] = [
    [fold.lastBubbleMs, "bubbles"],
    [fold.recencyMs, "recency"],
    [fold.checkpointAtMs, "checkpoint"]
  ];
  for (const [ms, source] of candidates) {
    if (ms !== null && Number.isFinite(ms) && ms >= fold.createdAtMs) {
      return { endedAtMs: ms, source };
    }
  }
  return null;
}

function sessionDurationMs(fold: ComposerFold): number | null {
  const timeline = resolveTimeline(fold);
  if (timeline === null) return null;
  const ms = timeline.endedAtMs - (fold.createdAtMs as number);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function durationBucketOf(fold: ComposerFold): string {
  const ms = sessionDurationMs(fold);
  if (ms === null) return "unknown";
  return bucketDurationMs(ms) ?? "unknown";
}

export async function* extractCursor(
  snapshotDir: string,
  extractionId: string
): AsyncIterable<NormalizedHistoricalEvent> {
  const dbPath = path.join(snapshotDir, "state.vscdb");
  try {
    await fs.stat(dbPath);
  } catch {
    return; // No staged Cursor db — Cursor isn't installed, or wasn't present at scan time.
  }

  let headerRows: RawHeaderRow[];
  try {
    headerRows = await queryJson<RawHeaderRow>(dbPath, HEADER_QUERY);
  } catch {
    // The staged db exists but does not open, or `composerHeaders` is gone —
    // a schema this extractor cannot read at all. Returning silently here is
    // what made a store-format change indistinguishable from an unused store:
    // no events, no marker, nothing to notice. Declare it instead. This is the
    // same failure that hid VS Code's Feb-2026 `.jsonl` migration for months.
    yield {
      occurredAt: new Date().toISOString(),
      store: "cursor",
      sourceVersion: null,
      sessionRef: null,
      repoRef: null,
      eventKind: "extraction_epoch",
      metrics: {
        sessionCount: 0,
        schemaUnreadable: 1
      },
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };
    return;
  }

  const folds = new Map<string, ComposerFold>();
  const subagentParentOf = new Map<string, string>();
  let unparsedComposerHeaders = 0;
  let unknownComposerHeaderTypes = 0;

  for (const row of headerRows) {
    const sniffed = sniffCursorHeaderRow(row);
    if (sniffed.kind === "unparsed") {
      unparsedComposerHeaders += 1;
      continue;
    }
    if (sniffed.kind === "unknown") {
      unknownComposerHeaderTypes += 1;
      continue;
    }
    if (sniffed.isSubagent) {
      if (sniffed.parentComposerId) subagentParentOf.set(row.composerId, sniffed.parentComposerId);
      continue; // Never its own session — see the module doc's subagent note.
    }
    folds.set(row.composerId, newFold(row, sniffed));
  }

  let bubbleRows: RawBubbleRow[] = [];
  try {
    bubbleRows = await queryJson<RawBubbleRow>(dbPath, BUBBLE_QUERY);
  } catch {
    // cursorDiskKV missing or unreadable — sessions still emit off header data alone.
  }

  let orphanedSubagentBubbles = 0;
  let orphanedBubbles = 0;

  for (const row of bubbleRows) {
    const sniffed = sniffCursorBubbleRow(row);
    if (sniffed.kind === "unparsed") {
      const fold = sniffed.composerId ? folds.get(sniffed.composerId) : undefined;
      if (fold) fold.unparsedBubbles += 1;
      else if (sniffed.composerId && subagentParentOf.has(sniffed.composerId)) {
        // Unparsed bubble under a subagent — nothing to trust, but still
        // attribute the count to the parent so it isn't invisible.
        const parent = folds.get(subagentParentOf.get(sniffed.composerId) as string);
        if (parent) parent.unparsedBubbles += 1;
      } else orphanedBubbles += 1;
      continue;
    }

    const ownFold = folds.get(sniffed.composerId);
    if (ownFold) {
      if (sniffed.kind === "unknown") {
        ownFold.unknownBubbles += 1;
        continue;
      }
      ownFold.bubbleVersions.set(
        sniffed.sourceVersion,
        (ownFold.bubbleVersions.get(sniffed.sourceVersion) ?? 0) + 1
      );
      ownFold.inputTokens += sniffed.inputTokens;
      ownFold.outputTokens += sniffed.outputTokens;
      ownFold.humanChangesCount += sniffed.humanChangesCount;
      ownFold.lintErrorsCount += sniffed.lintErrorsCount;
      if (sniffed.modelName) {
        ownFold.models.set(sniffed.modelName, (ownFold.models.get(sniffed.modelName) ?? 0) + 1);
      }
      if (sniffed.createdAt) {
        const ms = Date.parse(sniffed.createdAt);
        if (Number.isFinite(ms) && (ownFold.lastBubbleMs === null || ms > ownFold.lastBubbleMs)) {
          ownFold.lastBubbleMs = ms;
        }
      }
      if (sniffed.kind === "user") {
        ownFold.humanPrompts += 1;
        if (sniffed.createdAt && isAfterHours(new Date(sniffed.createdAt))) {
          ownFold.afterHoursPrompts += 1;
        }
        ownFold.humanPromptTimestamps.push(sniffed.createdAt);
      } else {
        ownFold.assistantTurns += 1;
      }
      continue;
    }

    const parentId = subagentParentOf.get(sniffed.composerId);
    const parentFold = parentId ? folds.get(parentId) : undefined;
    if (!parentFold) {
      orphanedSubagentBubbles += parentId ? 1 : 0;
      orphanedBubbles += parentId ? 0 : 1;
      continue;
    }
    if (sniffed.kind === "unknown") {
      parentFold.unknownBubbles += 1;
      continue;
    }
    parentFold.subagentComposerIds.add(sniffed.composerId);
    parentFold.subagentTokensTotal += sniffed.inputTokens + sniffed.outputTokens;
    if (sniffed.kind === "user") {
      // A subagent's task instruction, not a human prompt — counted for
      // visibility, never an ai_prompt_submitted, never promptCount.
      parentFold.subagentPromptCount += 1;
    } else {
      parentFold.subagentAssistantTurns += 1;
    }
  }

  let windowOldest: string | null = null;
  let windowNewest: string | null = null;
  let sessionCount = 0;
  /** Sessions whose end timestamp came from a fallback, by source. */
  const derivedTimelines = new Map<CursorTimelineSource, number>();
  /** Composers no fallback could date — the loud version of the old silent
   * `continue`. Non-zero means conversations are missing from this import. */
  let sessionsWithoutTimeline = 0;

  for (const composerId of [...folds.keys()].sort()) {
    const fold = folds.get(composerId) as ComposerFold;
    const timeline = resolveTimeline(fold);
    if (timeline === null) {
      sessionsWithoutTimeline += 1;
      continue;
    }
    if (timeline.source !== "header") {
      derivedTimelines.set(timeline.source, (derivedTimelines.get(timeline.source) ?? 0) + 1);
    }
    const startedAt = new Date(fold.createdAtMs as number).toISOString();
    const endedAt = new Date(timeline.endedAtMs).toISOString();
    sessionCount += 1;
    if (!windowOldest || startedAt < windowOldest) windowOldest = startedAt;
    if (!windowNewest || endedAt > windowNewest) windowNewest = endedAt;

    const sourceVersion = pickTop(fold.bubbleVersions);

    for (const ts of fold.humanPromptTimestamps) {
      if (!ts) continue;
      yield {
        occurredAt: ts,
        store: "cursor",
        sourceVersion,
        sessionRef: fold.composerId,
        repoRef: fold.repoRef,
        eventKind: "ai_prompt_submitted",
        metrics: {},
        provenance: HISTORICAL_PROVENANCE.direct,
        extractionId
      };
    }

    const durationMs = sessionDurationMs(fold);
    const sessionMetrics: NormalizedHistoricalEvent["metrics"] = {
      promptCount: fold.humanPrompts,
      assistantTurns: fold.assistantTurns,
      inputTokens: fold.inputTokens,
      outputTokens: fold.outputTokens,
      linesAdded: fold.linesAdded,
      linesRemoved: fold.linesRemoved,
      filesChangedCount: fold.filesChangedCount,
      humanChangesCount: fold.humanChangesCount,
      approximateLintErrorsCount: fold.lintErrorsCount,
      durationBucket: durationBucketOf(fold),
      afterHoursPrompts: fold.afterHoursPrompts,
      unknownBubbles: fold.unknownBubbles,
      unparsedBubbles: fold.unparsedBubbles,
      modelCount: fold.models.size,
      subagentComposers: fold.subagentComposerIds.size,
      subagentPrompts: fold.subagentPromptCount,
      subagentAssistantTurns: fold.subagentAssistantTurns,
      subagentTokensTotal: fold.subagentTokensTotal,
      sessionStartedAt: startedAt
    };
    if (durationMs !== null) sessionMetrics.sessionMinutes = Math.round(durationMs / 60_000);
    if (fold.mode) sessionMetrics.mode = fold.mode;
    if (fold.contextUsagePercent !== null) {
      sessionMetrics.contextUsagePercent = Math.round(fold.contextUsagePercent * 100) / 100;
    }
    const primaryModel = pickTop(fold.models);
    if (primaryModel) sessionMetrics.primaryModel = primaryModel;
    if (fold.gitBranch) sessionMetrics.gitBranch = fold.gitBranch;

    yield {
      occurredAt: endedAt,
      store: "cursor",
      sourceVersion,
      sessionRef: fold.composerId,
      repoRef: fold.repoRef,
      eventKind: "create_focus_session",
      metrics: sessionMetrics,
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };

    if (fold.afterHoursPrompts > 0) {
      yield {
        occurredAt: endedAt,
        store: "cursor",
        sourceVersion,
        sessionRef: fold.composerId,
        repoRef: fold.repoRef,
        eventKind: "after_hours_ai_session",
        metrics: { afterHoursPrompts: fold.afterHoursPrompts },
        provenance: HISTORICAL_PROVENANCE.derived,
        extractionId
      };
    }
  }

  // As above: an unreadable store is a finding, not a reason to stay quiet.
  // Without this, a db that opens but whose rows no longer sniff renders as an
  // empty history rather than as a store nobody can read any more.
  // `sessionsWithoutTimeline` counts here too: a composer no fallback could
  // date is a conversation this import does not contain, which is precisely
  // the thing the marker exists to declare.
  const readFailures =
    unparsedComposerHeaders +
    unknownComposerHeaderTypes +
    orphanedSubagentBubbles +
    orphanedBubbles +
    sessionsWithoutTimeline;

  if ((windowOldest && windowNewest) || readFailures > 0) {
    const window: Record<string, string> =
      windowOldest && windowNewest ? { windowOldest, windowNewest } : {};
    yield {
      occurredAt: windowNewest ?? new Date().toISOString(),
      store: "cursor",
      sourceVersion: null,
      sessionRef: null,
      repoRef: null,
      eventKind: "extraction_epoch",
      metrics: {
        ...window,
        sessionCount,
        schemaUnreadable: 0,
        unparsedComposerHeaders,
        unknownComposerHeaderTypes,
        orphanedSubagentBubbles,
        orphanedBubbles,
        sessionsWithoutTimeline,
        sessionsFromBubbleTimeline: derivedTimelines.get("bubbles") ?? 0,
        sessionsFromRecencyTimeline: derivedTimelines.get("recency") ?? 0,
        sessionsFromCheckpointTimeline: derivedTimelines.get("checkpoint") ?? 0
      },
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };
  }
}
