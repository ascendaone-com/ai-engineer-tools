/**
 * Claude Code transcript extractor — first in the evaporation order.
 *
 * Store: `<snapshot>/projects/<project-slug>/<sessionId>.jsonl`, one JSON
 * object per line, PLUS `<snapshot>/projects/<project-slug>/<sessionId>/**\/*.jsonl`
 * — subagent (`Task` tool) transcripts. Nothing about that nesting is
 * documented upstream, so the walk is recursive rather than hardcoded to any
 * one directory name. A store's `.last-cleanup` purge can also remove a
 * top-level transcript while leaving its subagent directory behind, so a
 * session fold is seeded from whichever appears first and merged with
 * whichever appears second — never dropped for missing its sibling.
 *
 * Subagent lines carry the PARENT session's `sessionId` (`isSidechain: true`,
 * `agentId` set) — a subagent is not a session of its own. Its `user` lines
 * are the orchestrator's task instructions and its own tool-result
 * round-trips, never something a human typed, so none of them may become an
 * `ai_prompt_submitted` event or count toward `promptCount`. Its token spend,
 * tool failures and edits are still real work done in service of the parent
 * session, so those fold into the same session totals with a `subagent*`
 * breakdown alongside, so the merge is visible rather than silent.
 *
 * Key order varies per line type and `type` is often not the first key, so
 * nothing here greps — every line is JSON-parsed and dispatched on its
 * top-level `type`.
 *
 * The classification everything else rests on: most `user` lines are NOT
 * human prompts. Tool results come back on user-role lines (a `toolUseResult`
 * key, or a content array of `tool_result` items). Conflating the two inflates
 * every prompt metric by roughly an order of magnitude, so any change here
 * needs the fixtures in `tests/claudeCode.test.mjs` to stay green.
 *
 * Beyond the prompt/session/after-hours signals, this file also extracts:
 *  - **Compaction** (`system` lines, `subtype: "compact_boundary"`,
 *    `compactMetadata.trigger`): per-session counts, split manual/auto to
 *    match the live hooks' `context_compression_manual`/`_auto` vocabulary
 *    (`ascenda-claude-code-hooks/src/mapClaudeEvent.ts`).
 *  - **Failures**: `toolUseResult` tool-result content items with
 *    `is_error: true` (the authoritative marker — more reliable than
 *    string-sniffing `toolUseResult`'s text, which several tools skip) plus
 *    `system` lines with `subtype: "api_error"`. Collecting these matters
 *    because an imported baseline carrying no failure or compaction evidence
 *    reads downstream as "nothing went wrong" rather than "not collected".
 *  - **Context pressure**: per-assistant-turn `input_tokens +
 *    cache_read_input_tokens + cache_creation_input_tokens`, peak per
 *    session, expressed as a fraction of an assumed 200k-token window (see
 *    `ASSUMED_CONTEXT_WINDOW_TOKENS` for why that number is a documented
 *    approximation, not a fact the transcript records).
 *  - **Human-corrected edits**: `toolUseResult.userModified === true`.
 *  - **Lines changed**: `toolUseResult.structuredPatch[].lines`, counted
 *    (`+`/`-` prefixes) and discarded immediately — never retained as text.
 *  - **Correction cadence**: human prompts arriving <2 minutes after the
 *    previous one in the same session (a proxy for "that answer needed
 *    immediate correction", not idle thinking time).
 *  - **Abandoned prompts**: `queue-operation` `remove` entries whose content
 *    is not the synthetic `<task-notification>` wrapper — i.e. a human typed
 *    something into the queue and then deleted it before it sent. The prompt
 *    text itself is read only to check that one prefix and is never retained.
 *  - **Active minutes**: every known-line timestamp (main thread and
 *    subagents, merged) is gap-split at `ACTIVE_GAP_MS`, past which a gap is
 *    taken to be someone stepping away rather than thinking. Wall-clock
 *    `sessionMinutes` is idle-inflated for any session spanning hours;
 *    `activeMinutes` is the gap-split alternative.
 *
 * Emission (aggregate before shipping — never one event per line):
 *  - `ai_prompt_submitted` per HUMAN prompt (canonical type, so the existing
 *    demand/baseline readers count it natively), provenance historical_direct.
 *  - `create_focus_session` per session: counts, token totals, model mix,
 *    duration, compaction/failure/edit/context signals — provenance
 *    historical_derived.
 *  - `after_hours_ai_session` per session with ≥1 human prompt in the
 *    after-hours window (canonical type), provenance historical_derived.
 *  - `context_compression_manual` / `context_compression_auto` per session
 *    with ≥1 of that trigger (canonical types, aggregate — same "one event
 *    per session, count in the metric" shape as `after_hours_ai_session`, not
 *    one event per compaction).
 *  - `tool_failure` per session with ≥1 failure (canonical type, aggregate,
 *    same shape).
 *  - one `extraction_epoch` for the store's observed window. Local only:
 *    the shipper filters it out, since it describes the read rather than
 *    anyone's work and has no canonical catalog type.
 * Metrics carry counts, ids and timestamps only — never prompt/response text.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bucketDurationMs, bucketLinesChanged, isOutsideBusinessHours } from "@ascenda-one/tool-kit";
import { HISTORICAL_PROVENANCE, NormalizedHistoricalEvent } from "../types.js";

/** Line types the extractor reads fields from. */
export const KNOWN_CLAUDE_LINE_TYPES = [
  "user",
  "assistant",
  "attachment",
  "system",
  "queue-operation",
  "last-prompt",
  "custom-title"
] as const;
export type ClaudeLineType = (typeof KNOWN_CLAUDE_LINE_TYPES)[number];

