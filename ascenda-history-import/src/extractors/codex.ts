/**
 * Codex CLI rollout extractor — second in the evaporation order.
 *
 * Store: `<snapshot>/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl`,
 * plus `<snapshot>/archived_sessions/**` for rollouts the user archived from
 * the resume picker (moved, not deleted, same shape). One JSON object per
 * line, every line `{ timestamp, type, payload }`. `type` is the top-level
 * discriminator; `response_item` and `event_msg` lines discriminate again on
 * `payload.type`. The date nesting is not documented upstream, so the walk is
 * recursive rather than hardcoded to it.
 *
 * A session is a thread, not a file. Three things put more than one file
 * on a thread, or more than one thread in a file, and each is handled where
 * it's read (see `rolloutIdentityOf`):
 *  - a long thread continues in `rollout-<ts>-<id>_<rollout>.jsonl`
 *    (`history_mode: "paginated"`), folded into the same session;
 *  - a fork (`forked_from_id`) replays its parent's history at the top of
 *    its own rollout, which is skipped so it isn't counted twice;
 *  - a subagent thread folds into the session that spawned it.
 * With history compression on, rollouts are `.jsonl.zst`; see
 * `zstdLines` for how they're read.
 *
 * Everything the import needs sits on six top-level types:
 *  - `session_meta` — the first line: `id` (`session_id` beside it on newer
 *    builds), `cwd`, `cli_version`, `originator`, `git.branch`.
 *  - `turn_context` — one per turn: `model`, `cwd`, `approval_policy`,
 *    `sandbox_policy`. The model mix is read from here.
 *  - `event_msg` — `user_message` (a human prompt), `token_count`,
 *    `task_started`/`task_complete` (and their `turn_*` aliases),
 *    `turn_aborted`, `context_compacted`, `thread_rolled_back`, `error`.
 *  - `response_item` — the model-facing history: `message` (any role),
 *    `reasoning`, the tool-call items (`function_call`, `custom_tool_call`,
 *    `local_shell_call`, `web_search_call`, `tool_search_call`,
 *    `image_generation_call`), their outputs, and the compaction items.
 *  - `compacted` — the rollout's own record of a context compaction.
 *  - `token_usage_record` — written beside each `token_count` on current
 *    builds, with the thread's cumulative total in `thread_token_usage` and
 *    the thread it belongs to in `thread_id`.
 *
 * The classification everything else rests on: **a human prompt is an
 * `event_msg` of type `user_message`, never a `response_item` message with
 * `role: "user"`.** The runtime writes both for each prompt, and the
 * `response_item` copy shares its role with injected material — the
 * `<environment_context>` block, IDE context, aborted-turn notices — so
 * counting user-role messages roughly doubles every prompt metric. On IDE
 * builds a `user_message` may itself be wrapped in "Context from my IDE
 * setup" text; that is still one person typing once, and only the wrapper's
 * existence is noted here, never its text. Newer builds label a
 * `user_message` with `kind`; anything other than a plain one (environment
 * context, user instructions) is not a person typing and is not counted.
 *
 * Read the rollout, not the hooks: unlike Claude Code, Codex's rollout does
 * not record `permission_mode`. It records `approval_policy` and
 * `sandbox_policy`, which the live Codex hooks deliberately leave unmapped
 * (two orthogonal axes, no wire value known to carry them — see
 * `ascenda-codex-hooks/docs/CODEX_MAPPING.md`). This extractor follows that
 * decision rather than inventing a mapping the live side refused to, so
 * every agent-supervising minute lands in the `unknown` band and
 * `activeSplitUnposturedInstants` equals the instant count. That is a blind
 * spot stated as one, not a posture.
 *
 * Beyond the prompt/session/after-hours signals, this file also extracts:
 *  - **Tokens**: `token_count.info.total_token_usage` is cumulative for the
 *    session, so the session totals are the largest cumulative figure seen
 *    (largest, not last — a `thread_rolled_back` can move it backwards).
 *    `token_usage_record.thread_token_usage` is the same running total under
 *    the same field names, folded by the same max, so a rollout carrying
 *    both lines comes out as if it carried one. Codex's `input_tokens`
 *    counts `cached_input_tokens` and `cache_write_input_tokens` inside it;
 *    `inputTokens` ships with both taken out, the uncached input every other
 *    store ships under that key, and the two cache figures ship as
 *    `cacheReadTokens` and `cacheCreationTokens`. A rollout from before
 *    `cache_write_input_tokens` existed ships no `cacheCreationTokens`.
 *    `last_token_usage.input_tokens` is the last request's whole input,
 *    cache included, so it is the context occupancy of that request; the
 *    session peak is the largest of them.
 *  - **Context window**: `info.model_context_window` (also on
 *    `task_started`) is the model's real window, so `contextWindowPeakPct`
 *    here divides by what the store recorded rather than by the 200k Claude
 *    Code has to assume. Where no window was recorded the ratio is omitted
 *    rather than computed against a guess.
 *  - **Tool calls**: one entry per tool-call `response_item` — the ISSUED
 *    side, matched to the live hooks' `PreToolUse` → `ai_tool_call_started`
 *    mapping, one event per call, for the same reason `claudeCode.ts` gives:
 *    the backend's demand rail counts rows of that type. Only `name` (or the
 *    item type where there is none) is read; `arguments` holds the command
 *    or patch and is never touched.
 *  - **Failures**: a tool output whose `success` is `false`, or whose text
 *    opens with a non-zero `Exit code:` line — the only part of the output
 *    inspected. Plus `event_msg` `error` lines, the runtime's own failures.
 *  - **Compaction**: top-level `compacted` items. One compaction can also
 *    write a `context_compacted` event and a replacement `compaction`
 *    message item, so those are recognised and not counted; the event is
 *    used only where a build wrote no `compacted` item at all. No manual/
 *    auto split: the rollout does not say which, so no
 *    `context_compression_*` event is emitted — a guess there would be
 *    counted by the backend as a fact.
 *  - **Long turns**: `task_complete.duration_ms`, bucketed through the same
 *    `bucketDurationMs` the live hooks' `Stop` mapping uses, emitted as
 *    `agent_loop_long` at the 30-minute bucket exactly as they do.
 *  - **Correction cadence** and **active minutes**: as `claudeCode.ts`.
 *
 * Emission (aggregate before shipping — never one event per line):
 *  - `ai_prompt_submitted` per human prompt, provenance historical_direct.
 *  - `ai_tool_call_started` per issued call, historical_direct.
 *  - `agent_loop_long` per turn at or past the 30-minute bucket,
 *    historical_direct — the duration is the store's own number.
 *  - `create_focus_session` per session, historical_derived.
 *  - `after_hours_ai_session` / `tool_failure` per session with ≥1, derived.
 *  - one `extraction_epoch` for the store's observed window. Local only.
 * Metrics carry counts, ids and timestamps only — never prompt, response,
 * reasoning or tool text.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { bucketDurationMs, isOutsideBusinessHours, modelRouteFromCodexProvider, modelRouteFromSlug } from "@ascenda-one/tool-kit";
import { HISTORICAL_PROVENANCE, NormalizedHistoricalEvent } from "../types.js";
import { sanitizeToolName } from "../toolName.js";
import { sliceSessionByLocalDay } from "../daySlice.js";
import { modelTurnsMetrics } from "../modelTurns.js";
import { effortChangesOf, foldEffort, newEffortTrack, primaryEffortOf, type EffortTrack } from "../effortFold.js";
import { DEFAULT_ACTIVE_GAP_MS, activeSpans, minutesOf, splitActiveTime, type ActiveInstant } from "../activeSplit.js";

/** Top-level line types the extractor reads fields from. */
export const KNOWN_CODEX_LINE_TYPES = [
  "session_meta",
  "turn_context",
  "response_item",
  "event_msg",
  "compacted",
  "token_usage_record"
] as const;
export type CodexLineType = (typeof KNOWN_CODEX_LINE_TYPES)[number];

