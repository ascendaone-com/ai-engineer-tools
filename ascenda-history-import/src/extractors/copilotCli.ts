/**
 * Copilot CLI session-log extractor.
 *
 * Store: `<snapshot>/<session-id>/events.jsonl` with `workspace.yaml` beside
 * it, one directory per session. Older builds left the log as a flat
 * `<session-id>.jsonl` next to the directories, in the same event shape, and
 * may still have a directory of the same id holding only `workspace.yaml`.
 * A session written both ways is read from its directory once and counted in
 * `duplicateChatSessions`.
 *
 * Every line is `{ type, data, id, timestamp, parentId }`. `type` is the
 * discriminator and `data` holds the fields. The fields read:
 *  - `session.start`: `version`, `copilotVersion`, `selectedModel`,
 *    `sessionId`, `context.{cwd,gitRoot,branch}`.
 *  - `session.model_change`: `newModel`. Older builds name the model only
 *    here and at start, never on a message.
 *  - `session.auto_mode_resolved`: `chosenModel`, the model the router picked.
 *  - `user.message`: counted, and `source`. A subagent's task arrives as a
 *    `user.message` whose `source` is `agent-…`: the parent agent wrote it,
 *    so it counts as a subagent prompt, not a person's. `content` and
 *    `transformedContent` are never read.
 *  - `assistant.message`: `model`. `content`, `reasoningText` and
 *    `encryptedContent` are never read.
 *  - `tool.execution_start`: `toolCallId`, `toolName`, `model`,
 *    `parentToolCallId` (set on a call a subagent made). `arguments` is never
 *    read.
 *  - `tool.execution_complete`: `success`. `result` is never read.
 *  - `permission.requested`: `agentMode`, `permissionMode`.
 *  - `session.compaction_complete`: `success`.
 *  - `session.shutdown`: `tokenDetails`, `modelMetrics[*].usage`,
 *    `codeChanges.{linesAdded,linesRemoved}`, the length of
 *    `codeChanges.filesModified` (never its entries), `totalApiDurationMs`.
 * From `workspace.yaml` only `cwd`, `git_root`, `branch` and `client_name`.
 * Its `name` is the session's first prompt and `summary` is the agent's own
 * account of the work; neither is read.
 *
 * `hook.start` and `hook.end` are the CLI's record of running someone's
 * hooks. They aren't work, so they're skipped whole and put no instant on the
 * timeline.
 *
 * **Version dispatch (design rule 3).** `session.start.version` is 1 on every
 * session seen, from December 2025 to October 2026, across builds that wrote
 * `copilotVersion: "unknown"` and builds that wrote a real one. A session
 * whose start names another version, or that has no `session.start` at all,
 * is not read: it's counted in `unparsedChatSessionFiles` on the epoch, its
 * raw log stays in staging, and nothing is inferred from it.
 *
 * **Model.** The model in force starts as `selectedModel` and moves with each
 * `model_change`. With `selectedModel: "auto"` it's the router's
 * `chosenModel`. Every `assistant.message` and every `tool.execution_start`
 * is one vote for the model it names, or for the model in force where it
 * names none, which is how older builds wrote them. `primaryModel` is the top
 * of that mix: the model that served the session. `selectedModel` rides
 * beside it, with its class, so a session where the person picked `auto`
 * reads `router:auto` there whatever served it.
 *
 * **Posture.** `permission.requested` carries `agentMode` and
 * `permissionMode`. `permissionMode: "manual"` is the CLI asking before each
 * tool, the same posture as Claude Code's `default`. `agentMode: "plan"` is
 * planning. Any other pair is kept under a `copilot:` token, which bands as
 * `unknown` until someone has seen what it means. Supervising time before the
 * first request in a session has no posture and lands in `unknown`.
 *
 * **Tokens** come from the last `session.shutdown`: `tokenDetails` input
 * (uncached), `cache_read`, `cache_write` and output, the same split as
 * Claude Code's. A shutdown without `tokenDetails` falls back to the sum of
 * `modelMetrics[*].usage`, whose `inputTokens` includes both cache figures.
 * A session that was killed has no shutdown; its token keys are left off and
 * `tokensNotCollected` says so.
 *
 * Emission (aggregate before shipping):
 *  - `ai_prompt_submitted` per person's `user.message`, historical_direct.
 *  - `ai_tool_call_started` per `tool.execution_start`, deduplicated on
 *    `toolCallId`, historical_direct.
 *  - `create_focus_session` per session, historical_derived.
 *  - `after_hours_ai_session` / `tool_failure` per session with ≥1, derived.
 *  - one `extraction_epoch` for the store's observed window. Local only.
 * Metrics carry counts, ids and timestamps only.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { classifyModelClass, isOutsideBusinessHours, bucketDurationMs } from "@ascenda-one/tool-kit";
import { HISTORICAL_PROVENANCE, NormalizedHistoricalEvent } from "../types.js";
import { sanitizeToolName } from "../toolName.js";
import { sliceSessionByLocalDay } from "../daySlice.js";
import { DEFAULT_ACTIVE_GAP_MS, activeSpans, minutesOf, splitActiveTime, type ActiveInstant } from "../activeSplit.js";

/** The `session.start.version` values this extractor reads. */
export const KNOWN_COPILOT_LOG_VERSIONS = new Set([1]);