/** Line types observed in real stores that carry nothing the import needs.
 * Recognised so they don't count as schema drift. */
export const META_CLAUDE_LINE_TYPES = new Set([
  "ai-title",
  "mode",
  "pr-link",
  "worktree-state",
  "relocated",
  "create",
  "file",
  "directory",
  "image",
  "file-history-snapshot",
  "summary"
]);

export type SniffedClaudeLine =
  | {
      kind: ClaudeLineType;
      sourceVersion: string | null;
      occurredAt: string | null;
      sessionId: string | null;
      model: string | null;
    }
  /** Valid JSON, string `type`, but not a type this extractor reads — a
   * known-meta line or a genuinely new one. Counted, never guessed at. */
  | { kind: "unknown"; type: string }
  /** Not JSON, not an object, or no string `type` — real schema drift. */
  | { kind: "unparsed"; raw: string };

export function sniffClaudeLine(line: string): SniffedClaudeLine {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "unparsed", raw: line };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "unparsed", raw: line };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unparsed", raw: line };
  }
  const record = parsed as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string") return { kind: "unparsed", raw: line };
  if (!(KNOWN_CLAUDE_LINE_TYPES as readonly string[]).includes(type)) {
    return { kind: "unknown", type };
  }
  const message = record.message as Record<string, unknown> | undefined;
  return {
    kind: type as ClaudeLineType,
    sourceVersion: typeof record.version === "string" ? record.version : null,
    occurredAt: typeof record.timestamp === "string" ? record.timestamp : null,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
    model: message && typeof message.model === "string" ? message.model : null
  };
}

/** A user-role line that is actually a tool result round-trip, not a person
 * typing. Two independent markers observed in real stores; either decides. */
export function isToolResultUserLine(record: Record<string, unknown>): boolean {
  if ("toolUseResult" in record) return true;
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    return content.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).type === "tool_result"
    );
  }
  return false;
}

/**
 * A tool-result round-trip that failed. `is_error: true` on the content
 * item is the authoritative marker — verified against string-sniffing
 * `toolUseResult`'s text instead (which several tools' error text doesn't
 * even start with "Error"): on a real store `is_error` catches 2,044 failures
 * against only 1,957 the string heuristic would, so the flag is read
 * directly rather than guessed at from formatting.
 */
export function isToolFailureLine(record: Record<string, unknown>): boolean {
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).type === "tool_result" &&
      (item as Record<string, unknown>).is_error === true
  );
}

