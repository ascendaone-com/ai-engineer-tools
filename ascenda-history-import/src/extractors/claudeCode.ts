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
 * Older Claude Code wrote those flat instead, as `<project>/agent-<id>.jsonl`.
 * A top-level file is a subagent transcript when its lines say so
 * (`isSidechain: true` or an `agentId`), whatever it is called, and it folds
 * into the session named by its `sessionId` like the nested ones do.
 *
 * Lines written by the Agent SDK or a headless run carry an `entrypoint`
 * starting `sdk`. Nobody typed them, so they are counted in
 * `headlessPromptLines` and not as prompts.
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
 *    `compactMetadata.trigger`): per-session counts plus one event per boundary, split manual/auto to
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
 *  - **Tool calls**: `tool_use` content items on `assistant` lines — the
 *    ISSUED side, matched to the live hooks' `PreToolUse` →
 *    `ai_tool_call_started` mapping rather than to the completed side this
 *    file already counts as `toolResultCount`. Two reasons, both about the
 *    rail these feed: the backend's tool-call count prefers
 *    `ai_tool_call_started` and only falls back to completed/failed, so
 *    counting the other side would put historical and live days on different
 *    code paths; and the issuing line carries the instant the call was made,
 *    which is the one an hourly demand rail wants. Emitted as one event per
 *    call, not as a metric, because the rail counts rows of that type and
 *    reads no `toolCallCount` key off anything.
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
 * A main-thread `user` line that isn't a tool result is still not always a
 * prompt: the runtime writes notifications, its own bookkeeping, slash-command
 * wrappers and interrupt markers on that role too. `isTypedPromptLine` in
 * `interruptedRuns.ts` declines them, and `syntheticPromptLines` counts what
 * it declined.
 *
 * Two more rules need the whole store, so `promptLedger.ts` reads it once
 * before any session is folded. A resumed transcript copies its ancestors'
 * lines, so each typed line (by `uuid`) is counted by one transcript only. And
 * a session opened from a chip starts on the chip's prompt, which nobody typed,
 * so that line is counted in `dispatchedPromptLines` and not as a prompt.
 *
 * Emission (aggregate before shipping — never one event per line):
 *  - `ai_prompt_submitted` per HUMAN prompt (canonical type, so the existing
 *    demand/baseline readers count it natively), provenance historical_direct.
 *  - `create_focus_session` per session: counts, token totals, model mix,
 *    duration, compaction/failure/edit/context signals — provenance
 *    historical_derived.
 *  - `after_hours_ai_session` per session with ≥1 human prompt in the
 *    after-hours window (canonical type), provenance historical_derived.
 *  - `context_compression_manual` / `context_compression_auto`, one per
 *    `compact_boundary` line, stamped at that line's own timestamp with
 *    `compactionCount: 1` and a 1-based `compactionOrdinal` within the
 *    session. Earlier builds wrote one row per session and trigger at the
 *    session's last timestamp; see `compactionOrdinal` in the metric registry
 *    for how a reader tells the two apart.
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
import { sanitizeToolName } from "../toolName.js";
import { sliceSessionByLocalDay } from "../daySlice.js";
import {
  DEFAULT_ACTIVE_GAP_MS,
  activeSpans,
  minutesOf,
  snakeCasePermissionMode,
  splitActiveTime,
  type ActiveInstant
} from "../activeSplit.js";
import { isTypedPromptLine, stepRun } from "../interruptedRuns.js";
import {
  PromptLedger,
  TimelineOwnership,
  readPromptLedger,
  resolveContestedOwners
} from "../promptLedger.js";

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

/**
 * Line types observed in real stores that carry nothing the import needs.
 * Recognised so they don't count as schema drift: they sniff as `meta` and
 * land in `metaLines`, leaving `unknownLines` to mean a type nobody has
 * classified yet — which is the only kind worth alerting on.
 *
 * This set was declared and exported for some time without ever being read,
 * so the comment above described an intention rather than the code: every
 * `mode` and `ai-title` line counted as drift. Adding a type here is a claim
 * that the import needs nothing from it; a type NOT here that starts
 * appearing is supposed to show up in `unknownLines` and be looked at.
 */
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
      /** The line's own id, which a copy keeps. Read here so line ownership
       * costs no second parse of lines the fold never re-parses. */
      uuid: string | null;
      sessionId: string | null;
      model: string | null;
    }
  /** A line type this extractor deliberately ignores: recognised, carrying
   * nothing the import needs. Kept out of `unknownLines` so that number means
   * what it claims — types nobody has classified yet — rather than being
   * dominated by `mode` and `ai-title` lines every real store is full of. */
  | { kind: "meta"; type: string }
  /** Valid JSON, string `type`, but neither read nor recognised — a genuinely
   * new type. This is the drift signal. Counted, never guessed at. */
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
    return META_CLAUDE_LINE_TYPES.has(type)
      ? { kind: "meta", type }
      : { kind: "unknown", type };
  }
  const message = record.message as Record<string, unknown> | undefined;
  return {
    kind: type as ClaudeLineType,
    sourceVersion: typeof record.version === "string" ? record.version : null,
    occurredAt: typeof record.timestamp === "string" ? record.timestamp : null,
    uuid: typeof record.uuid === "string" ? record.uuid : null,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
    model: message && typeof message.model === "string" ? message.model : null
  };
}

/**
 * Claude Code writes some of its OWN notices as assistant lines, under the
 * literal model string `<synthetic>` — "No response requested", plan-limit
 * hits ("You've hit your limit · resets …"), sleep-drop and connection-loss
 * notices, and 529 overloads. The runtime produced them, not a model: their
 * `usage` block is present and every figure in it is zero.
 *
 * On one real store of 852 transcripts these are 345 of 300,221 assistant
 * lines — 0.1%, but concentrated, and the damage is out of proportion to the
 * count. 143 sessions carry at least one:
 *
 *  - `primaryModel`: on that store `<synthetic>` already wins one session
 *    outright, which is enough. The session's dominant model would then be
 *    reported as a string that is not a model, and `classifyModelClass` files
 *    it as bare `unknown` — the same value a garbage string gets and
 *    indistinguishable from one, which is the collapse the classifier's
 *    vendor-first rule exists to prevent.
 *  - `modelSwitchCount`: a notice interrupting a run reads as two switches,
 *    out and back. 1,232 switches on that store become 743 once these are
 *    excluded — 40% of the signal was the runtime clearing its throat.
 *  - `modelCount`: a session that ran on one model reports two.
 *
 * The exclusion lives here and not in `sniffClaudeLine`, which stays a
 * faithful read of what the line says: `<synthetic>` IS the string in the
 * file, and the judgement that it names no model belongs to the fold that
 * interprets it.
 *
 * A notice turn carries NO model. It does not carry an unknown one — absent
 * and unknown are different facts, both are typed downstream, and folding
 * these lines in would report the second when the first is true.
 */