/** Event types the extractor reads fields from. */
export const KNOWN_COPILOT_EVENT_TYPES = new Set([
  "session.start",
  "session.model_change",
  "session.auto_mode_resolved",
  "user.message",
  "assistant.message",
  "tool.execution_start",
  "tool.execution_complete",
  "permission.requested",
  "session.compaction_complete",
  "session.shutdown"
]);

/**
 * Event types seen in real logs that carry nothing the import needs. They
 * count as `metaLines` and still date the timeline, so `unknownLines` keeps
 * meaning a type nobody has looked at yet.
 */
export const META_COPILOT_EVENT_TYPES = new Set([
  "assistant.turn_start",
  "assistant.turn_end",
  "session.resume",
  "session.plan_changed",
  "session.compaction_start",
  "session.truncation",
  "session.usage_checkpoint",
  "system.message",
  "permission.completed",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "abort"
]);

/** Skipped whole: the CLI running hooks, which is no part of the work. */
export const SKIPPED_COPILOT_EVENT_TYPES = new Set(["hook.start", "hook.end"]);

export type SniffedCopilotLine =
  | { kind: "event"; type: string; occurredAt: string | null; data: Record<string, unknown> }
  | { kind: "meta"; type: string; occurredAt: string | null }
  | { kind: "skipped"; type: string }
  | { kind: "unknown"; type: string; occurredAt: string | null }
  /** Not JSON, not an object, or no string `type`. */
  | { kind: "unparsed" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function sniffCopilotLine(line: string): SniffedCopilotLine {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "unparsed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "unparsed" };
  }
  const record = asRecord(parsed);
  if (!record || typeof record.type !== "string") return { kind: "unparsed" };
  const type = record.type;
  if (SKIPPED_COPILOT_EVENT_TYPES.has(type)) return { kind: "skipped", type };
  const occurredAt = typeof record.timestamp === "string" ? record.timestamp : null;
  if (META_COPILOT_EVENT_TYPES.has(type)) return { kind: "meta", type, occurredAt };
  if (!KNOWN_COPILOT_EVENT_TYPES.has(type)) return { kind: "unknown", type, occurredAt };
  return { kind: "event", type, occurredAt, data: asRecord(record.data) ?? {} };
}

/** What `workspace.yaml` says about where a session ran. */
export interface CopilotWorkspace {
  cwd: string | null;
  gitRoot: string | null;
  branch: string | null;
  clientName: string | null;
}

const WORKSPACE_KEYS: Record<string, keyof CopilotWorkspace> = {
  cwd: "cwd",
  git_root: "gitRoot",
  branch: "branch",
  client_name: "clientName"
};

/**
 * The four `workspace.yaml` keys this extractor reads, and nothing else. Not
 * a YAML parser on purpose: the file's `name` and `summary` are prompt and
 * agent text, and a parser would hand all of it back. Only a top-level line
 * for one of the four keys is looked at, with a plain scalar value; a block
 * scalar (`|`, `>`) or anything indented is passed over.
 */