/**
 * Top-level types observed in real rollouts that carry nothing the import
 * needs. Recognised so they count as `metaLines`, leaving `unknownLines` to
 * mean a type nobody has classified yet — the only kind worth alerting on.
 */
export const META_CODEX_LINE_TYPES = new Set(["world_state"]);

/**
 * `event_msg` payload types that are recognised and read for nothing.
 * `item_completed` repeats, once an item finishes, a tool call, message or
 * reasoning item the rollout already wrote as a `response_item`. Counting it
 * would count each call twice, and placing it on the timeline would add an
 * instant for work already placed. It counts as a `metaLines` line.
 */
export const META_EVENT_MSG_TYPES = new Set(["item_completed"]);

/** `response_item` payload types this extractor recognises. A type not here
 * counts as an unknown line — the drift signal — rather than being skipped. */
export const KNOWN_RESPONSE_ITEM_TYPES = new Set([
  "message",
  "agent_message",
  "reasoning",
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
  "tool_search_call",
  "image_generation_call",
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
  "compaction",
  "context_compaction",
  "compaction_trigger",
  "additional_tools",
  "configuration_update"
]);

/** `event_msg` payload types this extractor recognises, same rule. */
export const KNOWN_EVENT_MSG_TYPES = new Set([
  "user_message",
  "agent_message",
  "agent_reasoning",
  "agent_reasoning_delta",
  "token_count",
  "task_started",
  "turn_started",
  "task_complete",
  "turn_complete",
  "turn_aborted",
  "context_compacted",
  "thread_rolled_back",
  "thread_settings_applied",
  "error",
  "warning",
  "shutdown_complete"
]);

/** Tool-call items — the issued side. */
export const TOOL_CALL_ITEM_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
  "tool_search_call",
  "image_generation_call"
]);

/** Tool-output items — the completed side. */
export const TOOL_OUTPUT_ITEM_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output"
]);

export type SniffedCodexLine =
  | {
      kind: CodexLineType;
      /** `payload.type` on `response_item` / `event_msg` lines; null elsewhere. */
      subtype: string | null;
      occurredAt: string | null;
      payload: Record<string, unknown>;
    }
  /** A top-level type this extractor deliberately ignores. */
  | { kind: "meta"; type: string }
  /** Valid JSON, string `type`, but neither read nor recognised — either a
   * new top-level type or a new `payload.type` under a known one. */
  | { kind: "unknown"; type: string }
  /** Not JSON, not an object, or no string `type` — real schema drift. */
  | { kind: "unparsed"; raw: string };

export function sniffCodexLine(line: string): SniffedCodexLine {
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
  if (!(KNOWN_CODEX_LINE_TYPES as readonly string[]).includes(type)) {
    return META_CODEX_LINE_TYPES.has(type) ? { kind: "meta", type } : { kind: "unknown", type };
  }
  const payload =
    typeof record.payload === "object" && record.payload !== null && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : {};
  let subtype: string | null = null;
  if (type === "response_item" || type === "event_msg") {
    subtype = typeof payload.type === "string" ? payload.type : null;
    if (type === "event_msg" && subtype !== null && META_EVENT_MSG_TYPES.has(subtype)) {
      return { kind: "meta", type: `${type}:${subtype}` };
    }
    const known = type === "response_item" ? KNOWN_RESPONSE_ITEM_TYPES : KNOWN_EVENT_MSG_TYPES;
    if (subtype === null || !known.has(subtype)) {
      return { kind: "unknown", type: `${type}:${subtype ?? "?"}` };
    }
  }
  return {
    kind: type as CodexLineType,
    subtype,
    occurredAt: typeof record.timestamp === "string" ? record.timestamp : null,
    payload
  };
}

/**
 * Whether a `user_message` event is a person typing. Older builds carry no
 * `kind`; newer ones label the injected kinds (`environment_context`,
 * `user_instructions`) so they can be told from a plain prompt. Absent is
 * read as plain, because that is what every unlabelled line observed was.
 */
export function isHumanUserMessage(payload: Record<string, unknown>): boolean {
  const kind = payload.kind;
  if (typeof kind !== "string") return true;
  return kind === "plain";
}

/**
 * The name a tool-call item was issued under. `function_call` and
 * `custom_tool_call` carry `name`; the built-in call kinds carry none and are
 * named by their item type, so `local_shell_call` groups as `local_shell_call`
 * rather than as `unknown`. Only the name is read — `arguments` is the call's
 * input and is never touched.
 */
export function toolCallNameOf(subtype: string, payload: Record<string, unknown>): string {
  return sanitizeToolName(typeof payload.name === "string" ? payload.name : subtype);
}

/**
 * Whether a tool-output item records a failure. `success: false` is the
 * authoritative marker where a build writes one. Older builds write only the
 * shell wrapper's text, whose first line is `Exit code: <n>` — that prefix is
 * the only part of the output inspected, and the text is never retained.
 * The output may be a string or an object carrying `content`/`success`.
 */
export function isToolOutputFailure(payload: Record<string, unknown>): boolean {
  if (payload.success === false) return true;
  let output = payload.output;
  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    const wrapped = output as Record<string, unknown>;
    if (wrapped.success === false) return true;
    output = wrapped.content;
  }
  if (typeof output !== "string") return false;
  const match = /^Exit code: (\d+)/.exec(output);
  return match !== null && match[1] !== "0";
}

/**
 * A cumulative token figure as Codex writes it. `input` is Codex's own
 * `input_tokens`, which counts `cached` and `cacheWrite` inside it; it is kept
 * that way here because the fork-replay check and the subagent delta compare
 * raw cumulative inputs. The cache parts come off only at emission.
 */
interface TokenTotals {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}

const NO_TOKENS: TokenTotals = { input: 0, output: 0, cached: 0, cacheWrite: 0 };

function maxTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cached: Math.max(a.cached, b.cached),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite)
  };
}

/** Input billed at the full rate: what `inputTokens` means on every store. */
function uncachedInputOf(t: TokenTotals): number {
  return Math.max(0, t.input - t.cached - t.cacheWrite);
}