/**
 * Net lines added/removed across an Edit tool's `structuredPatch` hunks.
 * Reads each hunk's `lines` array only to count `+`/`-` prefixes — the diff
 * text itself is never retained past this loop, matching the metrics-only
 * rule the rest of the extractor follows.
 */
function countChangedLines(structuredPatch: unknown[]): number {
  let count = 0;
  for (const hunk of structuredPatch) {
    if (typeof hunk !== "object" || hunk === null) continue;
    const lines = (hunk as Record<string, unknown>).lines;
    if (!Array.isArray(lines)) continue;
    for (const l of lines) {
      if (typeof l === "string" && (l.startsWith("+") || l.startsWith("-"))) count += 1;
    }
  }
  return count;
}

/** A `queue-operation` `remove` whose content is a human-typed prompt that
 * was deleted before it sent — as opposed to the synthetic
 * `<task-notification>` wrapper a background task's completion removes from
 * the queue. Only the prefix is inspected; the prompt text is never stored. */
function isAbandonedPromptRemoval(content: unknown): boolean {
  return typeof content === "string" && content.length > 0 && !content.startsWith("<task-notification>");
}

interface SessionFold {
  sessionId: string;
  projectSlug: string;
  cwd: string | null;
  gitBranch: string | null;
  sourceVersion: string | null;
  firstTs: string | null;
  lastTs: string | null;
  humanPrompts: number;
  afterHoursPrompts: number;
  assistantTurns: number;
  toolResults: number;
  queuedPrompts: number;
  unknownLines: number;
  unparsedLines: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  models: Map<string, number>;
  lastMainModel: string | null;
  modelSwitchCount: number;
  compactionCount: number;
  compactionManualCount: number;
  compactionAutoCount: number;
  toolResultErrorCount: number;
  apiErrorCount: number;
  contextWindowPeakTokens: number;
  userModifiedEditCount: number;
  linesChangedTotal: number;
  abandonedPromptCount: number;
  subagentTranscripts: number;
  subagentPrompts: number;
  subagentAssistantTurns: number;
  subagentTokensTotal: number;
  /** Epoch ms of every known-line timestamp, main thread and subagents
   * merged — the raw material for gap-split `activeMinutes`. Never shipped
   * itself, only the derived total. */
  timelinePoints: number[];
  /** Timestamps of HUMAN prompts only — the per-prompt events emitted later,
   * and the source for rapid-reprompt detection. Timestamps, never text. */
  humanPromptTimestamps: (string | null)[];
}