export function readCopilotWorkspace(text: string): CopilotWorkspace {
  const out: CopilotWorkspace = { cwd: null, gitRoot: null, branch: null, clientName: null };
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-z_]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!match) continue;
    const field = WORKSPACE_KEYS[match[1]];
    if (!field) continue;
    let value = match[2];
    if (value === "" || value === "~" || value === "null" || /^[|>]/.test(value)) continue;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    if (value !== "") out[field] = value;
  }
  return out;
}

/**
 * The autonomy token for one `permission.requested`. Mapped only where the
 * CLI's words have been seen and their meaning is plain; anything else keeps
 * the CLI's own words under a prefix no band reads, so it lands in `unknown`
 * rather than on a neighbour that happens to share a word.
 */
export function copilotAutonomyModeOf(agentMode: unknown, permissionMode: unknown): string | null {
  const agent = nonEmptyString(agentMode);
  const permission = nonEmptyString(permissionMode);
  if (!agent && !permission) return null;
  if (agent === "plan") return "plan";
  if (permission === "manual" && (agent === null || agent === "interactive")) return "default";
  return `copilot:${agent ?? "?"}/${permission ?? "?"}`;
}

interface ShutdownFigures {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  tokensSeen: boolean;
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChangedCount: number | null;
  totalApiDurationMs: number | null;
}

function tokenCountOf(details: Record<string, unknown>, key: string): number {
  return asNumber(asRecord(details[key])?.tokenCount);
}

export function shutdownFiguresOf(data: Record<string, unknown>): ShutdownFigures {
  const out: ShutdownFigures = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    tokensSeen: false,
    linesAdded: null,
    linesRemoved: null,
    filesChangedCount: null,
    totalApiDurationMs: null
  };
  const details = asRecord(data.tokenDetails);
  if (details) {
    out.inputTokens = tokenCountOf(details, "input");
    out.outputTokens = tokenCountOf(details, "output");
    out.cacheReadTokens = tokenCountOf(details, "cache_read");
    out.cacheCreationTokens = tokenCountOf(details, "cache_write");
    out.tokensSeen = true;
  } else {
    const metrics = asRecord(data.modelMetrics);
    for (const value of Object.values(metrics ?? {})) {
      const usage = asRecord(asRecord(value)?.usage);
      if (!usage) continue;
      const cacheRead = asNumber(usage.cacheReadTokens);
      const cacheWrite = asNumber(usage.cacheWriteTokens);
      out.inputTokens += Math.max(0, asNumber(usage.inputTokens) - cacheRead - cacheWrite);
      out.outputTokens += asNumber(usage.outputTokens);
      out.cacheReadTokens += cacheRead;
      out.cacheCreationTokens += cacheWrite;
      out.tokensSeen = true;
    }
  }
  const changes = asRecord(data.codeChanges);
  if (changes) {
    if (typeof changes.linesAdded === "number") out.linesAdded = changes.linesAdded;
    if (typeof changes.linesRemoved === "number") out.linesRemoved = changes.linesRemoved;
    if (Array.isArray(changes.filesModified)) out.filesChangedCount = changes.filesModified.length;
  }
  if (typeof data.totalApiDurationMs === "number") out.totalApiDurationMs = data.totalApiDurationMs;
  return out;
}

interface SessionFold {
  sessionId: string;
  sourceVersion: string | null;
  selectedModel: string | null;
  contextCwd: string | null;
  contextGitRoot: string | null;
  contextBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
  humanPrompts: number;
  afterHoursPrompts: number;
  humanPromptTimestamps: (string | null)[];
  subagentPrompts: number;
  assistantTurns: number;
  toolCallIds: Set<string>;
  toolCallCount: number;
  subagentToolCallCount: number;
  toolCalls: { at: string; name: string }[];
  toolResults: number;
  toolResultErrorCount: number;
  compactionCount: number;
  models: Map<string, number>;
  lastServedModel: string | null;
  modelSwitchCount: number;
  shutdown: ShutdownFigures | null;
  unknownLines: number;
  metaLines: number;
  unparsedLines: number;
  timelinePoints: ActiveInstant[];
  undatedTimelineLines: number;
}