export const SYNTHETIC_CLAUDE_MODEL = "<synthetic>";

/**
 * The model a fold should attribute an assistant line to: the reported
 * identifier, or `null` where the line names no model at all — absent, empty,
 * or the runtime's `<synthetic>` placeholder.
 */
export function foldableModelOf(model: string | null): string | null {
  if (!model || model === SYNTHETIC_CLAUDE_MODEL) return null;
  return model;
}

/**
 * Whether a `user` line was written by a program rather than typed: the Agent
 * SDK (`sdk-ts`, `sdk-py`) and headless runs (`sdk-cli`) stamp their
 * `entrypoint` on every line. `userType` is not read. It says `external` for
 * ordinary terminal sessions too, so it cannot tell the two apart.
 */
export function isHeadlessEntrypoint(record: Record<string, unknown>): boolean {
  const entrypoint = record.entrypoint;
  return typeof entrypoint === "string" && entrypoint.toLowerCase().startsWith("sdk");
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
 * Tool names of the `tool_use` content items on one assistant line, in the
 * order the model issued them. A line usually carries one; a parallel batch
 * carries several and they share the line's single timestamp.
 *
 * Only the name is read. `input` holds the call's arguments — file paths,
 * shell commands, prompt text — and is never touched, in keeping with the
 * metrics-only rule the rest of this file follows.
 */
export function toolUseNamesOf(record: Record<string, unknown>): string[] {
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== "tool_use") continue;
    names.push(sanitizeToolName(typeof entry.name === "string" ? entry.name : undefined));
  }
  return names;
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
  /** Main-thread `user` lines the runtime wrote on the person's behalf, left
   * out of `humanPrompts`. See `isTypedPromptLine`. */
  syntheticPromptLines: number;
  /** Main-thread lines that pass `isTypedPromptLine` but are a chip's prompt,
   * left out of `humanPrompts`. Counted once per line, like a prompt. See
   * `promptLedger.ts`. */
  dispatchedPromptLines: number;
  afterHoursPrompts: number;
  assistantTurns: number;
  toolResults: number;
  queuedPrompts: number;
  unknownLines: number;
  metaLines: number;
  unparsedLines: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Cache-write tokens, summed once per API message like the others. Only
   * shipped once a line has carried the field, so a store that never wrote it
   * reads as not collected rather than as zero. */
  cacheCreationTokens: number;
  cacheCreationSeen: boolean;
  /** The 5-minute and 1-hour halves of the cache writes, from
   * `usage.cache_creation`. Absent on older transcripts, which only have the
   * total. */
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cacheCreationSplitSeen: boolean;
  /** Advisor calls (`usage.iterations[]` of type `advisor_message`): a second
   * model consulted inside one API message. Their tokens are NOT in the
   * message's own `usage` totals, so they are added to the totals above and
   * counted here as well, so the share they contribute stays visible. */
  advisorMessageCount: number;
  advisorTokensTotal: number;
  /** Main-thread `user` lines an SDK or headless entrypoint wrote. Counted
   * once per line, like a prompt, and left out of `humanPrompts`. */
  headlessPromptLines: number;
  models: Map<string, number>;
  lastMainModel: string | null;
  modelSwitchCount: number;
  compactionCount: number;
  compactionManualCount: number;
  compactionAutoCount: number;
  /** Each compact_boundary line, in file order, at its own instant. `at` is
   * null for a line with no readable timestamp. */
  compactions: { at: string | null; trigger: "manual" | "auto" | null }[];
  toolResultErrorCount: number;
  apiErrorCount: number;
  contextWindowPeakTokens: number;
  userModifiedEditCount: number;
  linesChangedTotal: number;
  abandonedPromptCount: number;
  toolCallCount: number;
  subagentTranscripts: number;
  subagentPrompts: number;
  subagentAssistantTurns: number;
  subagentTokensTotal: number;
  subagentToolCallCount: number;
  /**
   * The token figures each API message has added so far, by `messageKeyOf`,
   * main thread and subagents in one map. The runtime writes one message over
   * several `assistant` lines (thinking, text, each `tool_use`), and every
   * line repeats the message's `usage`; only the last carries the final
   * `output_tokens`. Summing per line counted a session's tokens about 2.2x
   * on the store this was measured on (11,059 lines, 5,173 messages). A line
   * of a message already seen replaces what that message added instead of
   * adding to it, so the last line wins whichever order it arrives in.
   */
  messageTokens: Map<string, MessageUsage>;
  /**
   * One entry per `tool_use` item, main thread and subagents merged — the
   * raw material for the per-call events. Merged because the demand rail
   * counts events and a subagent's `Bash` call is as real a demand on the
   * machine as the orchestrator's; the split stays visible in the two
   * counters above, exactly as `subagentAssistantTurns` splits turns.
   */
  toolCalls: { at: string; name: string }[];
  /** Every known-line timestamp, main thread and subagents merged, each
   * carrying whether a person wrote it, whether the agent side of the runtime
   * produced it, and what permission posture was declared there — the raw
   * material for gap-split `activeMinutes` AND for the hands-on/agent-
   * supervising split, which must be computed off the same instants or they
   * cannot partition each other. Never shipped itself, only the derived
   * totals. */
  timelinePoints: ActiveInstant[];
  /** Known lines whose `timestamp` the runtime wrote but `Date.parse` could
   * not read. They are absent from `timelinePoints`, so both active figures
   * are short by an unknown amount and only this says so. */
  undatedTimelineLines: number;
  /** Dated known lines this transcript holds a copy of and another fold owns
   * (`TimelineOwnership`). They are absent from `timelinePoints` on purpose.
   * A fold where this is the only thing the file held is a pure copy, and the
   * emit loop counts it as unusable. */
  inheritedTimelineLines: number;
  /** Timestamps of HUMAN prompts only — the per-prompt events emitted later,
   * and the source for rapid-reprompt detection. Timestamps, never text. Only
   * the prompts this transcript owns (`promptLedger.ts`): a prompt a resumed
   * transcript copied from its ancestor is its ancestor's. */
  humanPromptTimestamps: (string | null)[];
  /** Runs the person cut short, main thread only. See `interruptedRuns.ts`. */
  interruptedRuns: number;
  /** When each of those cuts happened, for the day slices. Never shipped. */
  interruptedRunTimestamps: (string | null)[];
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
    syntheticPromptLines: 0,
    dispatchedPromptLines: 0,
    afterHoursPrompts: 0,
    assistantTurns: 0,
    toolResults: 0,
    queuedPrompts: 0,
    unknownLines: 0,
    metaLines: 0,
    unparsedLines: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreationSeen: false,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheCreationSplitSeen: false,
    advisorMessageCount: 0,
    advisorTokensTotal: 0,
    headlessPromptLines: 0,
    models: new Map(),
    lastMainModel: null,
    modelSwitchCount: 0,
    compactionCount: 0,
    compactionManualCount: 0,
    compactionAutoCount: 0,
    compactions: [],
    toolResultErrorCount: 0,
    apiErrorCount: 0,
    contextWindowPeakTokens: 0,
    userModifiedEditCount: 0,
    linesChangedTotal: 0,
    abandonedPromptCount: 0,
    toolCallCount: 0,
    subagentTranscripts: 0,
    subagentPrompts: 0,
    subagentAssistantTurns: 0,
    subagentTokensTotal: 0,
    subagentToolCallCount: 0,
    messageTokens: new Map(),
    toolCalls: [],
    timelinePoints: [],
    undatedTimelineLines: 0,
    inheritedTimelineLines: 0,
    humanPromptTimestamps: [],
    interruptedRuns: 0,
    interruptedRunTimestamps: []
  };
}