/**
 * One thread's cumulative token counter. `total_token_usage` is cumulative,
 * so a thread's spend is the largest figure seen on its own lines. A fork
 * replays its parent's `token_count` lines first, and those carry the
 * parent's running total: `replayed` holds the largest of them so it can be
 * taken off again. Whether the fork's counter carried on from that figure
 * or restarted at zero isn't written down anywhere, so the first reading
 * after the replay decides it: below the replayed input total means the
 * counter restarted and nothing needs subtracting.
 */
interface TokenTrack {
  own: TokenTotals;
  replayed: TokenTotals | null;
  settled: boolean;
  /** Whether a `token_count` of this thread's own carried a running total.
   * Rollouts written before those events existed have none, and a replayed
   * parent figure doesn't count: the thread itself was not measured. */
  seen: boolean;
  /** Whether one of this thread's own totals carried
   * `cache_write_input_tokens`. Builds before the field existed don't, and
   * their sessions ship no `cacheCreationTokens` rather than a 0. */
  cacheWriteSeen: boolean;
}

function newTokenTrack(): TokenTrack {
  return { own: { ...NO_TOKENS }, replayed: null, settled: false, seen: false, cacheWriteSeen: false };
}

function ownTokensOf(track: TokenTrack): TokenTotals {
  const base = track.replayed ?? NO_TOKENS;
  return {
    input: Math.max(0, track.own.input - base.input),
    output: Math.max(0, track.own.output - base.output),
    cached: Math.max(0, track.own.cached - base.cached),
    cacheWrite: Math.max(0, track.own.cacheWrite - base.cacheWrite)
  };
}

/** One cumulative total as read off a line, and whether it reported cache
 * writes at all. */
interface TokenReading {
  totals: TokenTotals;
  reportsCacheWrite: boolean;
}

/** A cumulative usage object: `token_count.info.total_token_usage`, or
 * `token_usage_record.thread_token_usage`. Both use the same field names. */
function readingOf(usage: unknown): TokenReading | null {
  const total = asRecord(usage);
  if (!total) return null;
  return {
    totals: {
      input: asNumber(total.input_tokens),
      output: asNumber(total.output_tokens),
      cached: asNumber(total.cached_input_tokens),
      cacheWrite: asNumber(total.cache_write_input_tokens)
    },
    reportsCacheWrite: typeof total.cache_write_input_tokens === "number"
  };
}

/** The cumulative total a line carries, for the two line types that carry one. */
function readingOfLine(sniffed: { kind: string; subtype: string | null; payload: Record<string, unknown> }): TokenReading | null {
  if (sniffed.kind === "event_msg" && sniffed.subtype === "token_count") {
    return readingOf(asRecord(sniffed.payload.info)?.total_token_usage);
  }
  if (sniffed.kind === "token_usage_record") return readingOf(sniffed.payload.thread_token_usage);
  return null;
}

/** Folds one of a thread's own totals into its counter. The first reading
 * after a fork's replay decides whether the counter carried on from the
 * parent's figure or restarted; see `TokenTrack`. */
function foldOwnReading(track: TokenTrack, reading: TokenReading): void {
  if (track.replayed && !track.settled && reading.totals.input < track.replayed.input) {
    track.replayed = null;
  }
  track.settled = true;
  track.seen = true;
  if (reading.reportsCacheWrite) track.cacheWriteSeen = true;
  track.own = maxTokens(track.own, reading.totals);
}

interface SessionFold {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  sourceVersion: string | null;
  /** Whether a rollout of the thread itself (not one of its subagents) has
   * been read. A fold can be seeded by a subagent that sorts first; the
   * thread's own `session_meta` then takes over cwd and branch. */
  hasPrimary: boolean;
  firstTs: string | null;
  lastTs: string | null;
  humanPrompts: number;
  afterHoursPrompts: number;
  assistantTurns: number;
  toolResults: number;
  unknownLines: number;
  metaLines: number;
  unparsedLines: number;
  /** The thread's own counter, across all its pages. */
  tokens: TokenTrack;
  /** One counter per subagent thread folded in, keyed by its own id. Its
   * size is the number of subagent threads. */
  subagentThreads: Map<string, TokenTrack>;
  subagentPrompts: number;
  subagentAssistantTurns: number;
  subagentToolCallCount: number;
  models: Map<string, number>;
  lastModel: string | null;
  modelSwitchCount: number;
  /** `turn_context.effort` on the session's own turns. See effortFold.ts. */
  effort: EffortTrack;
  compactedItems: number;
  contextCompactedEvents: number;
  toolResultErrorCount: number;
  /** Failed tool outputs on the session's own thread, the same basis as
   * `toolCallCount - subagentToolCallCount`. */
  mainThreadToolFailureCount: number;
  /** `session_meta.model_provider` from the session's own first rollout. */
  modelProvider: string | null;
  apiErrorCount: number;
  contextWindowPeakTokens: number;
  contextWindowTokens: number;
  toolCallCount: number;
  toolCalls: { at: string; name: string }[];
  /** Turns whose recorded duration reaches the live hooks' long-turn bucket. */
  longTurns: { at: string; durationBucket: string }[];
  timelinePoints: ActiveInstant[];
  undatedTimelineLines: number;
  humanPromptTimestamps: (string | null)[];
}