function newFold(sessionId: string): SessionFold {
  return {
    sessionId,
    sourceVersion: null,
    selectedModel: null,
    contextCwd: null,
    contextGitRoot: null,
    contextBranch: null,
    firstTs: null,
    lastTs: null,
    humanPrompts: 0,
    afterHoursPrompts: 0,
    humanPromptTimestamps: [],
    subagentPrompts: 0,
    assistantTurns: 0,
    toolCallIds: new Set(),
    toolCallCount: 0,
    subagentToolCallCount: 0,
    toolCalls: [],
    toolResults: 0,
    toolResultErrorCount: 0,
    compactionCount: 0,
    models: new Map(),
    lastServedModel: null,
    modelSwitchCount: 0,
    shutdown: null,
    unknownLines: 0,
    metaLines: 0,
    unparsedLines: 0,
    timelinePoints: [],
    undatedTimelineLines: 0
  };
}

/** The `session.start` a log opens with, or null where it has none. */
function sessionStartOf(lines: string[]): Record<string, unknown> | null {
  for (const line of lines) {
    const sniffed = sniffCopilotLine(line);
    if (sniffed.kind === "event" && sniffed.type === "session.start") return sniffed.data;
  }
  return null;
}

/** Whether a log is one this extractor can read: a `session.start` whose
 * `version` it knows. */
export function isReadableCopilotLog(start: Record<string, unknown> | null): boolean {
  return start !== null && typeof start.version === "number" && KNOWN_COPILOT_LOG_VERSIONS.has(start.version);
}

/** A `user.message` the parent agent wrote to start a subagent: `source` is `agent-…`. */
export function isSubagentTask(data: Record<string, unknown>): boolean {
  return typeof data.source === "string" && data.source.startsWith("agent-");
}

function voteModel(fold: SessionFold, model: string | null): void {
  if (!model) return;
  fold.models.set(model, (fold.models.get(model) ?? 0) + 1);
}

