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
 * Everything the import needs sits on five top-level types:
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
 *    `last_token_usage.input_tokens` is the last request's whole input and
 *    already includes `cached_input_tokens`, so it is the context occupancy
 *    of that request; the session peak is the largest of them.
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
import { bucketDurationMs, isOutsideBusinessHours } from "@ascenda-one/tool-kit";
import { HISTORICAL_PROVENANCE, NormalizedHistoricalEvent } from "../types.js";
import { sanitizeToolName } from "../toolName.js";
import { sliceSessionByLocalDay } from "../daySlice.js";
import { minutesOf, splitActiveTime, type ActiveInstant } from "../activeSplit.js";

/** Top-level line types the extractor reads fields from. */
export const KNOWN_CODEX_LINE_TYPES = [
  "session_meta",
  "turn_context",
  "response_item",
  "event_msg",
  "compacted"
] as const;
export type CodexLineType = (typeof KNOWN_CODEX_LINE_TYPES)[number];

/**
 * Top-level types observed in real rollouts that carry nothing the import
 * needs. Recognised so they count as `metaLines`, leaving `unknownLines` to
 * mean a type nobody has classified yet — the only kind worth alerting on.
 */
export const META_CODEX_LINE_TYPES = new Set(["world_state"]);

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

interface SessionFold {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  sourceVersion: string | null;
  firstTs: string | null;
  lastTs: string | null;
  humanPrompts: number;
  afterHoursPrompts: number;
  assistantTurns: number;
  toolResults: number;
  unknownLines: number;
  metaLines: number;
  unparsedLines: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  models: Map<string, number>;
  lastModel: string | null;
  modelSwitchCount: number;
  compactedItems: number;
  contextCompactedEvents: number;
  toolResultErrorCount: number;
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
    firstTs: null,
    lastTs: null,
    humanPrompts: 0,
    afterHoursPrompts: 0,
    assistantTurns: 0,
    toolResults: 0,
    unknownLines: 0,
    metaLines: 0,
    unparsedLines: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    models: new Map(),
    lastModel: null,
    modelSwitchCount: 0,
    compactedItems: 0,
    contextCompactedEvents: 0,
    toolResultErrorCount: 0,
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
const ACTIVE_GAP_MS = 5 * 60_000;

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

/** Session id from a rollout filename — `rollout-<YYYY-MM-DDTHH-MM-SS>-<id>.jsonl`.
 * The store's own `session_meta.id` overrides it when the two disagree. */
export function sessionIdFromRolloutName(fileName: string): string {
  const base = path.basename(fileName, ".jsonl");
  const match = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/.exec(base);
  return match ? match[1] : base;
}

function compactionCountOf(fold: SessionFold): number {
  return fold.compactedItems > 0 ? fold.compactedItems : fold.contextCompactedEvents;
}

async function foldRollout(filePath: string): Promise<SessionFold> {
  const fold = newFold(sessionIdFromRolloutName(filePath));
  const handle = await fs.open(filePath);
  try {
    for await (const line of handle.readLines({ encoding: "utf8" })) {
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
      if (sniffed.occurredAt) {
        if (!fold.firstTs || sniffed.occurredAt < fold.firstTs) fold.firstTs = sniffed.occurredAt;
        if (!fold.lastTs || sniffed.occurredAt > fold.lastTs) fold.lastTs = sniffed.occurredAt;
      }
      const payload = sniffed.payload;
      let humanHere = false;
      switch (sniffed.kind) {
        case "session_meta": {
          const id = typeof payload.id === "string" ? payload.id : null;
          if (id && id !== fold.sessionId) fold.sessionId = id;
          if (typeof payload.cwd === "string" && !fold.cwd) fold.cwd = payload.cwd;
          if (typeof payload.cli_version === "string") fold.sourceVersion = payload.cli_version;
          const git = asRecord(payload.git);
          if (git && typeof git.branch === "string" && !fold.gitBranch) fold.gitBranch = git.branch;
          break;
        }
        case "turn_context": {
          if (typeof payload.cwd === "string" && !fold.cwd) fold.cwd = payload.cwd;
          const model = typeof payload.model === "string" && payload.model !== "" ? payload.model : null;
          if (model) {
            fold.models.set(model, (fold.models.get(model) ?? 0) + 1);
            if (fold.lastModel && fold.lastModel !== model) fold.modelSwitchCount += 1;
            fold.lastModel = model;
          }
          break;
        }
        case "compacted": {
          fold.compactedItems += 1;
          break;
        }
        case "event_msg": {
          switch (sniffed.subtype) {
            case "user_message": {
              if (!isHumanUserMessage(payload)) break;
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
              const total = asRecord(info.total_token_usage);
              if (total) {
                fold.inputTokens = Math.max(fold.inputTokens, asNumber(total.input_tokens));
                fold.outputTokens = Math.max(fold.outputTokens, asNumber(total.output_tokens));
                fold.cacheReadTokens = Math.max(fold.cacheReadTokens, asNumber(total.cached_input_tokens));
              }
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
              const window = asNumber(payload.model_context_window);
              if (window > fold.contextWindowTokens) fold.contextWindowTokens = window;
              break;
            }
            case "task_complete":
            case "turn_complete": {
              const bucket = bucketDurationMs(asNumber(payload.duration_ms));
              if (bucket && LONG_TURN_BUCKETS.has(bucket) && sniffed.occurredAt) {
                fold.longTurns.push({ at: sniffed.occurredAt, durationBucket: bucket });
              }
              break;
            }
            case "context_compacted": {
              fold.contextCompactedEvents += 1;
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
            // An undated call still counts but cannot be placed on a rail —
            // an event would have to invent an instant to exist at all.
            if (sniffed.occurredAt) {
              fold.toolCalls.push({ at: sniffed.occurredAt, name: toolCallNameOf(subtype, payload) });
            }
          } else if (TOOL_OUTPUT_ITEM_TYPES.has(subtype)) {
            fold.toolResults += 1;
            if (isToolOutputFailure(payload)) fold.toolResultErrorCount += 1;
          } else if (subtype === "message" && payload.role === "assistant") {
            fold.assistantTurns += 1;
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
          fold.timelinePoints.push({ at: ms, human: humanHere, autonomyMode: null });
        } else {
          fold.undatedTimelineLines += 1;
        }
      }
    }
  } finally {
    await handle.close();
  }
  return fold;
}

/** Every `.jsonl` under `root`, recursively, sorted for determinism. */
async function walkJsonlFiles(root: string): Promise<string[]> {
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
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
  await walk(root);
  return out;
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
  extractionId: string
): AsyncIterable<NormalizedHistoricalEvent> {
  const files: string[] = [];
  for (const dir of CODEX_SNAPSHOT_DIRS) {
    for (const file of await walkJsonlFiles(path.join(snapshotDir, dir))) files.push(file);
  }
  if (files.length === 0) return;

  let windowOldest: string | null = null;
  let windowNewest: string | null = null;
  let sessionCount = 0;
  let unreadableRolloutFiles = 0;

  for (const file of files) {
    let fold: SessionFold;
    try {
      fold = await foldRollout(file);
    } catch {
      // A rollout that cannot be opened or read is a hole in the window, and
      // the epoch marker is the only place that can say so.
      unreadableRolloutFiles += 1;
      continue;
    }
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
    const sessionMetrics: NormalizedHistoricalEvent["metrics"] = {
      promptCount: fold.humanPrompts,
      assistantTurns: fold.assistantTurns,
      toolCallCount: fold.toolCallCount,
      toolResultCount: fold.toolResults,
      inputTokens: fold.inputTokens,
      outputTokens: fold.outputTokens,
      cacheReadTokens: fold.cacheReadTokens,
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
      autonomySplit: Object.fromEntries(
        Object.entries(split.supervisingMsByBand).map(([band, ms]) => [band, minutesOf(ms)])
      ),
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
      metrics: { ...window, sessionCount, unreadableRolloutFiles },
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };
  }
}