function newFold(sessionId: string, projectSlug: string): SessionFold {
  return {
    sessionId,
    projectSlug,
    cwd: null,
    gitBranch: null,
    sourceVersion: null,
    firstTs: null,
    lastTs: null,
    humanPrompts: 0,
    afterHoursPrompts: 0,
    assistantTurns: 0,
    toolResults: 0,
    queuedPrompts: 0,
    unknownLines: 0,
    unparsedLines: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    models: new Map(),
    lastMainModel: null,
    modelSwitchCount: 0,
    compactionCount: 0,
    compactionManualCount: 0,
    compactionAutoCount: 0,
    toolResultErrorCount: 0,
    apiErrorCount: 0,
    contextWindowPeakTokens: 0,
    userModifiedEditCount: 0,
    linesChangedTotal: 0,
    abandonedPromptCount: 0,
    subagentTranscripts: 0,
    subagentPrompts: 0,
    subagentAssistantTurns: 0,
    subagentTokensTotal: 0,
    timelinePoints: [],
    humanPromptTimestamps: []
  };
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Session wall-clock duration in ms, or null when the fold has no usable
 * timeline. Kept separate from bucketing so the exact minute count is
 * available for `sessionMinutes` alongside the bucket derived from it.
 */
function sessionDurationMs(fold: SessionFold): number | null {
  if (!fold.firstTs || !fold.lastTs) return null;
  const ms = Date.parse(fold.lastTs) - Date.parse(fold.firstTs);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Buckets via tool-kit's `bucketDurationMs` rather than a local re-derivation
 * of the same thresholds — this extractor used to run its own "0-5m" |
 * "5-30m" | "30m-2h" | "2-8h" | "8-24h" | "24h+" vocabulary, a third dialect
 * that matched neither the live collectors' tool-contract buckets nor the
 * backend's reader. Reusing the shared function makes that drift structurally
 * impossible instead of just documented.
 */
function durationBucketOf(fold: SessionFold): string {
  const ms = sessionDurationMs(fold);
  if (ms === null) return "unknown";
  return bucketDurationMs(ms) ?? "unknown";
}

/**
 * Gap-split active time: sum only the gaps between consecutive known-line
 * timestamps that are 5 minutes or less. The vast majority of consecutive-line
 * gaps are seconds long and the distribution thins out sharply past a few
 * minutes, so a gap past this threshold reads as "stepped away", not "reading
 * the response". A session spanning most of a day of wall clock is mostly idle
 * by this measure, which is the point: `sessionMinutes` (wall clock) stays
 * available for anyone who wants it, `activeMinutes` is the honest
 * alternative. Treat the threshold as a tuned default, not a measurement.
 */
const ACTIVE_GAP_MS = 5 * 60_000;

function activeMinutesOf(fold: SessionFold): number {
  if (fold.timelinePoints.length < 2) return 0;
  const sorted = [...fold.timelinePoints].sort((a, b) => a - b);
  let activeMs = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && gap <= ACTIVE_GAP_MS) activeMs += gap;
  }
  return Math.round(activeMs / 60_000);
}

/** A reprompt inside 2 minutes of the previous human prompt in the same
 * session — evidence the prior answer needed immediate correction rather
 * than the user having gone off to think. */
const RAPID_REPROMPT_MS = 2 * 60_000;

function rapidRepromptCountOf(fold: SessionFold): number {
  const timestamps = fold.humanPromptTimestamps.filter((t): t is string => t !== null);
  let count = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const gap = Date.parse(timestamps[i]) - Date.parse(timestamps[i - 1]);
    if (Number.isFinite(gap) && gap >= 0 && gap < RAPID_REPROMPT_MS) count += 1;
  }
  return count;
}

/**
 * Standard Claude API context window. A documented approximation, not a fact
 * the transcript records: a session running an extended/1M-token context
 * has a larger real window than this.
 *
 * **The clamp this function used to apply was not honest under-reporting —
 * it was signal destruction, and it was measured.** Clipping the ratio at
 * 1.0 made a 600k-token session and a 200k-token session report the
 * identical value, and on a real machine that collapsed 214 of 363 sessions
 * (59%) onto exactly 1.0. A field with no variance across the majority of
 * its observations carries no within-person information at all, which is
 * why the state engine excludes `contextWindowPeakPct` as an input.
 *
 * The ratio is still emitted uncapped for anyone who wants a rough
 * fraction, but `contextWindowPeakTokens` is the measured quantity and is
 * now carried through to the handoff so consumers can baseline against the
 * raw number instead of a ratio to an assumed denominator.
 */
const ASSUMED_CONTEXT_WINDOW_TOKENS = 200_000;

function contextWindowPeakPctOf(fold: SessionFold): number {
  if (fold.contextWindowPeakTokens <= 0) return 0;
  const pct = fold.contextWindowPeakTokens / ASSUMED_CONTEXT_WINDOW_TOKENS;
  return Math.round(pct * 1000) / 1000;
}

/**
 * Fold one transcript file's lines into an existing fold. Called once for a
 * session's primary transcript (`isSidechain: false`) and once per subagent
 * transcript found under its directory (`isSidechain: true`) — the same fold
 * accumulates both, because a subagent's work happened in service of the one
 * session a human was driving, even though its `user` lines are never a
 * human prompt.
 */