function foldLines(fold: SessionFold, lines: string[]): void {
  // The model in force for events that name none. "auto" is a choice, not a
  // model, so it never takes a vote: the router's pick replaces it.
  let inForce: string | null = null;
  let posture: string | null = null;
  let startSeen = false;

  for (const line of lines) {
    const sniffed = sniffCopilotLine(line);
    if (sniffed.kind === "unparsed") {
      if (line.trim() !== "") fold.unparsedLines += 1;
      continue;
    }
    if (sniffed.kind === "skipped") continue;
    if (sniffed.kind === "meta") fold.metaLines += 1;
    if (sniffed.kind === "unknown") fold.unknownLines += 1;
    const occurredAt = sniffed.occurredAt;
    if (occurredAt) {
      if (!fold.firstTs || occurredAt < fold.firstTs) fold.firstTs = occurredAt;
      if (!fold.lastTs || occurredAt > fold.lastTs) fold.lastTs = occurredAt;
    }

    let humanHere = false;
    if (sniffed.kind === "event") {
      const data = sniffed.data;
      switch (sniffed.type) {
        case "session.start": {
          if (startSeen) break; // Only the first is the session's own.
          startSeen = true;
          const version = nonEmptyString(data.copilotVersion);
          fold.sourceVersion = version && version !== "unknown" ? version : null;
          fold.selectedModel = nonEmptyString(data.selectedModel);
          inForce = fold.selectedModel === "auto" ? null : fold.selectedModel;
          const context = asRecord(data.context);
          fold.contextCwd = nonEmptyString(context?.cwd);
          fold.contextGitRoot = nonEmptyString(context?.gitRoot);
          fold.contextBranch = nonEmptyString(context?.branch);
          break;
        }
        case "session.model_change": {
          const next = nonEmptyString(data.newModel);
          if (next) inForce = next === "auto" ? null : next;
          break;
        }
        case "session.auto_mode_resolved": {
          const chosen = nonEmptyString(data.chosenModel);
          if (chosen) inForce = chosen;
          break;
        }
        case "user.message": {
          if (isSubagentTask(data)) {
            fold.subagentPrompts += 1;
            break;
          }
          fold.humanPrompts += 1;
          if (occurredAt && isOutsideBusinessHours(new Date(occurredAt))) fold.afterHoursPrompts += 1;
          fold.humanPromptTimestamps.push(occurredAt);
          humanHere = true;
          break;
        }
        case "assistant.message": {
          fold.assistantTurns += 1;
          const model = nonEmptyString(data.model) ?? inForce;
          voteModel(fold, model);
          if (model) {
            if (fold.lastServedModel && fold.lastServedModel !== model) fold.modelSwitchCount += 1;
            fold.lastServedModel = model;
          }
          break;
        }
        case "tool.execution_start": {
          const id = nonEmptyString(data.toolCallId);
          if (id) {
            if (fold.toolCallIds.has(id)) break;
            fold.toolCallIds.add(id);
          }
          fold.toolCallCount += 1;
          if (nonEmptyString(data.parentToolCallId)) fold.subagentToolCallCount += 1;
          voteModel(fold, nonEmptyString(data.model) ?? inForce);
          // An undated call still counts but can't be placed on a rail.
          if (occurredAt) {
            fold.toolCalls.push({
              at: occurredAt,
              name: sanitizeToolName(typeof data.toolName === "string" ? data.toolName : null)
            });
          }
          break;
        }
        case "tool.execution_complete": {
          fold.toolResults += 1;
          if (data.success === false) fold.toolResultErrorCount += 1;
          break;
        }
        case "permission.requested": {
          const mode = copilotAutonomyModeOf(data.agentMode, data.permissionMode);
          if (mode) posture = mode;
          break;
        }
        case "session.compaction_complete": {
          if (data.success !== false) fold.compactionCount += 1;
          break;
        }
        case "session.shutdown": {
          // The last one wins. Every session seen has at most one; a resumed
          // session that shut down twice hasn't been observed, so whether the
          // figures restart or carry on is unknown and not guessed at here.
          fold.shutdown = shutdownFiguresOf(data);
          break;
        }
        default:
          break;
      }
    }

    if (occurredAt) {
      const ms = Date.parse(occurredAt);
      if (Number.isFinite(ms)) {
        // `agentOutput` as the complement of `human` is the nearest-line rule,
        // as in `codex.ts`: the turn and bookkeeping lines aren't classified
        // apart from the agent's output yet, and the handoff says
        // `handsOnBoundary: "nearest_line"` for the same reason.
        fold.timelinePoints.push({ at: ms, human: humanHere, agentOutput: !humanHere, autonomyMode: posture });
      } else {
        fold.undatedTimelineLines += 1;
      }
    }
  }
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

function sessionDurationMs(fold: SessionFold): number | null {
  if (!fold.firstTs || !fold.lastTs) return null;
  const ms = Date.parse(fold.lastTs) - Date.parse(fold.firstTs);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** One session as found on disk: its log, and the workspace file if any. */
export interface CopilotSessionFiles {
  sessionId: string;
  logPath: string;
  workspacePath: string | null;
}

/**
 * The sessions under a snapshot, by id, in id order. A directory's
 * `events.jsonl` is the log; a flat `<id>.jsonl` is read only where its
 * directory has none. `duplicates` counts the flat files passed over.
 */
export async function listCopilotSessions(
  snapshotDir: string
): Promise<{ sessions: CopilotSessionFiles[]; duplicates: number }> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(snapshotDir, { withFileTypes: true });
  } catch {
    return { sessions: [], duplicates: 0 };
  }
  const dirs = new Set<string>();
  const flat = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) dirs.add(entry.name);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) flat.add(entry.name.slice(0, -".jsonl".length));
  }
  const exists = async (p: string) => {
    try {
      return (await fs.stat(p)).isFile();
    } catch {
      return false;
    }
  };
  const sessions: CopilotSessionFiles[] = [];
  let duplicates = 0;
  for (const id of [...new Set([...dirs, ...flat])].sort()) {
    const dirLog = path.join(snapshotDir, id, "events.jsonl");
    const workspace = path.join(snapshotDir, id, "workspace.yaml");
    const workspacePath = dirs.has(id) && (await exists(workspace)) ? workspace : null;
    if (dirs.has(id) && (await exists(dirLog))) {
      if (flat.has(id)) duplicates += 1;
      sessions.push({ sessionId: id, logPath: dirLog, workspacePath });
    } else if (flat.has(id)) {
      sessions.push({ sessionId: id, logPath: path.join(snapshotDir, `${id}.jsonl`), workspacePath });
    }
    // A directory with neither log is a session the CLI holds nothing for.
  }
  return { sessions, duplicates };
}