function newFold(sessionId: string): SessionFold {
  return {
    sessionId,
    cwd: null,
    gitBranch: null,
    sourceVersion: null,
    hasPrimary: false,
    firstTs: null,
    lastTs: null,
    humanPrompts: 0,
    afterHoursPrompts: 0,
    assistantTurns: 0,
    toolResults: 0,
    unknownLines: 0,
    metaLines: 0,
    unparsedLines: 0,
    tokens: newTokenTrack(),
    subagentThreads: new Map(),
    subagentPrompts: 0,
    subagentAssistantTurns: 0,
    subagentToolCallCount: 0,
    models: new Map(),
    lastModel: null,
    modelSwitchCount: 0,
    effort: newEffortTrack(),
    compactedItems: 0,
    contextCompactedEvents: 0,
    toolResultErrorCount: 0,
    mainThreadToolFailureCount: 0,
    modelProvider: null,
    apiErrorCount: 0,
    contextWindowPeakTokens: 0,
    contextWindowTokens: 0,
    toolCallCount: 0,
    toolCalls: [],
    longTurns: [],
    timelinePoints: [],
    undatedTimelineLines: 0,
    humanPromptTimestamps: []
  };
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sessionDurationMs(fold: SessionFold): number | null {
  if (!fold.firstTs || !fold.lastTs) return null;
  const ms = Date.parse(fold.lastTs) - Date.parse(fold.firstTs);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Same shared bucketer the other extractors route through — see
 * `claudeCode.ts` for why a local vocabulary is not an option. */
function durationBucketOf(fold: SessionFold): string {
  const ms = sessionDurationMs(fold);
  if (ms === null) return "unknown";
  return bucketDurationMs(ms) ?? "unknown";
}

/** The extractor's active-gap threshold: the same five minutes
 * `claudeCode.ts` documents, so one definition of "active" reaches both
 * stores' session and per-day figures. */
const ACTIVE_GAP_MS = DEFAULT_ACTIVE_GAP_MS;

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
 * The duration buckets the live Codex hooks' `Stop` mapping turns into
 * `agent_loop_long`. Mirrored as the same bucket names rather than a
 * threshold in minutes, so the historical and live rows agree by
 * construction on where "long" starts.
 */
const LONG_TURN_BUCKETS = new Set(["30-60m", "60m+"]);

/** A rollout's name with its extension off: `.jsonl`, or `.jsonl.zst` when
 * history compression is on. */
function rolloutBaseName(fileName: string): string {
  const base = path.basename(fileName);
  if (base.endsWith(".jsonl.zst")) return base.slice(0, -".jsonl.zst".length);
  if (base.endsWith(".jsonl")) return base.slice(0, -".jsonl".length);
  return base;
}

/** Session id from a rollout filename — `rollout-<YYYY-MM-DDTHH-MM-SS>-<id>.jsonl`.
 * A paginated continuation is `rollout-<ts>-<id>_<rollout>.jsonl` and names
 * the same thread, so the `_<rollout>` suffix comes off. Thread ids are
 * UUIDs and carry no underscore. The store's own `session_meta.id`
 * overrides the filename when the two disagree. */
export function sessionIdFromRolloutName(fileName: string): string {
  const base = rolloutBaseName(fileName);
  const match = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/.exec(base);
  if (!match) return base;
  const underscore = match[1].indexOf("_");
  return underscore > 0 ? match[1].slice(0, underscore) : match[1];
}

/**
 * What a rollout's first `session_meta` says about the thread it belongs to.
 *
 *  - `threadId`: `id`, else the filename's id.
 *  - `forkedFromId`: set on a fork. The fork's rollout opens with its own
 *    `session_meta`, then replays the parent's history in one burst: the
 *    parent's `session_meta`, `user_message`s and cumulative
 *    `token_count`s. Those are the parent's, already counted on the parent.
 *  - `subagentParentId` / `isSubagent`: a thread the agent spawned. Newer
 *    builds write `thread_source: "subagent"`; older ones write
 *    `source: { subagent: … }`, with the spawning thread under
 *    `thread_spawn.parent_thread_id`. A subagent isn't a session of its own,
 *    the same rule `claudeCode.ts` applies to sidechains.
 *  - `isContinuation`: a later page of a paginated thread
 *    (`history_mode: "paginated"` with a `history_base`). It carries on the
 *    thread rather than starting one, so it never opens with a replay.
 */
export interface RolloutIdentity {
  threadId: string;
  forkedFromId: string | null;
  isSubagent: boolean;
  subagentParentId: string | null;
  isContinuation: boolean;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function rolloutIdentityOf(meta: Record<string, unknown> | null, fileName: string): RolloutIdentity {
  const threadId = nonEmptyString(meta?.id) ?? sessionIdFromRolloutName(fileName);
  if (!meta) {
    return { threadId, forkedFromId: null, isSubagent: false, subagentParentId: null, isContinuation: false };
  }
  const source = asRecord(meta.source);
  const subagentSource = source && "subagent" in source ? source.subagent : undefined;
  const isSubagent = meta.thread_source === "subagent" || subagentSource !== undefined;
  let subagentParentId: string | null = null;
  if (isSubagent) {
    const spawn = asRecord(asRecord(subagentSource)?.thread_spawn) ?? asRecord(meta.thread_spawn);
    subagentParentId = nonEmptyString(meta.parent_thread_id) ?? nonEmptyString(spawn?.parent_thread_id);
    if (subagentParentId === threadId) subagentParentId = null;
  }
  const historyBase = meta.history_base;
  const isContinuation =
    meta.history_mode === "paginated" && historyBase !== undefined && historyBase !== null && historyBase !== "";
  const forkedFromId = nonEmptyString(meta.forked_from_id);
  return {
    threadId,
    forkedFromId: forkedFromId === threadId ? null : forkedFromId,
    isSubagent,
    subagentParentId,
    isContinuation
  };
}

/** The session a rollout folds into: its own thread, or for a subagent the
 * thread that spawned it. A subagent whose parent isn't named folds under
 * its own id, with its prompts still counted as subagent prompts. */
export function sessionKeyOf(identity: RolloutIdentity): string {
  return identity.isSubagent && identity.subagentParentId ? identity.subagentParentId : identity.threadId;
}

/**
 * How close together the lines of a fork's replay are. The replay is written
 * in one go when the fork starts, so its lines sit within milliseconds of
 * each other, or carry the parent's older timestamps. The fork's own work
 * starts at the first line that lands later than this after the replay.
 */
export const FORK_REPLAY_BURST_MS = 1_000;

function compactionCountOf(fold: SessionFold): number {
  return fold.compactedItems > 0 ? fold.compactedItems : fold.contextCompactedEvents;
}

/**
 * The counter a `token_usage_record` belongs on, by its `thread_id`. Absent or
 * naming this rollout's own thread, it's this rollout's counter. Naming the
 * session's main thread or a subagent thread already folded in, it's that
 * thread's. A thread this session hasn't seen is left out: its figure is
 * cumulative for a thread whose rollout wasn't read here, and no counter
 * here can hold it without guessing.
 */
function trackForThread(
  fold: SessionFold,
  identity: RolloutIdentity,
  current: TokenTrack,
  threadId: string | null
): TokenTrack | null {
  if (threadId === null || threadId === identity.threadId) return current;
  if (threadId === fold.sessionId) return fold.tokens;
  return fold.subagentThreads.get(threadId) ?? null;
}

/**
 * Folds one rollout's lines into the session they belong to. A thread's
 * own rollouts (its first page and any continuations) count as before. A
 * subagent's rollout folds into its parent the way a Claude Code sidechain
 * does: its `user_message`s are the parent agent's task text, counted as
 * `subagentPrompts` and never as human prompts; its tool calls, failures,
 * tokens and active time are real work done for the session and count
 * toward it, with a `subagent*` breakdown beside them. Turn-level figures
 * (long turns, compactions, context peak, model switches) stay the
 * thread's own, since a subagent's turn runs inside one of the parent's.
 */
async function foldLinesInto(fold: SessionFold, lines: AsyncIterable<string>, identity: RolloutIdentity): Promise<void> {
  const sub = identity.isSubagent;
  let track = fold.tokens;
  if (sub) {
    const existing = fold.subagentThreads.get(identity.threadId);
    track = existing ?? newTokenTrack();
    if (!existing) fold.subagentThreads.set(identity.threadId, track);
  }
  let ownMetaSeen = false;
  let replaying = false;
  let lastReplayMs: number | null = null;

  for await (const line of lines) {
    const sniffed = sniffCodexLine(line);
    if (sniffed.kind === "unparsed") {
      if (line.trim() !== "") fold.unparsedLines += 1;
      continue;
    }
    if (sniffed.kind === "meta") {
      fold.metaLines += 1;
      continue;
    }
    if (sniffed.kind === "unknown") {
      fold.unknownLines += 1;
      continue;
    }
    if (replaying) {
      const ms = sniffed.occurredAt ? Date.parse(sniffed.occurredAt) : NaN;
      if (!Number.isFinite(ms) || lastReplayMs === null || ms <= lastReplayMs + FORK_REPLAY_BURST_MS) {
        // The parent's history, replayed. Recognised and skipped, like any
        // other meta line, except that its running token total is kept so
        // the fork's own counter can be told apart from it.
        if (Number.isFinite(ms)) lastReplayMs = Math.max(lastReplayMs ?? ms, ms);
        fold.metaLines += 1;
        const replayed = readingOfLine(sniffed);
        if (replayed) track.replayed = maxTokens(track.replayed ?? NO_TOKENS, replayed.totals);
        continue;
      }
      replaying = false;
    }
    if (sniffed.occurredAt) {
      if (!fold.firstTs || sniffed.occurredAt < fold.firstTs) fold.firstTs = sniffed.occurredAt;
      if (!fold.lastTs || sniffed.occurredAt > fold.lastTs) fold.lastTs = sniffed.occurredAt;
    }
    const payload = sniffed.payload;
    let humanHere = false;
    switch (sniffed.kind) {
      case "session_meta": {
        // Only the rollout's first `session_meta` is its own. A later one is
        // replayed parent history or a repeated header, and must not rename
        // the session: before, the last one seen won, which filed a fork's
        // work under its parent's id.
        if (ownMetaSeen) break;
        ownMetaSeen = true;
        const takeOver = !sub && !fold.hasPrimary;
        if (typeof payload.cwd === "string" && (takeOver || !fold.cwd)) fold.cwd = payload.cwd;
        if (typeof payload.cli_version === "string" && (!sub || !fold.sourceVersion)) {
          fold.sourceVersion = payload.cli_version;
        }
        const git = asRecord(payload.git);
        if (git && typeof git.branch === "string" && (takeOver || !fold.gitBranch)) fold.gitBranch = git.branch;
        // Which provider served the session, read only to map onto a route
        // word. A provider someone named in their own config never leaves as
        // that name: see modelRouteFromCodexProvider.
        if (!sub && typeof payload.model_provider === "string" && (takeOver || !fold.modelProvider)) {
          fold.modelProvider = payload.model_provider;
        }
        if (!sub) fold.hasPrimary = true;
        if (identity.forkedFromId && !identity.isContinuation) {
          replaying = true;
          const ms = sniffed.occurredAt ? Date.parse(sniffed.occurredAt) : NaN;
          lastReplayMs = Number.isFinite(ms) ? ms : null;
        }
        break;
      }
      case "turn_context": {
        if (typeof payload.cwd === "string" && !fold.cwd) fold.cwd = payload.cwd;
        const model = typeof payload.model === "string" && payload.model !== "" ? payload.model : null;
        if (model) {
          fold.models.set(model, (fold.models.get(model) ?? 0) + 1);
          if (!sub) {
            if (fold.lastModel && fold.lastModel !== model) fold.modelSwitchCount += 1;
            fold.lastModel = model;
          }
        }
        // The session's own turns only: a subagent thread runs at its own
        // setting, and its turns would vote in someone else's primary.
        if (!sub) foldEffort(fold.effort, payload.effort, sniffed.occurredAt);
        break;
      }
      case "compacted": {
        if (!sub) fold.compactedItems += 1;
        break;
      }
      case "token_usage_record": {
        // The thread's running total again, beside the `token_count` that
        // carries the same figure. Folded by max like it, so no pairing is
        // needed, and a rollout that writes only this line still has totals.
        // `usage` and `turn_token_usage` are per response and per turn, and
        // nothing here needs them.
        const reading = readingOf(payload.thread_token_usage);
        const target = trackForThread(fold, identity, track, nonEmptyString(payload.thread_id));
        if (reading && target) foldOwnReading(target, reading);
        break;
      }
      case "event_msg": {
        switch (sniffed.subtype) {
          case "user_message": {
            if (!isHumanUserMessage(payload)) break;
            if (sub) {
              fold.subagentPrompts += 1;
              break;
            }
            fold.humanPrompts += 1;
            if (sniffed.occurredAt && isOutsideBusinessHours(new Date(sniffed.occurredAt))) {
              fold.afterHoursPrompts += 1;
            }
            fold.humanPromptTimestamps.push(sniffed.occurredAt);
            humanHere = true;
            break;
          }
          case "token_count": {
            const info = asRecord(payload.info);
            if (!info) break;
            const reading = readingOf(info.total_token_usage);
            if (reading) foldOwnReading(track, reading);
            if (sub) break;
            const last = asRecord(info.last_token_usage);
            if (last) {
              const context = asNumber(last.input_tokens);
              if (context > fold.contextWindowPeakTokens) fold.contextWindowPeakTokens = context;
            }
            const window = asNumber(info.model_context_window);
            if (window > fold.contextWindowTokens) fold.contextWindowTokens = window;
            break;
          }
          case "task_started":
          case "turn_started": {
            if (sub) break;
            const window = asNumber(payload.model_context_window);
            if (window > fold.contextWindowTokens) fold.contextWindowTokens = window;
            break;
          }
          case "task_complete":
          case "turn_complete": {
            if (sub) break;
            const bucket = bucketDurationMs(asNumber(payload.duration_ms));
            if (bucket && LONG_TURN_BUCKETS.has(bucket) && sniffed.occurredAt) {
              fold.longTurns.push({ at: sniffed.occurredAt, durationBucket: bucket });
            }
            break;
          }
          case "context_compacted": {
            if (!sub) fold.contextCompactedEvents += 1;
            break;
          }
          case "error": {
            fold.apiErrorCount += 1;
            break;
          }
          default:
            break; // agent_message, agent_reasoning, …: timeline only.
        }
        break;
      }
      case "response_item": {
        const subtype = sniffed.subtype ?? "";
        if (TOOL_CALL_ITEM_TYPES.has(subtype)) {
          fold.toolCallCount += 1;
          if (sub) fold.subagentToolCallCount += 1;
          // An undated call still counts but cannot be placed on a rail —
          // an event would have to invent an instant to exist at all.
          if (sniffed.occurredAt) {
            fold.toolCalls.push({ at: sniffed.occurredAt, name: toolCallNameOf(subtype, payload) });
          }
        } else if (TOOL_OUTPUT_ITEM_TYPES.has(subtype)) {
          fold.toolResults += 1;
          if (isToolOutputFailure(payload)) {
            fold.toolResultErrorCount += 1;
            if (!sub) fold.mainThreadToolFailureCount += 1;
          }
        } else if (subtype === "message" && payload.role === "assistant") {
          if (sub) fold.subagentAssistantTurns += 1;
          else fold.assistantTurns += 1;
        }
        // `message` with role user/developer: the prompt is counted off its
        // `user_message` event, and the rest is injected context. Timeline
        // only, like reasoning and the compaction items.
        break;
      }
      default:
        break;
    }
    if (sniffed.occurredAt) {
      const ms = Date.parse(sniffed.occurredAt);
      if (Number.isFinite(ms)) {
        // No posture: the rollout records approval_policy and
        // sandbox_policy, not permission_mode, and the live hooks leave
        // those unmapped on purpose. Null here is what puts every
        // supervising minute in the `unknown` band, as the header says.
        // `agentOutput` as the complement of `human` is the nearest-line
        // rule, stated rather than defaulted: this extractor has not
        // classified which rollout lines are the runtime's bookkeeping
        // (`turn_context`, the injected `user_message` kinds) and which are
        // the agent's output, so the human turn cannot start from the right
        // line yet. Its handoff stamps `handsOnBoundary: "nearest_line"` for
        // the same reason. Classifying them is the next step, and the
        // Claude Code extractor is the worked example.
        fold.timelinePoints.push({
          at: ms,
          human: humanHere,
          agentOutput: !humanHere,
          autonomyMode: null
        });
      } else {
        fold.undatedTimelineLines += 1;
      }
    }
  }
}

/**
 * Decompression for `.jsonl.zst` rollouts, which Codex writes when history
 * compression is on. Node's own zlib gained zstd in 22.15 and 23.8; this
 * package supports Node 20, so the built-in is feature-detected and used
 * where it exists. Elsewhere the `zstd` CLI is tried, since it's commonly
 * installed and costs this package no dependency. With neither, the file
 * can't be read and is counted in `unreadableRolloutFiles` like any other
 * rollout this run couldn't open, so the window says it's short.
 *
 * `ZstdDecoder` pins the choice. `auto` is the order above; `node` and `cli`
 * use only that decoder; `none` reads no `.zst` at all. The extractor takes
 * it as an option, and `ASCENDA_ZSTD_DECODER` sets it for a whole run, which
 * is how the tests reach the CLI path on a Node that has the built-in, and
 * how someone can rule a decoder out when chasing a bad read.
 */
export type ZstdDecoder = "auto" | "node" | "cli" | "none";
const ZSTD_DECODERS: readonly ZstdDecoder[] = ["auto", "node", "cli", "none"];

type ZstdDecompressStream = () => NodeJS.ReadWriteStream;
const nodeCreateZstdDecompress = (zlib as unknown as { createZstdDecompress?: ZstdDecompressStream }).createZstdDecompress;

/** The decoder an option or `ASCENDA_ZSTD_DECODER` names. An unrecognised
 * value falls back to `auto` rather than failing the whole store. */
export function zstdDecoderOf(choice: string | undefined): ZstdDecoder {
  const value = choice?.trim().toLowerCase();
  return ZSTD_DECODERS.find((d) => d === value) ?? "auto";
}

/** Lines out of a byte stream, split on `\n`, decoded as UTF-8 across chunk
 * boundaries. Iterating the stream directly, rather than through `readline`,
 * means a read or decode error ends the loop with that error. */
async function* linesOf(chunks: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  for await (const chunk of chunks) {
    rest += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let from = 0;
    let nl = rest.indexOf("\n", from);
    while (nl >= 0) {
      yield rest.slice(from, nl);
      from = nl + 1;
      nl = rest.indexOf("\n", from);
    }
    rest = rest.slice(from);
  }
  rest += decoder.end();
  if (rest !== "") yield rest;
}

/** A `.jsonl.zst` rollout's lines, decoded as they're read. */
async function* zstdLines(filePath: string, decoder: ZstdDecoder): AsyncGenerator<string> {
  if (decoder === "none") throw new Error("zstd decoding is turned off");
  if ((decoder === "auto" || decoder === "node") && typeof nodeCreateZstdDecompress === "function") {
    // `pipeline` destroys the decoder with the source's error, so a failed
    // read surfaces in the loop instead of ending it early and quietly.
    const decoded = pipeline(createReadStream(filePath), nodeCreateZstdDecompress(), () => {});
    yield* linesOf(decoded as AsyncIterable<Buffer>);
    return;
  }
  if (decoder === "node") throw new Error("this Node has no built-in zstd");
  const child = spawn("zstd", ["-dcq", "--", filePath], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  exited.catch(() => {});
  try {
    yield* linesOf(child.stdout);
  } finally {
    if (child.exitCode === null) child.kill();
  }
  const code = await exited;
  if (code !== 0) throw new Error(`zstd exited with ${code}`);
}

/**
 * A rollout's lines, streamed: a plain `.jsonl` straight off disk, a
 * `.jsonl.zst` through the decoder. Nothing holds the whole file, so a
 * rollout past V8's string limit reads like any other. A file that fails
 * partway throws from the loop; `extractCodex` folds each file into a copy
 * of its session and keeps the copy only when the file read to the end, so a
 * failed read leaves nothing half-counted.
 */
function readRolloutLines(filePath: string, decoder: ZstdDecoder): AsyncIterable<string> {
  if (filePath.endsWith(".zst")) return zstdLines(filePath, decoder);
  return linesOf(createReadStream(filePath));
}

/** The lines of `head`, then the rest of `tail`. */
async function* chainLines(head: string[], tail: AsyncIterator<string>): AsyncGenerator<string> {
  yield* head;
  for (let next = await tail.next(); !next.done; next = await tail.next()) yield next.value;
}

/**
 * Reads a rollout up to its first `session_meta`, which names the thread
 * and so the session the rest folds into. Returns that meta and the lines
 * again from the top. On every rollout observed the meta is the first line,
 * so the buffer holds one line.
 */
async function openRollout(
  filePath: string,
  decoder: ZstdDecoder
): Promise<{ meta: Record<string, unknown> | null; lines: AsyncIterable<string> }> {
  const iterator = readRolloutLines(filePath, decoder)[Symbol.asyncIterator]();
  const head: string[] = [];
  let meta: Record<string, unknown> | null = null;
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
    head.push(next.value);
    const sniffed = sniffCodexLine(next.value);
    if (sniffed.kind === "session_meta") {
      meta = sniffed.payload;
      break;
    }
  }
  return { meta, lines: chainLines(head, iterator) };
}

export interface ExtractCodexOptions {
  /** How `.jsonl.zst` rollouts are decoded. Defaults to
   * `ASCENDA_ZSTD_DECODER`, then `auto`. */
  zstdDecoder?: ZstdDecoder;
}

/** Every `.jsonl` and `.jsonl.zst` under `root`, recursively. */
async function walkRolloutFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * The rollouts to read, in reading order. A `.jsonl.zst` beside a `.jsonl`
 * of the same name is the same rollout mid-compression, so only the plain
 * one is kept. The order is by filename, whose timestamp prefix puts a
 * thread's first page before its continuations, then by full path.
 */
export function rolloutReadingOrder(files: string[]): string[] {
  const plain = new Set(files.filter((f) => f.endsWith(".jsonl")));
  return files
    .filter((f) => !(f.endsWith(".jsonl.zst") && plain.has(f.slice(0, -".zst".length))))
    .sort((a, b) => {
      const byName = rolloutBaseName(a).localeCompare(rolloutBaseName(b));
      return byName !== 0 ? byName : a.localeCompare(b);
    });
}

/** A rollout found under one of the snapshot roots, with its size on disk. */
export interface FoundRollout {
  file: string;
  root: (typeof CODEX_SNAPSHOT_DIRS)[number];
  size: number;
}

/**
 * One copy of each rollout. A rollout whose name (with `.zst` off) sits under
 * both `sessions/` and `archived_sessions/` is one rollout caught mid-archive
 * or restored by hand, and reading both would count its prompts, tool calls
 * and turns twice. The plain copy wins over a compressed one, since their
 * sizes can't be compared. Otherwise the larger wins, because a copy caught
 * mid-move is the shorter one, and on a tie the `sessions/` copy. Returns the
 * kept files in the order given, and how many were dropped.
 */
export function dropDuplicateRollouts(found: FoundRollout[]): { files: string[]; duplicates: number } {
  const keep = new Map<string, FoundRollout>();
  const beats = (a: FoundRollout, b: FoundRollout): boolean => {
    const aPlain = a.file.endsWith(".jsonl");
    const bPlain = b.file.endsWith(".jsonl");
    if (aPlain !== bPlain) return aPlain;
    if (a.size !== b.size) return a.size > b.size;
    return a.root === "sessions" && b.root !== "sessions";
  };
  for (const entry of found) {
    const name = rolloutBaseName(entry.file);
    const held = keep.get(name);
    if (!held || (held.root !== entry.root && beats(entry, held))) keep.set(name, entry);
  }
  const kept = new Set([...keep.values()].map((e) => e.file));
  // Two files of one name under the same root (a `.zst` beside its plain
  // twin) were already settled by `rolloutReadingOrder`; only the cross-root
  // pairs count here.
  const files = found.filter((e) => kept.has(e.file) || !crossRootTwin(e, keep)).map((e) => e.file);
  return { files, duplicates: found.length - files.length };
}

function crossRootTwin(entry: FoundRollout, keep: Map<string, FoundRollout>): boolean {
  const held = keep.get(rolloutBaseName(entry.file));
  return held !== undefined && held.root !== entry.root;
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

/** The two roots a snapshot may hold; either may be absent. */
export const CODEX_SNAPSHOT_DIRS = ["sessions", "archived_sessions"] as const;

export async function* extractCodex(
  snapshotDir: string,
  extractionId: string,
  options: ExtractCodexOptions = {}
): AsyncIterable<NormalizedHistoricalEvent> {
  const zstdDecoder = options.zstdDecoder ?? zstdDecoderOf(process.env.ASCENDA_ZSTD_DECODER);
  const walked: string[] = [];
  const rootOf = new Map<string, FoundRollout["root"]>();
  for (const dir of CODEX_SNAPSHOT_DIRS) {
    for (const file of await walkRolloutFiles(path.join(snapshotDir, dir))) {
      walked.push(file);
      rootOf.set(file, dir);
    }
  }
  if (walked.length === 0) return;
  const ordered: FoundRollout[] = [];
  for (const file of rolloutReadingOrder(walked)) {
    // A file that can't be statted sizes as -1, so a readable twin wins; the
    // read below then says whether it opens.
    const size = await fs.stat(file).then((st) => st.size, () => -1);
    ordered.push({ file, root: rootOf.get(file) ?? "sessions", size });
  }
  const { files, duplicates: duplicateRolloutFiles } = dropDuplicateRollouts(ordered);

  let windowOldest: string | null = null;
  let windowNewest: string | null = null;
  let sessionCount = 0;
  let unreadableRolloutFiles = 0;

  // One fold per session, not per file: a thread's continuation pages and
  // the subagent threads it spawned all land in the same one. Map order is
  // first-seen order, which keeps the output deterministic.
  const folds = new Map<string, SessionFold>();
  for (const file of files) {
    try {
      const { meta, lines } = await openRollout(file, zstdDecoder);
      const identity = rolloutIdentityOf(meta, file);
      const key = sessionKeyOf(identity);
      // Folded into a copy, kept only once the whole file has read, so a
      // rollout that fails partway leaves nothing half-counted in a session
      // other rollouts also feed.
      const existing = folds.get(key);
      const working = existing ? structuredClone(existing) : newFold(key);
      await foldLinesInto(working, lines, identity);
      folds.set(key, working);
    } catch {
      // A rollout that cannot be opened, read or decompressed is a hole in
      // the window, and the epoch marker is the only place that can say so.
      unreadableRolloutFiles += 1;
    }
  }

  for (const fold of folds.values()) {
    if (!fold.firstTs || !fold.lastTs) continue;
    sessionCount += 1;
    if (!windowOldest || fold.firstTs < windowOldest) windowOldest = fold.firstTs;
    if (!windowNewest || fold.lastTs > windowNewest) windowNewest = fold.lastTs;
    const repoRef = fold.cwd;

    for (const ts of fold.humanPromptTimestamps) {
      if (!ts) continue;
      yield {
        occurredAt: ts,
        store: "codex",
        sourceVersion: fold.sourceVersion,
        sessionRef: fold.sessionId,
        repoRef,
        eventKind: "ai_prompt_submitted",
        metrics: {},
        provenance: HISTORICAL_PROVENANCE.direct,
        extractionId
      };
    }

    for (const call of fold.toolCalls) {
      yield {
        occurredAt: call.at,
        store: "codex",
        sourceVersion: fold.sourceVersion,
        sessionRef: fold.sessionId,
        repoRef,
        eventKind: "ai_tool_call_started",
        metrics: { toolName: call.name },
        provenance: HISTORICAL_PROVENANCE.direct,
        extractionId
      };
    }

    for (const turn of fold.longTurns) {
      yield {
        occurredAt: turn.at,
        store: "codex",
        sourceVersion: fold.sourceVersion,
        sessionRef: fold.sessionId,
        repoRef,
        eventKind: "agent_loop_long",
        metrics: { durationBucket: turn.durationBucket },
        provenance: HISTORICAL_PROVENANCE.direct,
        extractionId
      };
    }

    const durationMs = sessionDurationMs(fold);
    const toolFailureCount = fold.toolResultErrorCount + fold.apiErrorCount;
    const split = splitActiveTime(fold.timelinePoints, { activeGapMs: ACTIVE_GAP_MS });
    const compactionCount = compactionCountOf(fold);
    const own = ownTokensOf(fold.tokens);
    const subagent = { ...NO_TOKENS };
    let subagentUncached = 0;
    for (const track of fold.subagentThreads.values()) {
      const spent = ownTokensOf(track);
      subagent.input += spent.input;
      subagent.output += spent.output;
      subagent.cached += spent.cached;
      subagent.cacheWrite += spent.cacheWrite;
      subagentUncached += uncachedInputOf(spent);
    }
    const sessionMetrics: NormalizedHistoricalEvent["metrics"] = {
      promptCount: fold.humanPrompts,
      assistantTurns: fold.assistantTurns,
      toolCallCount: fold.toolCallCount,
      toolResultCount: fold.toolResults,
      durationBucket: durationBucketOf(fold),
      afterHoursPrompts: fold.afterHoursPrompts,
      unknownLines: fold.unknownLines,
      metaLines: fold.metaLines,
      unparsedLines: fold.unparsedLines,
      modelCount: fold.models.size,
      modelSwitchCount: fold.modelSwitchCount,
      compactionCount,
      toolResultErrorCount: fold.toolResultErrorCount,
      apiErrorCount: fold.apiErrorCount,
      toolFailureCount,
      contextWindowPeakTokens: fold.contextWindowPeakTokens,
      rapidRepromptCount: rapidRepromptCountOf(fold),
      activeMinutes: minutesOf(split.handsOnMs + split.agentSupervisingMs),
      handsOnMinutes: minutesOf(split.handsOnMs),
      agentSupervisingMinutes: minutesOf(split.agentSupervisingMs),
      activeSplitInstants: split.instants,
      activeSplitUndatedLines: fold.undatedTimelineLines,
      activeSplitUnposturedInstants: split.unposturedInstants
    };
    // Token keys only where some thread of the session reported a total.
    // Without one the figures are unmeasured, and shipping 0 would read as a
    // session that spent nothing. The flag says why the keys are missing, and
    // isn't set when a subagent thread did report tokens.
    const subagentSeen = [...fold.subagentThreads.values()].some((track) => track.seen);
    if (fold.tokens.seen || subagentSeen) {
      sessionMetrics.inputTokens = uncachedInputOf(own) + subagentUncached;
      sessionMetrics.outputTokens = own.output + subagent.output;
      sessionMetrics.cacheReadTokens = own.cached + subagent.cached;
      const cacheWriteSeen =
        fold.tokens.cacheWriteSeen || [...fold.subagentThreads.values()].some((track) => track.cacheWriteSeen);
      if (cacheWriteSeen) sessionMetrics.cacheCreationTokens = own.cacheWrite + subagent.cacheWrite;
    } else {
      sessionMetrics.tokensNotCollected = true;
    }
    // The subagent breakdown only on a session that had one, so a session
    // that didn't carries no row of zeros. `subagentTokensTotal` is
    // everything the subagents consumed: input with its cached and
    // cache-written parts, plus output.
    if (fold.subagentThreads.size > 0) {
      sessionMetrics.subagentTranscripts = fold.subagentThreads.size;
      sessionMetrics.subagentPrompts = fold.subagentPrompts;
      sessionMetrics.subagentAssistantTurns = fold.subagentAssistantTurns;
      if (subagentSeen) sessionMetrics.subagentTokensTotal = subagent.input + subagent.output;
      sessionMetrics.subagentToolCallCount = fold.subagentToolCallCount;
    }
    // The ratio only where the store named its own denominator. Claude Code
    // has to assume one; this store does not, and computing against a guess
    // when the real figure is usually right there would be a step backwards.
    if (fold.contextWindowTokens > 0) {
      sessionMetrics.contextWindowTokens = fold.contextWindowTokens;
      sessionMetrics.contextWindowPeakPct =
        Math.round((fold.contextWindowPeakTokens / fold.contextWindowTokens) * 1000) / 1000;
    }
    if (durationMs !== null) sessionMetrics.sessionMinutes = Math.round(durationMs / 60_000);
    sessionMetrics.sessionStartedAt = fold.firstTs;
    const primaryModel = topModel(fold.models);
    if (primaryModel) sessionMetrics.primaryModel = primaryModel;
    // The whole mix, bounded, beside the dominant model. See modelTurns.ts.
    Object.assign(sessionMetrics, modelTurnsMetrics(fold.models));
    // The provider the rollout recorded, as a route word; the slug's own
    // prefix where the rollout recorded none.
    const modelRoute = modelRouteFromCodexProvider(fold.modelProvider) ?? modelRouteFromSlug(primaryModel);
    if (modelRoute) sessionMetrics.modelRoute = modelRoute;
    // Calls and failures on one basis, the session's own thread. The
    // existing `toolCallCount` and `toolFailureCount` include subagent
    // threads, and the failure count adds the runtime's own errors.
    sessionMetrics.mainThreadToolCallCount = fold.toolCallCount - fold.subagentToolCallCount;
    sessionMetrics.mainThreadToolFailureCount = fold.mainThreadToolFailureCount;
    const primaryEffort = primaryEffortOf(fold.effort);
    if (primaryEffort) sessionMetrics.primaryEffort = primaryEffort;
    const effortChanges = effortChangesOf(fold.effort);
    if (fold.gitBranch) sessionMetrics.gitBranch = fold.gitBranch;
    yield {
      occurredAt: fold.lastTs,
      store: "codex",
      sourceVersion: fold.sourceVersion,
      sessionRef: fold.sessionId,
      repoRef,
      eventKind: "create_focus_session",
      metrics: sessionMetrics,
      dayBreakdown: sliceSessionByLocalDay(fold.humanPromptTimestamps, {
        activeGapMs: ACTIVE_GAP_MS,
        activeInstants: fold.timelinePoints
      }),
      // Local-only; see `NormalizedHistoricalEvent.activeSpans`. Same
      // threshold, same function, same spans the split above was summed from.
      activeSpans: activeSpans(fold.timelinePoints, { activeGapMs: ACTIVE_GAP_MS }).spans,
      autonomySplit: Object.fromEntries(
        Object.entries(split.supervisingMsByBand).map(([band, ms]) => [band, minutesOf(ms)])
      ),
      ...(effortChanges.length > 0 ? { effortChanges } : {}),
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };

    if (fold.afterHoursPrompts > 0) {
      yield {
        occurredAt: fold.lastTs,
        store: "codex",
        sourceVersion: fold.sourceVersion,
        sessionRef: fold.sessionId,
        repoRef,
        eventKind: "after_hours_ai_session",
        metrics: { afterHoursPrompts: fold.afterHoursPrompts },
        provenance: HISTORICAL_PROVENANCE.derived,
        extractionId
      };
    }
    if (toolFailureCount > 0) {
      yield {
        occurredAt: fold.lastTs,
        store: "codex",
        sourceVersion: fold.sourceVersion,
        sessionRef: fold.sessionId,
        repoRef,
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

  if ((windowOldest && windowNewest) || unreadableRolloutFiles > 0) {
    const window: Record<string, string> =
      windowOldest && windowNewest ? { windowOldest, windowNewest } : {};
    yield {
      occurredAt: windowNewest ?? new Date().toISOString(),
      store: "codex",
      sourceVersion: null,
      sessionRef: null,
      repoRef: null,
      eventKind: "extraction_epoch",
      metrics: { ...window, sessionCount, unreadableRolloutFiles, duplicateRolloutFiles },
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };
  }
}