async function foldLinesInto(
  fold: SessionFold,
  filePath: string,
  opts: { isSidechain: boolean }
): Promise<void> {
  // Transcripts run to hundreds of MB; read line-wise, never whole-file.
  const handle = await fs.open(filePath);
  try {
    for await (const line of handle.readLines({ encoding: "utf8" })) {
      const sniffed = sniffClaudeLine(line);
      if (sniffed.kind === "unparsed") {
        if (line.trim() !== "") fold.unparsedLines += 1;
        continue;
      }
      if (sniffed.kind === "unknown") {
        fold.unknownLines += 1;
        continue;
      }
      // Trust the store's own id over the filename when they disagree — main
      // thread only. A subagent's own sessionId already equals its parent's,
      // so correcting off it here could only ever be a no-op or a mistake.
      if (!opts.isSidechain && sniffed.sessionId && fold.sessionId !== sniffed.sessionId) {
        fold.sessionId = sniffed.sessionId;
      }
      if (sniffed.sourceVersion) fold.sourceVersion = sniffed.sourceVersion;
      if (sniffed.occurredAt) {
        if (!fold.firstTs || sniffed.occurredAt < fold.firstTs) fold.firstTs = sniffed.occurredAt;
        if (!fold.lastTs || sniffed.occurredAt > fold.lastTs) fold.lastTs = sniffed.occurredAt;
        const ms = Date.parse(sniffed.occurredAt);
        if (Number.isFinite(ms)) fold.timelinePoints.push(ms);
      }
      switch (sniffed.kind) {
        case "user": {
          // Re-parse is cheap relative to disk; the sniffer deliberately does
          // not carry the whole record.
          const record = JSON.parse(line) as Record<string, unknown>;
          if (typeof record.cwd === "string" && !fold.cwd) fold.cwd = record.cwd;
          if (typeof record.gitBranch === "string" && !fold.gitBranch) {
            fold.gitBranch = record.gitBranch;
          }
          if (isToolFailureLine(record)) fold.toolResultErrorCount += 1;
          if (isToolResultUserLine(record)) {
            fold.toolResults += 1;
            const tur = record.toolUseResult;
            if (tur && typeof tur === "object" && !Array.isArray(tur)) {
              const turRecord = tur as Record<string, unknown>;
              if (turRecord.userModified === true) fold.userModifiedEditCount += 1;
              if (Array.isArray(turRecord.structuredPatch)) {
                fold.linesChangedTotal += countChangedLines(turRecord.structuredPatch);
              }
            }
          } else if (opts.isSidechain) {
            // A subagent's task instruction — not a tool round-trip, and not
            // something a human typed either. Counted so it's visible, never
            // folded into promptCount.
            fold.subagentPrompts += 1;
          } else {
            fold.humanPrompts += 1;
            if (sniffed.occurredAt && isOutsideBusinessHours(new Date(sniffed.occurredAt))) {
              fold.afterHoursPrompts += 1;
            }
            fold.humanPromptTimestamps.push(sniffed.occurredAt);
          }
          break;
        }
        case "assistant": {
          const record = JSON.parse(line) as Record<string, unknown>;
          const usage = (record.message as Record<string, unknown> | undefined)?.usage as
            | Record<string, unknown>
            | undefined;
          if (opts.isSidechain) {
            fold.subagentAssistantTurns += 1;
            if (usage) {
              fold.subagentTokensTotal +=
                asNumber(usage.input_tokens) +
                asNumber(usage.output_tokens) +
                asNumber(usage.cache_read_input_tokens);
            }
            break;
          }
          fold.assistantTurns += 1;
          if (sniffed.model) {
            fold.models.set(sniffed.model, (fold.models.get(sniffed.model) ?? 0) + 1);
            if (fold.lastMainModel && fold.lastMainModel !== sniffed.model) {
              fold.modelSwitchCount += 1;
            }
            fold.lastMainModel = sniffed.model;
          }
          if (usage) {
            fold.inputTokens += asNumber(usage.input_tokens);
            fold.outputTokens += asNumber(usage.output_tokens);
            fold.cacheReadTokens += asNumber(usage.cache_read_input_tokens);
            const contextTokens =
              asNumber(usage.input_tokens) +
              asNumber(usage.cache_read_input_tokens) +
              asNumber(usage.cache_creation_input_tokens);
            if (contextTokens > fold.contextWindowPeakTokens) fold.contextWindowPeakTokens = contextTokens;
          }
          break;
        }
        case "system": {
          // Not observed inside subagent transcripts on the verified store
          // (compaction and api_error both live on the main thread only),
          // but nothing here assumes that stays true — it just naturally
          // folds into the same session counters if it ever does.
          const record = JSON.parse(line) as Record<string, unknown>;
          if (record.subtype === "compact_boundary") {
            fold.compactionCount += 1;
            const trigger = (record.compactMetadata as Record<string, unknown> | undefined)?.trigger;
            if (trigger === "manual") fold.compactionManualCount += 1;
            else if (trigger === "auto") fold.compactionAutoCount += 1;
          } else if (record.subtype === "api_error") {
            fold.apiErrorCount += 1;
          }
          break;
        }
        case "queue-operation": {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (record.operation === "enqueue") {
            fold.queuedPrompts += 1;
          } else if (record.operation === "remove" && isAbandonedPromptRemoval(record.content)) {
            fold.abandonedPromptCount += 1;
          }
          break;
        }
        default:
          break; // attachment / last-prompt / custom-title: window only.
      }
    }
  } finally {
    await handle.close();
  }
}