export async function* extractCopilotCli(
  snapshotDir: string,
  extractionId: string
): AsyncIterable<NormalizedHistoricalEvent> {
  const { sessions, duplicates } = await listCopilotSessions(snapshotDir);
  if (sessions.length === 0) return;

  let windowOldest: string | null = null;
  let windowNewest: string | null = null;
  let sessionCount = 0;
  let unparsedSessions = 0;
  let unreadableSessions = 0;
  let malformedLines = 0;

  for (const files of sessions) {
    let text: string;
    try {
      text = await fs.readFile(files.logPath, "utf8");
    } catch {
      unreadableSessions += 1;
      continue;
    }
    const lines = text.split("\n");
    const start = sessionStartOf(lines);
    if (!isReadableCopilotLog(start)) {
      unparsedSessions += 1;
      continue;
    }
    let workspace: CopilotWorkspace = { cwd: null, gitRoot: null, branch: null, clientName: null };
    if (files.workspacePath) {
      try {
        workspace = readCopilotWorkspace(await fs.readFile(files.workspacePath, "utf8"));
      } catch {
        // No workspace file to read: session.start's context still names the cwd.
      }
    }

    const fold = newFold(nonEmptyString(start?.sessionId) ?? files.sessionId);
    foldLines(fold, lines);
    malformedLines += fold.unparsedLines;
    if (!fold.firstTs || !fold.lastTs) continue;
    sessionCount += 1;
    if (!windowOldest || fold.firstTs < windowOldest) windowOldest = fold.firstTs;
    if (!windowNewest || fold.lastTs > windowNewest) windowNewest = fold.lastTs;

    const repoRef = workspace.gitRoot ?? fold.contextGitRoot ?? workspace.cwd ?? fold.contextCwd;
    const gitBranch = workspace.branch ?? fold.contextBranch;
    const base = {
      store: "copilot_cli" as const,
      sourceVersion: fold.sourceVersion,
      sessionRef: fold.sessionId,
      repoRef,
      extractionId
    };

    for (const ts of fold.humanPromptTimestamps) {
      if (!ts) continue;
      yield { ...base, occurredAt: ts, eventKind: "ai_prompt_submitted", metrics: {}, provenance: HISTORICAL_PROVENANCE.direct };
    }
    for (const call of fold.toolCalls) {
      yield {
        ...base,
        occurredAt: call.at,
        eventKind: "ai_tool_call_started",
        metrics: { toolName: call.name },
        provenance: HISTORICAL_PROVENANCE.direct
      };
    }

    const durationMs = sessionDurationMs(fold);
    const split = splitActiveTime(fold.timelinePoints, { activeGapMs: ACTIVE_GAP_MS });
    const metrics: NormalizedHistoricalEvent["metrics"] = {
      promptCount: fold.humanPrompts,
      subagentPrompts: fold.subagentPrompts,
      assistantTurns: fold.assistantTurns,
      toolCallCount: fold.toolCallCount,
      subagentToolCallCount: fold.subagentToolCallCount,
      toolResultCount: fold.toolResults,
      durationBucket: durationMs === null ? "unknown" : bucketDurationMs(durationMs) ?? "unknown",
      afterHoursPrompts: fold.afterHoursPrompts,
      unknownLines: fold.unknownLines,
      metaLines: fold.metaLines,
      unparsedLines: fold.unparsedLines,
      modelCount: fold.models.size,
      modelSwitchCount: fold.modelSwitchCount,
      compactionCount: fold.compactionCount,
      toolResultErrorCount: fold.toolResultErrorCount,
      toolFailureCount: fold.toolResultErrorCount,
      rapidRepromptCount: rapidRepromptCountOf(fold),
      activeMinutes: minutesOf(split.handsOnMs + split.agentSupervisingMs),
      handsOnMinutes: minutesOf(split.handsOnMs),
      agentSupervisingMinutes: minutesOf(split.agentSupervisingMs),
      activeSplitInstants: split.instants,
      activeSplitUndatedLines: fold.undatedTimelineLines,
      activeSplitUnposturedInstants: split.unposturedInstants,
      sessionStartedAt: fold.firstTs
    };
    if (durationMs !== null) metrics.sessionMinutes = Math.round(durationMs / 60_000);
    const primaryModel = topModel(fold.models);
    if (primaryModel) metrics.primaryModel = primaryModel;
    if (fold.selectedModel) {
      metrics.selectedModel = fold.selectedModel;
      const selectedClass = classifyModelClass(fold.selectedModel);
      if (selectedClass) metrics.selectedModelClass = selectedClass;
    }
    if (gitBranch) metrics.gitBranch = gitBranch;
    if (workspace.clientName) metrics.clientName = workspace.clientName;
    // Shutdown figures only where there was a shutdown. Without one the
    // session was killed or is still open, and 0 would read as measured.
    const shutdown = fold.shutdown;
    if (shutdown?.tokensSeen) {
      metrics.inputTokens = shutdown.inputTokens;
      metrics.outputTokens = shutdown.outputTokens;
      metrics.cacheReadTokens = shutdown.cacheReadTokens;
      metrics.cacheCreationTokens = shutdown.cacheCreationTokens;
    } else {
      metrics.tokensNotCollected = true;
    }
    if (shutdown?.linesAdded != null) metrics.linesAdded = shutdown.linesAdded;
    if (shutdown?.linesRemoved != null) metrics.linesRemoved = shutdown.linesRemoved;
    if (shutdown?.filesChangedCount != null) metrics.filesChangedCount = shutdown.filesChangedCount;
    if (shutdown?.totalApiDurationMs != null) metrics.totalApiDurationMs = shutdown.totalApiDurationMs;

    yield {
      ...base,
      occurredAt: fold.lastTs,
      eventKind: "create_focus_session",
      metrics,
      dayBreakdown: sliceSessionByLocalDay(fold.humanPromptTimestamps, {
        activeGapMs: ACTIVE_GAP_MS,
        activeInstants: fold.timelinePoints
      }),
      activeSpans: activeSpans(fold.timelinePoints, { activeGapMs: ACTIVE_GAP_MS }).spans,
      autonomySplit: Object.fromEntries(
        Object.entries(split.supervisingMsByBand).map(([band, ms]) => [band, minutesOf(ms)])
      ),
      provenance: HISTORICAL_PROVENANCE.derived
    };

    if (fold.afterHoursPrompts > 0) {
      yield {
        ...base,
        occurredAt: fold.lastTs,
        eventKind: "after_hours_ai_session",
        metrics: { afterHoursPrompts: fold.afterHoursPrompts },
        provenance: HISTORICAL_PROVENANCE.derived
      };
    }
    if (fold.toolResultErrorCount > 0) {
      yield {
        ...base,
        occurredAt: fold.lastTs,
        eventKind: "tool_failure",
        metrics: { toolFailureCount: fold.toolResultErrorCount, toolResultErrorCount: fold.toolResultErrorCount },
        provenance: HISTORICAL_PROVENANCE.derived
      };
    }
  }

  const unread = unparsedSessions + unreadableSessions;
  if ((windowOldest && windowNewest) || unread > 0) {
    const window: Record<string, string> = windowOldest && windowNewest ? { windowOldest, windowNewest } : {};
    yield {
      occurredAt: windowNewest ?? new Date().toISOString(),
      store: "copilot_cli",
      sourceVersion: null,
      sessionRef: null,
      repoRef: null,
      eventKind: "extraction_epoch",
      metrics: {
        ...window,
        sessionCount,
        unparsedChatSessionFiles: unparsedSessions,
        unreadableChatSessionFiles: unreadableSessions,
        malformedChatSessionLines: malformedLines,
        duplicateChatSessions: duplicates
      },
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };
  }
}