/** What one API message has added to the totals, at the latest line seen. */
interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  /** Advisor iterations: how many, their tokens, and which models ran them. */
  advisor: {
    count: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    models: Map<string, number>;
  };
}

/** What a line's `usage` says, read loosely: every field may be missing, and
 * `iterations[].model` may be null. */
export function readMessageUsage(usage: Record<string, unknown> | undefined): {
  usage: MessageUsage;
  hasCacheCreation: boolean;
  hasCacheCreationSplit: boolean;
} {
  const out: MessageUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    advisor: { count: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, models: new Map() }
  };
  if (!usage) return { usage: out, hasCacheCreation: false, hasCacheCreationSplit: false };
  out.input = asNumber(usage.input_tokens);
  out.output = asNumber(usage.output_tokens);
  out.cacheRead = asNumber(usage.cache_read_input_tokens);
  out.cacheCreation = asNumber(usage.cache_creation_input_tokens);
  const split = usage.cache_creation;
  const splitRecord =
    typeof split === "object" && split !== null && !Array.isArray(split)
      ? (split as Record<string, unknown>)
      : null;
  const hasSplit =
    splitRecord !== null &&
    (typeof splitRecord.ephemeral_5m_input_tokens === "number" ||
      typeof splitRecord.ephemeral_1h_input_tokens === "number");
  if (splitRecord) {
    out.cacheCreation5m = asNumber(splitRecord.ephemeral_5m_input_tokens);
    out.cacheCreation1h = asNumber(splitRecord.ephemeral_1h_input_tokens);
    if (out.cacheCreation === 0) out.cacheCreation = out.cacheCreation5m + out.cacheCreation1h;
  }
  if (Array.isArray(usage.iterations)) {
    for (const item of usage.iterations) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (entry.type !== "advisor_message") continue;
      out.advisor.count += 1;
      out.advisor.input += asNumber(entry.input_tokens);
      out.advisor.output += asNumber(entry.output_tokens);
      out.advisor.cacheRead += asNumber(entry.cache_read_input_tokens);
      out.advisor.cacheCreation += asNumber(entry.cache_creation_input_tokens);
      const model = foldableModelOf(typeof entry.model === "string" ? entry.model : null);
      if (model) out.advisor.models.set(model, (out.advisor.models.get(model) ?? 0) + 1);
    }
  }
  return {
    usage: out,
    hasCacheCreation: typeof usage.cache_creation_input_tokens === "number" || hasSplit,
    hasCacheCreationSplit: hasSplit
  };
}

/**
 * Which API message a line belongs to: `message.id` with the line's
 * `requestId`. Every line of one message shares both. The request id keeps a
 * proxy that writes one placeholder id on every message from folding them all
 * into one; it's left off when a line doesn't carry one.
 */
export function messageKeyOf(record: Record<string, unknown>): string | null {
  const id = (record.message as Record<string, unknown> | undefined)?.id;
  if (typeof id !== "string" || id === "") return null;
  return typeof record.requestId === "string" && record.requestId !== "" ? `${id}|${record.requestId}` : id;
}

/**
 * Fold one `assistant` line's usage into the fold's per-message figures and
 * return what the totals should move by. A line with no `message.id` is a
 * message of its own. `firstLine` is false for a further line of a message
 * the fold has already met, so the caller counts that message's turn once.
 */