async function foldTranscript(filePath: string, projectSlug: string): Promise<SessionFold> {
  const fold = newFold(path.basename(filePath, ".jsonl"), projectSlug);
  await foldLinesInto(fold, filePath, { isSidechain: false });
  return fold;
}

/** Recursively collects every `.jsonl` file under `root`, depth-first,
 * sorted for determinism. Not hardcoded to `subagents/` — nothing about that
 * nesting is documented, so this walks whatever is actually there rather
 * than assuming today's layout survives the next Claude Code release. */
async function walkJsonlFiles(root: string): Promise<{ files: string[]; otherFiles: number }> {
  const out: string[] = [];
  let otherFiles = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
      } else if (entry.isFile()) {
        otherFiles += 1;
      }
    }
  }
  await walk(root);
  return { files: out, otherFiles };
}

function topModel(models: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [model, count] of models) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

export async function* extractClaudeCode(
  snapshotDir: string,
  extractionId: string
): AsyncIterable<NormalizedHistoricalEvent> {
  const projectsDir = path.join(snapshotDir, "projects");
  let projectSlugs: string[] = [];
  try {
    projectSlugs = (await fs.readdir(projectsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return; // No projects dir in the snapshot — nothing to extract.
  }

  let windowOldest: string | null = null;
  let windowNewest: string | null = null;
  let sessionCount = 0;
  // Projects holding files but no readable transcript at all.
  //
  // A first attempt counted every non-`.jsonl` file, which read 449 on a
  // healthy store: `memory/*.md`, `agent-*.meta.json`, `toolu_*.txt`, fetched
  // PDFs. A counter that is permanently non-zero is one nobody reads, so it
  // detects nothing. This asks the question that actually matters instead —
  // is there a project whose transcripts we can no longer read? — which is
  // shape-based rather than a guess at what the next format will be called,
  // so an entirely novel encoding trips it just as well as a known one.
  //
  // This fires on real stores: a session directory whose `tool-results/`
  // sidecars outlived the transcript the 30-day purge took. That is a true
  // positive, and the reason the counter is worth having.
  let projectsWithNoReadableTranscript = 0;

  for (const slug of projectSlugs.sort()) {
    const dir = path.join(projectsDir, slug);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const topLevelFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name)
      .sort();
    let slugJsonlFiles = topLevelFiles.length;
    let slugOtherFiles = entries.filter((e) => e.isFile() && !e.name.endsWith(".jsonl")).length;
    const sessionDirNames = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    // Keyed by the top-level filename's own basename — which is also the
    // directory-naming convention subagent transcripts nest under — so a
    // merge never depends on a session correcting its own id mid-file.
    const foldsByKey = new Map<string, SessionFold>();

    for (const name of topLevelFiles) {
      const fold = await foldTranscript(path.join(dir, name), slug);
      foldsByKey.set(path.basename(name, ".jsonl"), fold);
    }

    for (const sessionDirName of sessionDirNames) {
      const nested = await walkJsonlFiles(path.join(dir, sessionDirName));
      const nestedFiles = nested.files;
      slugJsonlFiles += nestedFiles.length;
      slugOtherFiles += nested.otherFiles;
      if (nestedFiles.length === 0) continue;
      let fold = foldsByKey.get(sessionDirName);
      if (!fold) {
        // The top-level transcript evaporated (purge) but its subagent
        // directory survived — still worth a fold rather than a silent skip.
        fold = newFold(sessionDirName, slug);
        foldsByKey.set(sessionDirName, fold);
      }
      for (const nestedPath of nestedFiles) {
        fold.subagentTranscripts += 1;
        await foldLinesInto(fold, nestedPath, { isSidechain: true });
      }
    }

    // Files here, but nothing this extractor can read as a transcript.
    if (slugJsonlFiles === 0 && slugOtherFiles > 0) projectsWithNoReadableTranscript += 1;

    for (const fold of foldsByKey.values()) {
      // A fold with no usable timeline is unusable regardless of its
      // contents.
      if (!fold.firstTs || !fold.lastTs) continue;
      sessionCount += 1;
      if (!windowOldest || fold.firstTs < windowOldest) windowOldest = fold.firstTs;
      if (!windowNewest || fold.lastTs > windowNewest) windowNewest = fold.lastTs;

      for (const ts of fold.humanPromptTimestamps) {
        if (!ts) continue;
        yield {
          occurredAt: ts,
          store: "claude_code",
          sourceVersion: fold.sourceVersion,
          sessionRef: fold.sessionId,
          repoRef: fold.cwd ?? fold.projectSlug,
          eventKind: "ai_prompt_submitted",
          metrics: {},
          provenance: HISTORICAL_PROVENANCE.direct,
          extractionId
        };
      }

      const durationMs = sessionDurationMs(fold);
      const toolFailureCount = fold.toolResultErrorCount + fold.apiErrorCount;
      const sessionMetrics: NormalizedHistoricalEvent["metrics"] = {
        promptCount: fold.humanPrompts,
        assistantTurns: fold.assistantTurns,
        toolResultCount: fold.toolResults,
        queuedPrompts: fold.queuedPrompts,
        inputTokens: fold.inputTokens,
        outputTokens: fold.outputTokens,
        cacheReadTokens: fold.cacheReadTokens,
        durationBucket: durationBucketOf(fold),
        afterHoursPrompts: fold.afterHoursPrompts,
        unknownLines: fold.unknownLines,
        unparsedLines: fold.unparsedLines,
        modelCount: fold.models.size,
        modelSwitchCount: fold.modelSwitchCount,
        compactionCount: fold.compactionCount,
        compactionManualCount: fold.compactionManualCount,
        compactionAutoCount: fold.compactionAutoCount,
        toolResultErrorCount: fold.toolResultErrorCount,
        apiErrorCount: fold.apiErrorCount,
        toolFailureCount,
        contextWindowPeakTokens: fold.contextWindowPeakTokens,
        contextWindowPeakPct: contextWindowPeakPctOf(fold),
        userModifiedEditCount: fold.userModifiedEditCount,
        linesChanged: fold.linesChangedTotal,
        linesChangedBucket: bucketLinesChanged(fold.linesChangedTotal),
        rapidRepromptCount: rapidRepromptCountOf(fold),
        abandonedPromptCount: fold.abandonedPromptCount,
        activeMinutes: activeMinutesOf(fold),
        subagentTranscripts: fold.subagentTranscripts,
        subagentPrompts: fold.subagentPrompts,
        subagentAssistantTurns: fold.subagentAssistantTurns,
        subagentTokensTotal: fold.subagentTokensTotal
      };
      // Exact minutes, not just the bucket — the backend's SessionMinutesPerDay
      // reader prefers an explicit `sessionMinutes` metric over deriving a
      // bucket midpoint, so ship the real number when the timeline gives it.
      if (durationMs !== null) sessionMetrics.sessionMinutes = Math.round(durationMs / 60_000);
      sessionMetrics.sessionStartedAt = fold.firstTs;
      const primaryModel = topModel(fold.models);
      if (primaryModel) sessionMetrics.primaryModel = primaryModel;
      if (fold.gitBranch) sessionMetrics.gitBranch = fold.gitBranch;
      yield {
        occurredAt: fold.lastTs,
        store: "claude_code",
        sourceVersion: fold.sourceVersion,
        sessionRef: fold.sessionId,
        repoRef: fold.cwd ?? fold.projectSlug,
        eventKind: "create_focus_session",
        metrics: sessionMetrics,
        provenance: HISTORICAL_PROVENANCE.derived,
        extractionId
      };

      if (fold.afterHoursPrompts > 0) {
        yield {
          occurredAt: fold.lastTs,
          store: "claude_code",
          sourceVersion: fold.sourceVersion,
          sessionRef: fold.sessionId,
          repoRef: fold.cwd ?? fold.projectSlug,
          eventKind: "after_hours_ai_session",
          metrics: { afterHoursPrompts: fold.afterHoursPrompts },
          provenance: HISTORICAL_PROVENANCE.derived,
          extractionId
        };
      }

      // Aggregate per session, same shape as after_hours_ai_session above —
      // never one event per compaction/failure. Canonical event names so
      // these ride the existing catalog rather than living only inside
      // create_focus_session's metrics bag.
      if (fold.compactionManualCount > 0) {
        yield {
          occurredAt: fold.lastTs,
          store: "claude_code",
          sourceVersion: fold.sourceVersion,
          sessionRef: fold.sessionId,
          repoRef: fold.cwd ?? fold.projectSlug,
          eventKind: "context_compression_manual",
          metrics: { compactionCount: fold.compactionManualCount },
          provenance: HISTORICAL_PROVENANCE.derived,
          extractionId
        };
      }
      if (fold.compactionAutoCount > 0) {
        yield {
          occurredAt: fold.lastTs,
          store: "claude_code",
          sourceVersion: fold.sourceVersion,
          sessionRef: fold.sessionId,
          repoRef: fold.cwd ?? fold.projectSlug,
          eventKind: "context_compression_auto",
          metrics: { compactionCount: fold.compactionAutoCount },
          provenance: HISTORICAL_PROVENANCE.derived,
          extractionId
        };
      }
      if (toolFailureCount > 0) {
        yield {
          occurredAt: fold.lastTs,
          store: "claude_code",
          sourceVersion: fold.sourceVersion,
          sessionRef: fold.sessionId,
          repoRef: fold.cwd ?? fold.projectSlug,
          eventKind: "tool_failure",
          metrics: {
            toolFailureCount,
            toolResultErrorCount: fold.toolResultErrorCount,
            apiErrorCount: fold.apiErrorCount
          },
          provenance: HISTORICAL_PROVENANCE.derived,
          extractionId
        };
      }
    }
  }

  // A store that yielded nothing readable still has something to report. The
  // window guard alone suppressed the epoch in exactly that case, so a store
  // this extractor could no longer read produced no diagnostic at all —
  // silence indistinguishable from "you did no work". Emit whenever there is
  // either a window or a read failure to declare.
  if ((windowOldest && windowNewest) || projectsWithNoReadableTranscript > 0) {
    const window: Record<string, string> =
      windowOldest && windowNewest ? { windowOldest, windowNewest } : {};
    yield {
      // No window means nothing datable was read; the only honest timestamp
      // left is when the read happened.
      occurredAt: windowNewest ?? new Date().toISOString(),
      store: "claude_code",
      sourceVersion: null,
      sessionRef: null,
      repoRef: null,
      eventKind: "extraction_epoch",
      metrics: {
        ...window,
        sessionCount,
        projectsWithNoReadableTranscript
      },
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };
  }
}