function foldMessageUsage(
  fold: SessionFold,
  messageId: string | null,
  now: MessageUsage
): { delta: MessageUsage; firstLine: boolean } {
  if (messageId === null) return { delta: now, firstLine: true };
  const before = fold.messageTokens.get(messageId);
  fold.messageTokens.set(messageId, now);
  if (!before) return { delta: now, firstLine: true };
  const models = new Map<string, number>();
  for (const [model, count] of now.advisor.models) {
    const more = count - (before.advisor.models.get(model) ?? 0);
    if (more > 0) models.set(model, more);
  }
  return {
    delta: {
      input: now.input - before.input,
      output: now.output - before.output,
      cacheRead: now.cacheRead - before.cacheRead,
      cacheCreation: now.cacheCreation - before.cacheCreation,
      cacheCreation5m: now.cacheCreation5m - before.cacheCreation5m,
      cacheCreation1h: now.cacheCreation1h - before.cacheCreation1h,
      advisor: {
        count: now.advisor.count - before.advisor.count,
        input: now.advisor.input - before.advisor.input,
        output: now.advisor.output - before.advisor.output,
        cacheRead: now.advisor.cacheRead - before.advisor.cacheRead,
        cacheCreation: now.advisor.cacheCreation - before.advisor.cacheCreation,
        models
      }
    },
    firstLine: false
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
const ACTIVE_GAP_MS = DEFAULT_ACTIVE_GAP_MS;

/**
 * The session's active time, split and totalled from one pass.
 *
 * `activeMinutes` is derived from the split rather than gap-split a second
 * time. The two used to be separate loops over the same array, which is how
 * `activeMinutes` and the per-day figures came to disagree; a partition that
 * is computed independently of its total is a partition that will eventually
 * stop being one.
 */
function activeSplitOf(fold: SessionFold) {
  return splitActiveTime(fold.timelinePoints, { activeGapMs: ACTIVE_GAP_MS });
}

/**
 * The same spans the split is summed from, kept rather than discarded, so the
 * per-project rollup can union sessions that overlap instead of adding them.
 *
 * A second pass over the timeline, not a second definition of one: this calls
 * the function `splitActiveTime` itself calls, with the threshold the rest of
 * this file uses. Handing the spans out of `activeSplitOf` would avoid the
 * pass but would change what every existing caller receives; the pass is
 * cheap and the seam stays where it was.
 */
function activeSpansOf(fold: SessionFold) {
  return activeSpans(fold.timelinePoints, { activeGapMs: ACTIVE_GAP_MS }).spans;
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
 * identical value, and on a heavy user's store that collapses most sessions
 * onto exactly 1.0. A field with no variance across the majority of
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
  opts: { isSidechain: boolean; ledger: PromptLedger; ownership: TimelineOwnership }
): Promise<void> {
  // Transcripts run to hundreds of MB; read line-wise, never whole-file.
  const handle = await fs.open(filePath);
  // Whether an agent turn is going on the main thread, for counting the runs a
  // person cut short. Per file, because a subagent's turns are not the
  // person's to interrupt and its transcript is never stepped.
  let turnRunning = false;
  try {
    for await (const line of handle.readLines({ encoding: "utf8" })) {
      const sniffed = sniffClaudeLine(line);
      if (sniffed.kind === "unparsed") {
        if (line.trim() !== "") fold.unparsedLines += 1;
        continue;
      }
      if (sniffed.kind === "meta") {
        // Counted separately rather than not at all, so the line books still
        // balance: known + meta + unknown + unparsed accounts for every line
        // read. Folding these into silence would make a store full of
        // `ai-title` lines indistinguishable from one that had none.
        fold.metaLines += 1;
        continue;
      }
      if (sniffed.kind === "unknown") {
        fold.unknownLines += 1;
        continue;
      }
      // Whose timeline this line sits on. A resumed transcript opens with a
      // copy of everything its ancestors held, and those lines belong to the
      // sessions they were written in — see `TimelineOwnership`. Everything
      // time-shaped below hangs off this: the session's window, its spans, its
      // minutes and its day slices.
      //
      // The same answer says whose counts it adds to: tokens, turns, the model
      // mix, tool calls and their events, tool results and failures, edits,
      // compactions and API errors. A subagent line can be a copy too, when a
      // resumed or forked session's directory holds its parent's subagent
      // transcripts, so it is asked of the directory it was found under. A
      // copy is still read, because the turn state below needs every line, but
      // it adds nothing. Typed prompts are settled by the ledger (`claim`)
      // instead. Asked once per line: an orphan's claim is remembered.
      const owned = opts.ownership.owns(
        sniffed,
        filePath,
        opts.isSidechain ? { isSidechain: true, foundUnderSessionId: fold.sessionId } : { isSidechain: false }
      );
      // Trust the store's own id over the filename when they disagree — main
      // thread only, and only from a line this file owns, which is the same
      // thing as a line written here. A subagent's own sessionId already
      // equals its parent's, so correcting off it here could only ever be a
      // no-op or a mistake.
      if (owned && !opts.isSidechain && sniffed.sessionId && fold.sessionId !== sniffed.sessionId) {
        fold.sessionId = sniffed.sessionId;
      }
      if (sniffed.sourceVersion) fold.sourceVersion = sniffed.sourceVersion;
      // The session's window, from its own lines only. `firstTs` is what
      // `startedAt` ships: a resumed session starts when it was resumed, not
      // when the oldest thing it inherited was typed. Before this rule 158 of
      // 983 sessions on the reference store reported spanning more than a day,
      // most of them reporting their ancestors' first instant.
      if (owned && sniffed.occurredAt) {
        if (!fold.firstTs || sniffed.occurredAt < fold.firstTs) fold.firstTs = sniffed.occurredAt;
        if (!fold.lastTs || sniffed.occurredAt > fold.lastTs) fold.lastTs = sniffed.occurredAt;
      }
      // Set by the `user` case below, read after the switch. The timeline
      // instant cannot be pushed before the switch any more: whether a line is
      // a person's own prompt is decided in there, off the re-parsed record,
      // and the split needs that answer on the same instant it needs the time.
      // Deriving it a second time here is exactly the drift that put a
      // prompts-only figure in the day slices.
      let humanHere = false;
      let postureHere: string | null = null;
      // Whether the agent side of the runtime produced this line. Decided per
      // line type below, and it is what starts a human turn: hands-on runs
      // from the last instant this is true to the next human prompt. The
      // runtime's bookkeeping around a prompt — `attachment`, `queue-operation`,
      // `last-prompt`, `custom-title` — is neither a person nor the agent, so
      // it bounds nothing; under the old nearest-line rule it bounded almost
      // every hands-on span, milliseconds before the prompt, which is why that
      // rule measured the runtime's write latency rather than a person.
      let agentOutputHere = false;
      switch (sniffed.kind) {
        case "user": {
          // Re-parse is cheap relative to disk; the sniffer deliberately does
          // not carry the whole record.
          const record = JSON.parse(line) as Record<string, unknown>;
          if (typeof record.cwd === "string" && !fold.cwd) fold.cwd = record.cwd;
          if (typeof record.gitBranch === "string" && !fold.gitBranch) {
            fold.gitBranch = record.gitBranch;
          }
          if (!opts.isSidechain) {
            // The one place this writer counts a run cut short: a human
            // interrupt marker that ends an agent turn still going. Not one
            // that lands after the turn ended, and not one the app wrote while
            // shutting down. The rule and its evidence live in
            // `interruptedRuns.ts`.
            const step = stepRun(turnRunning, record, isToolResultUserLine);
            turnRunning = step.running;
            // Counted by the session the person pressed Escape in, and only
            // that one. A resumed transcript replays its ancestors' markers
            // along with the rest of the inherited history, and the state
            // machine above re-detects each of those cuts exactly as it did
            // the first time — so before this, a lineage reported its
            // ancestors' interruptions as its own, again per descendant.
            // Measured on a store of 990 transcripts: 191 counted cuts came
            // from 146 distinct marker lines, and 40 of the 191 (20.9%) were
            // replays. 26 sessions carried one, 19 of them reporting nothing
            // else.
            //
            // **The machine is still fed every line, owned or not.** Ownership
            // decides attribution, never reading: an inherited turn that the
            // copy replays must still open and close here, or the running
            // state entering this session's own first line would be a guess.
            // The same distinction the timeline already makes — a copied line
            // is read for the counts it contributes and dropped from the
            // instants it does not own.
            if (step.cut && owned) {
              fold.interruptedRuns += 1;
              fold.interruptedRunTimestamps.push(sniffed.occurredAt);
            }
          }
          if (owned && isToolFailureLine(record)) fold.toolResultErrorCount += 1;
          if (isToolResultUserLine(record)) {
            // A tool round-trip completing is the agent's work landing.
            agentOutputHere = true;
            if (!owned) break;
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
            // folded into promptCount. The orchestrator wrote it, so it is
            // the agent's output as far as the human turn is concerned.
            agentOutputHere = true;
            if (owned) fold.subagentPrompts += 1;
          } else if (!isTypedPromptLine(record)) {
            // Written on the person's behalf: a notification, the runtime's
            // bookkeeping, a slash command's wrapper, an interrupt marker. Not
            // a prompt, and neither a person nor the agent as far as the split
            // goes, so it bounds nothing. Counted so the prompts it left out
            // are visible. Its posture is still a declaration of the session's
            // mode, so it is read the way a prompt's is.
            // Not gated on `owned` yet: a copied runtime line still counts in
            // each transcript holding it. The desktop app's importer is held to
            // this figure (`claude-store-lineage.cli.json`), so the two move together.
            fold.syntheticPromptLines += 1;
            if (typeof record.permissionMode === "string" && record.permissionMode !== "") {
              postureHere = snakeCasePermissionMode(record.permissionMode);
            }
          } else if (isHeadlessEntrypoint(record)) {
            // Written by a program driving the Agent SDK or a headless run, not
            // typed. Counted once per line so the prompts it left out are
            // visible. Like a synthetic line it bounds nothing in the split,
            // but it declares the session's posture, and it still starts the
            // agent's first turn (`stepRun` above).
            if (opts.ledger.claim(record, filePath)) fold.headlessPromptLines += 1;
            if (typeof record.permissionMode === "string" && record.permissionMode !== "") {
              postureHere = snakeCasePermissionMode(record.permissionMode);
            }
          } else if (opts.ledger.isDispatched(record)) {
            // A chip's prompt, opening the session it launched. Nobody typed
            // it, so it is not a prompt and not a person's instant; clicking
            // the chip was a person's act, so it is counted rather than
            // dropped, once per line as a prompt would be. It still starts the
            // agent's first turn (`stepRun` above). Its posture is read the
            // way a synthetic line's is.
            if (opts.ledger.claim(record, filePath)) fold.dispatchedPromptLines += 1;
            if (typeof record.permissionMode === "string" && record.permissionMode !== "") {
              postureHere = snakeCasePermissionMode(record.permissionMode);
            }
          } else {
            // Counted by one transcript only. A resumed transcript's copy of an
            // ancestor's prompt is still a person's instant on this fold's
            // timeline, so the minutes keep it; the count and the events do
            // not. See `promptLedger.ts`.
            if (opts.ledger.claim(record, filePath)) {
              fold.humanPrompts += 1;
              if (sniffed.occurredAt && isOutsideBusinessHours(new Date(sniffed.occurredAt))) {
                fold.afterHoursPrompts += 1;
              }
              fold.humanPromptTimestamps.push(sniffed.occurredAt);
            }
            humanHere = true;
            // The transcript spells this `permissionMode`; the hook payloads
            // spell the same field `permission_mode`. Snake-casing here means
            // one vocabulary reaches `autonomyBand` from both collectors, and
            // an unrecognised mode passes through rather than being mapped.
            if (typeof record.permissionMode === "string" && record.permissionMode !== "") {
              postureHere = snakeCasePermissionMode(record.permissionMode);
            }
          }
          break;
        }
        case "assistant": {
          // Every assistant line is the agent speaking — a model turn, a tool
          // call being issued, or a runtime notice under `<synthetic>`. Each
          // ends whatever human turn was open.
          agentOutputHere = true;
          const record = JSON.parse(line) as Record<string, unknown>;
          if (!opts.isSidechain) turnRunning = stepRun(turnRunning, record, isToolResultUserLine).running;
          // A copy's model still moves `lastMainModel`, so the first model this
          // session runs on is compared with the one it resumed from. It adds
          // nothing else; the session that wrote it does.
          if (!owned) {
            const copiedModel = opts.isSidechain ? null : foldableModelOf(sniffed.model);
            if (copiedModel) fold.lastMainModel = copiedModel;
            break;
          }
          const message = record.message as Record<string, unknown> | undefined;
          const usage = message?.usage as Record<string, unknown> | undefined;
          // Counted once per API message, not once per line: see
          // `messageTokens`. Turns and the model mix are per message too.
          const read = readMessageUsage(usage);
          if (read.hasCacheCreation) fold.cacheCreationSeen = true;
          if (read.hasCacheCreationSplit) fold.cacheCreationSplitSeen = true;
          const { delta: counted, firstLine } = foldMessageUsage(
            fold,
            messageKeyOf(record),
            read.usage
          );
          const advisor = counted.advisor;
          const advisorTokens = advisor.input + advisor.output + advisor.cacheRead + advisor.cacheCreation;
          fold.advisorMessageCount += advisor.count;
          fold.advisorTokensTotal += advisorTokens;
          // Before the sidechain split: a tool call is a tool call whichever
          // thread issued it, and the counters below keep the two apart.
          // A line with no usable timestamp can still be counted but cannot
          // be placed on a rail, so it contributes to the count and not to
          // the event list — an undated event would have to invent an
          // instant to exist at all.
          const toolNames = toolUseNamesOf(record);
          if (toolNames.length > 0) {
            if (opts.isSidechain) fold.subagentToolCallCount += toolNames.length;
            else fold.toolCallCount += toolNames.length;
            if (sniffed.occurredAt) {
              for (const name of toolNames) {
                fold.toolCalls.push({ at: sniffed.occurredAt, name });
              }
            }
          }
          if (opts.isSidechain) {
            if (firstLine) fold.subagentAssistantTurns += 1;
            fold.subagentTokensTotal +=
              counted.input + counted.output + counted.cacheRead + counted.cacheCreation + advisorTokens;
            break;
          }
          if (firstLine) fold.assistantTurns += 1;
          // A runtime notice names no model, so it moves none of the three
          // model figures — and crucially does not touch `lastMainModel`
          // either, so a run interrupted by a notice and resumed on the same
          // model reads as the zero switches it was.
          const foldedModel = firstLine ? foldableModelOf(sniffed.model) : null;
          if (foldedModel) {
            fold.models.set(foldedModel, (fold.models.get(foldedModel) ?? 0) + 1);
            if (fold.lastMainModel && fold.lastMainModel !== foldedModel) {
              fold.modelSwitchCount += 1;
            }
            fold.lastMainModel = foldedModel;
          }
          // Deliberately NOT gated on `foldedModel`. The model figures are a
          // vocabulary and `<synthetic>` is not in it; the token figures are
          // arithmetic, and a notice's `usage` block is all zeros, so adding
          // it moves no total and a zero context figure cannot beat a peak.
          // Skipping it would buy an identical result at the price of a
          // second rule, and would hard-code the assumption that these lines
          // always report zero — if one ever reports real tokens, they were
          // really spent and this counts them.
          // The advisor's tokens are not in the message's own `usage`, so they
          // join the totals here. Its model joins the mix without touching
          // `lastMainModel`: the main thread did not switch to it.
          for (const [model, count] of advisor.models) {
            fold.models.set(model, (fold.models.get(model) ?? 0) + count);
          }
          fold.inputTokens += counted.input + advisor.input;
          fold.outputTokens += counted.output + advisor.output;
          fold.cacheReadTokens += counted.cacheRead + advisor.cacheRead;
          fold.cacheCreationTokens += counted.cacheCreation + advisor.cacheCreation;
          fold.cacheCreation5mTokens += counted.cacheCreation5m;
          fold.cacheCreation1hTokens += counted.cacheCreation1h;
          if (usage) {
            const contextTokens =
              asNumber(usage.input_tokens) +
              asNumber(usage.cache_read_input_tokens) +
              asNumber(usage.cache_creation_input_tokens);
            if (contextTokens > fold.contextWindowPeakTokens) fold.contextWindowPeakTokens = contextTokens;
          }
          break;
        }
        case "system": {
          // Runtime notices — the stop-hook summary that closes a turn, an
          // API retry, a compaction boundary. The runtime's agent side wrote
          // them while working, so they end a human turn the way a model
          // line does; the stop-hook summary in particular is the last line
          // before the person's reading time begins.
          agentOutputHere = true;
          // Not observed inside subagent transcripts on the verified store
          // (compaction and api_error both live on the main thread only),
          // but nothing here assumes that stays true — it just naturally
          // folds into the same session counters if it ever does.
          const record = JSON.parse(line) as Record<string, unknown>;
          if (!opts.isSidechain) turnRunning = stepRun(turnRunning, record, isToolResultUserLine).running;
          if (!owned) break;
          if (record.subtype === "compact_boundary") {
            fold.compactionCount += 1;
            const trigger = (record.compactMetadata as Record<string, unknown> | undefined)?.trigger;
            if (trigger === "manual") fold.compactionManualCount += 1;
            else if (trigger === "auto") fold.compactionAutoCount += 1;
            fold.compactions.push({
              at: sniffed.occurredAt,
              trigger: trigger === "manual" || trigger === "auto" ? trigger : null
            });
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
          break; // attachment / last-prompt / custom-title: window only, and
        //           bookkeeping for the split — `agentOutputHere` stays false.
      }
      if (sniffed.occurredAt && !owned) {
        // Someone else's instant, held here as a copy. Counted rather than
        // dropped silently: a fold whose file held nothing else is a pure copy
        // and the emit loop reports it.
        fold.inheritedTimelineLines += 1;
      } else if (sniffed.occurredAt) {
        const ms = Date.parse(sniffed.occurredAt);
        if (Number.isFinite(ms)) {
          fold.timelinePoints.push({
            at: ms,
            human: humanHere,
            agentOutput: agentOutputHere,
            autonomyMode: postureHere
          });
        } else {
          // A timestamp the runtime wrote and this code cannot read. It still
          // moved `firstTs`/`lastTs` above by string comparison, so the
          // session's wall clock survives it while both active figures do not
          // — which is precisely why it is counted instead of dropped.
          fold.undatedTimelineLines += 1;
        }
      }
    }
  } finally {
    await handle.close();
  }
}

async function foldTranscript(
  filePath: string,
  projectSlug: string,
  ledger: PromptLedger,
  ownership: TimelineOwnership
): Promise<SessionFold> {
  const fold = newFold(path.basename(filePath, ".jsonl"), projectSlug);
  await foldLinesInto(fold, filePath, { isSidechain: false, ledger, ownership });
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

/** How many object lines to look at before calling a top-level file a main
 * thread. A flat subagent file marks itself on its first line, so this only
 * bounds the cost of the check on the usual case, a real session. */
const SIDECHAIN_PROBE_LINES = 20;

/**
 * Whether a top-level `<project>/*.jsonl` is a subagent transcript, and if so
 * the session it belongs to.
 *
 * Older Claude Code wrote subagent transcripts flat, as
 * `<project>/agent-<id>.jsonl`, rather than under the parent's directory. Their
 * lines say so themselves: `isSidechain: true`, an `agentId`, and the parent's
 * `sessionId`. The lines are what decide, not the file name, which is only a
 * habit of the runtime that wrote them. A main-thread transcript carries
 * neither field, so one that does not announce itself in its first lines is
 * read as a session.
 */
export async function probeTopLevelTranscript(
  filePath: string
): Promise<{ sidechain: boolean; parentSessionId: string | null }> {
  let handle;
  try {
    handle = await fs.open(filePath);
  } catch {
    return { sidechain: false, parentSessionId: null };
  }
  let seen = 0;
  try {
    for await (const line of handle.readLines({ encoding: "utf8" })) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if (record.isSidechain === true || (typeof record.agentId === "string" && record.agentId !== "")) {
        return {
          sidechain: true,
          parentSessionId:
            typeof record.sessionId === "string" && record.sessionId !== "" ? record.sessionId : null
        };
      }
      seen += 1;
      if (seen >= SIDECHAIN_PROBE_LINES) break;
    }
  } finally {
    await handle.close();
  }
  return { sidechain: false, parentSessionId: null };
}

/** One project directory's transcripts, listed before anything is read. */
interface ProjectPlan {
  slug: string;
  dir: string;
  /** Main-thread transcript names, sorted. */
  topLevelFiles: string[];
  /** Top-level files that are subagent transcripts, with the session each
   * belongs to (null where their lines name none). */
  flatSidechains: { name: string; parentSessionId: string | null }[];
  /** Files at the top level that aren't transcripts. */
  otherFiles: number;
  /** Session directories, sorted, each with its subagent transcripts. */
  sessionDirs: { name: string; files: string[]; otherFiles: number }[];
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
  // Transcripts holding nothing but a copy of an ancestor's history. A resume
  // that was opened and never used writes one: every line in it belongs to the
  // session it was resumed from, so it has no timeline of its own and is
  // unusable for the same reason a transcript with no readable timestamp is.
  // Reported rather than dropped in silence, because the count is the cost of
  // the ownership rule and a reader is entitled to see it.
  let sessionsWithOnlyInheritedLines = 0;
  // Flat subagent files whose lines name no parent session. Dropped from the
  // session list on purpose, and counted here so the drop is visible.
  let unattributedSubagentTranscripts = 0;

  // The whole walk is listed before anything is read, because the prompt
  // ledger has to read every transcript, in this order, before the first
  // session is folded. Paths only; nothing is held open.
  const plan: ProjectPlan[] = [];
  for (const slug of projectSlugs.sort()) {
    const dir = path.join(projectsDir, slug);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const topLevelFiles: string[] = [];
    const flatSidechains: ProjectPlan["flatSidechains"] = [];
    for (const name of entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name)
      .sort()) {
      const probe = await probeTopLevelTranscript(path.join(dir, name));
      if (probe.sidechain) flatSidechains.push({ name, parentSessionId: probe.parentSessionId });
      else topLevelFiles.push(name);
    }
    const sessionDirs: ProjectPlan["sessionDirs"] = [];
    for (const name of entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      const nested = await walkJsonlFiles(path.join(dir, name));
      sessionDirs.push({ name, files: nested.files, otherFiles: nested.otherFiles });
    }
    plan.push({
      slug,
      dir,
      topLevelFiles,
      flatSidechains,
      otherFiles: entries.filter((e) => e.isFile() && !e.name.endsWith(".jsonl")).length,
      sessionDirs
    });
  }

  const mainTranscripts = plan.flatMap((p) => p.topLevelFiles.map((name) => path.join(p.dir, name)));
  const { ledger, claims } = await readPromptLedger(
    mainTranscripts,
    plan.flatMap((p) => [
      ...p.flatSidechains.map((f) => path.join(p.dir, f.name)),
      ...p.sessionDirs.flatMap((d) => d.files)
    ]),
    isToolResultUserLine
  );
  // Which transcript wrote each line that two of them claim. Only the files
  // holding a contested id are opened again — none at all on a store where no
  // copy rewrote a `sessionId` — and the pre-read's full map of claims is
  // dropped once this is built. See `HomeClaims`.
  const contestedOwners = await resolveContestedOwners(claims, mainTranscripts);
  // The prompts follow the same answer. A contested line is one line: the
  // session that wrote it counts the prompt AND holds the instant.
  ledger.applyContestedOwners(contestedOwners);
  // The file list and the contested owners above are all this needs. It is
  // consumed in the fold loop below, in the same order the pre-read used,
  // because the rule for a line whose home file is gone is first-come.
  const ownership = new TimelineOwnership(mainTranscripts, contestedOwners);

  for (const { slug, dir, topLevelFiles, flatSidechains, otherFiles, sessionDirs } of plan) {
    let slugJsonlFiles = topLevelFiles.length + flatSidechains.length;
    let slugOtherFiles = otherFiles;

    // Keyed by the top-level filename's own basename, which is also the
    // directory-naming convention subagent transcripts nest under.
    //
    // A transcript whose lines carry a `sessionId` other than its filename is
    // not a session that changed its id partway through. Every such file
    // measured on a real store was a resumed or forked session: the runtime
    // copies the inherited history into the new file, and the copied lines
    // keep their original id and timestamp. Keying by line id would break a
    // resumed file into fragments that each look like a session, so the
    // filename stays the key. What the copies would otherwise inflate is
    // handled where each figure is made, by one rule in `promptLedger.ts`
    // applied twice: a typed prompt is counted by one transcript, and a line's
    // instant sits on one transcript's timeline, so minutes, spans and
    // `startedAt` describe this session rather than its ancestry.
    const foldsByKey = new Map<string, SessionFold>();

    for (const name of topLevelFiles) {
      const fold = await foldTranscript(path.join(dir, name), slug, ledger, ownership);
      foldsByKey.set(path.basename(name, ".jsonl"), fold);
    }

    // Flat subagent files fold into the session they name, the way the nested
    // ones fold into their directory's. When that session's own transcript is
    // gone (the purge), the fold is seeded from the subagent file, as it is for
    // an orphaned directory. A file naming no session has nowhere to go, and is
    // counted rather than turned into a session of its own.
    for (const { name, parentSessionId } of flatSidechains) {
      if (parentSessionId === null) {
        unattributedSubagentTranscripts += 1;
        continue;
      }
      let fold = foldsByKey.get(parentSessionId);
      if (!fold) {
        fold = newFold(parentSessionId, slug);
        foldsByKey.set(parentSessionId, fold);
      }
      fold.subagentTranscripts += 1;
      await foldLinesInto(fold, path.join(dir, name), { isSidechain: true, ledger, ownership });
    }

    for (const { name: sessionDirName, files: nestedFiles, otherFiles: nestedOther } of sessionDirs) {
      slugJsonlFiles += nestedFiles.length;
      slugOtherFiles += nestedOther;
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
        await foldLinesInto(fold, nestedPath, { isSidechain: true, ledger, ownership });
      }
    }

    // Files here, but nothing this extractor can read as a transcript.
    if (slugJsonlFiles === 0 && slugOtherFiles > 0) projectsWithNoReadableTranscript += 1;

    for (const fold of foldsByKey.values()) {
      // A fold with no usable timeline is unusable regardless of its
      // contents — including one whose every dated line belongs to an
      // ancestor, which is the same situation arrived at from the other side.
      if (!fold.firstTs || !fold.lastTs) {
        if (fold.inheritedTimelineLines > 0) sessionsWithOnlyInheritedLines += 1;
        continue;
      }
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

      // One event per issued call. This is the only thing in this file the
      // backend's demand rail actually counts — its tool-call tally reads
      // rows whose canonical type is `ai_tool_call_started` and never a
      // `toolCallCount` key off metadata — so the counts on the session event
      // below exist for the local handoff and for anyone reading the staged
      // file, not for the rail.
      for (const call of fold.toolCalls) {
        yield {
          occurredAt: call.at,
          store: "claude_code",
          sourceVersion: fold.sourceVersion,
          sessionRef: fold.sessionId,
          repoRef: fold.cwd ?? fold.projectSlug,
          eventKind: "ai_tool_call_started",
          metrics: { toolName: call.name },
          provenance: HISTORICAL_PROVENANCE.direct,
          extractionId
        };
      }

      const durationMs = sessionDurationMs(fold);
      const toolFailureCount = fold.toolResultErrorCount + fold.apiErrorCount;
      const split = activeSplitOf(fold);
      const sessionMetrics: NormalizedHistoricalEvent["metrics"] = {
        promptCount: fold.humanPrompts,
        syntheticPromptLines: fold.syntheticPromptLines,
        dispatchedPromptLines: fold.dispatchedPromptLines,
        assistantTurns: fold.assistantTurns,
        toolCallCount: fold.toolCallCount,
        toolResultCount: fold.toolResults,
        queuedPrompts: fold.queuedPrompts,
        inputTokens: fold.inputTokens,
        outputTokens: fold.outputTokens,
        cacheReadTokens: fold.cacheReadTokens,
        headlessPromptLines: fold.headlessPromptLines,
        durationBucket: durationBucketOf(fold),
        afterHoursPrompts: fold.afterHoursPrompts,
        unknownLines: fold.unknownLines,
        metaLines: fold.metaLines,
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
        interruptedRuns: fold.interruptedRuns,
        activeMinutes: minutesOf(split.handsOnMs + split.agentSupervisingMs),
        // The two halves of that figure, and the reason it is not the whole
        // answer: a session that spent 5 minutes being typed at and 17 minutes
        // running an agent is not a 22-minute session of anything. Shipped as
        // two keys and never as a third combined one — `activeMinutes` above
        // is the pre-existing total with its existing readers, not a summary
        // of these.
        handsOnMinutes: minutesOf(split.handsOnMs),
        agentSupervisingMinutes: minutesOf(split.agentSupervisingMs),
        // Honesty counters for the split, in the same spirit as unparsedLines:
        // a reader can tell a session with no posture data from one that ran
        // entirely under `default`, and a short timeline from a complete one.
        activeSplitInstants: split.instants,
        activeSplitUndatedLines: fold.undatedTimelineLines,
        activeSplitUnposturedInstants: split.unposturedInstants,
        subagentTranscripts: fold.subagentTranscripts,
        subagentPrompts: fold.subagentPrompts,
        subagentAssistantTurns: fold.subagentAssistantTurns,
        subagentTokensTotal: fold.subagentTokensTotal,
        subagentToolCallCount: fold.subagentToolCallCount
      };
      // Present only where the store wrote the field at all: an older
      // transcript with no cache-write figure is not a session that wrote
      // nothing to the cache.
      if (fold.cacheCreationSeen) sessionMetrics.cacheCreationTokens = fold.cacheCreationTokens;
      if (fold.cacheCreationSplitSeen) {
        sessionMetrics.cacheCreation5mTokens = fold.cacheCreation5mTokens;
        sessionMetrics.cacheCreation1hTokens = fold.cacheCreation1hTokens;
      }
      if (fold.advisorMessageCount > 0) {
        sessionMetrics.advisorMessageCount = fold.advisorMessageCount;
        sessionMetrics.advisorTokensTotal = fold.advisorTokensTotal;
      }
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
        // Prompts are counted off the prompt timestamps; active time is
        // gap-split over the whole classified timeline. Passing only the
        // threshold used to be enough — it was not, and the day figures spent
        // that time reporting prompts-only active minutes while the session
        // figure reported the timeline. Both materials now cross this call.
        dayBreakdown: sliceSessionByLocalDay(fold.humanPromptTimestamps, {
          activeGapMs: ACTIVE_GAP_MS,
          activeInstants: fold.timelinePoints,
          interruptedRunTimestamps: fold.interruptedRunTimestamps
        }),
        // Local-only, consumed by `buildHandoff` and never written anywhere;
        // see `NormalizedHistoricalEvent.activeSpans`.
        activeSpans: activeSpansOf(fold),
        autonomySplit: Object.fromEntries(
          Object.entries(split.supervisingMsByBand).map(([band, ms]) => [band, minutesOf(ms)])
        ),
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

      // One event per real compaction, at the compact_boundary line's own
      // instant, so time-to-first-compaction can be read off an imported
      // session. A line with no readable timestamp is in the counts above and
      // has no event, like an undated tool call. A boundary whose trigger is
      // neither manual nor auto keeps its place in the ordinal and ships
      // nothing: the live vocabulary has no third name for it.
      for (const [index, compaction] of fold.compactions.entries()) {
        if (!compaction.at || !compaction.trigger) continue;
        yield {
          occurredAt: compaction.at,
          store: "claude_code",
          sourceVersion: fold.sourceVersion,
          sessionRef: fold.sessionId,
          repoRef: fold.cwd ?? fold.projectSlug,
          eventKind: compaction.trigger === "manual" ? "context_compression_manual" : "context_compression_auto",
          metrics: { compactionCount: 1, compactionOrdinal: index + 1 },
          provenance: HISTORICAL_PROVENANCE.direct,
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
  if ((windowOldest && windowNewest) || projectsWithNoReadableTranscript > 0 || sessionsWithOnlyInheritedLines > 0 || unattributedSubagentTranscripts > 0) {
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
        projectsWithNoReadableTranscript,
        sessionsWithOnlyInheritedLines,
        unattributedSubagentTranscripts
      },
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };
  }
}
