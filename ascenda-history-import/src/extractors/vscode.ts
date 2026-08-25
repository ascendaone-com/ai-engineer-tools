/**
 * VS Code extractor — the deep baseline (stable stores, retained far longer
 * than Claude Code's), safe to run in a background pass after Claude Code and
 * Cursor.
 *
 * Two independent stores, one extractor:
 *  - `User/History/<hash>/entries.json` — Timeline local history. One
 *    directory per tracked FILE (not per workspace), format self-labels
 *    `{"version":1,"resource","entries"}`. The decisive per-entry field is
 *    `source: "Chat Edit: '<prompt>'"`, which on an AI-heavy machine accounts
 *    for most entries. The PROMPT TEXT inside that string is content: only
 *    the `"Chat Edit:"` prefix is ever read: the extractor counts and
 *    timestamps Chat Edits, never ships the string.
 *  - `workspaceStorage/<ws>/chatSessions/*.{json,jsonl}` — Copilot sessions,
 *    self-labelling `"version":3` where observed. Each `requests[]`
 *    entry carries `message`/`response` (content — never read past checking
 *    they exist) and `modelId`/`timestamp`/`isCanceled`/`result.errorDetails`
 *    (metrics).
 *
 * Workspace identity for BOTH stores comes from the same source:
 * `workspaceStorage/<hash>/workspace.json`'s `folder` field is the real path
 * VS Code itself resolved for that workspace hash — not a guess at path
 * segments. `buildWorkspaceFolderIndex` reads every one of those once and a
 * Timeline-history file's `resource` path is matched against it by longest
 * prefix. The paths that do not resolve are typically scratch files and files
 * under paths VS Code never opened as a workspace — real gaps, not bugs, and
 * they fall back to the file's own containing directory rather than a
 * fabricated workspace name. Multi-root workspaces (`workspace.json`
 * pointing at `workspace` instead of `folder`, itself a pointer into
 * `Code/Workspaces/…`) are outside this store's own snapshot boundary and
 * are deliberately left unresolved rather than followed into a second store
 * this extractor was not handed.
 *
 * Emission (aggregate before shipping — never one event per Timeline entry
 * or per bubble):
 *  - `editor_activity` per (day, workspace) with ≥1 Timeline-history
 *    entry: chat-edit count vs. total entry count. This alone reproduces a
 *    machine's AI-adoption arc once rolled up to months downstream —
 *    provenance historical_derived (a fold across many raw entries).
 *  - `ai_prompt_submitted` per Copilot chat request (canonical type, no
 *    metrics — same content-free shape claudeCode.ts uses for human
 *    prompts), provenance historical_direct.
 *  - `create_focus_session` per Copilot chat session: request count,
 *    model mix, after-hours count, cancellation/error counts, duration —
 *    provenance historical_derived.
 *  - `after_hours_ai_session` / `tool_failure` per session with ≥1 of that
 *    signal (canonical types, aggregate — same shape claudeCode.ts uses).
 *  - one `extraction_epoch` (local only — filtered before the wire) for
 *    the store's observed window, folding
 *    in unparsed/malformed counts from both sub-stores so a partial import
 *    is visible rather than silently read as complete.
 * Metrics carry counts, ids and timestamps only — never prompt/response text
 * or file contents.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bucketDurationMs, isAfterHours } from "@ascenda-one/tool-kit";
import { HISTORICAL_PROVENANCE, NormalizedHistoricalEvent } from "../types.js";
import { sliceSessionByLocalDay } from "../daySlice.js";

/** Self-labelled schema versions this extractor has a fixture for. Anything
 * else sniffs as unparsed — counted, never guessed at (the same
 * contract-test discipline claudeCode.ts's `sniffClaudeLine` follows). */
const KNOWN_HISTORY_VERSION = 1;
const KNOWN_CHAT_SESSION_VERSION = 3;

/** Only this prefix is ever inspected on a Timeline-history entry's
 * `source` field — the prompt text after it is content. */
const CHAT_EDIT_PREFIX = "Chat Edit:";

/**
 * A missing file is a shape of the store, not a failure — most hash
 * directories genuinely have no `entries.json` and most workspaces no
 * `chatSessions`. Anything else (EACCES, EIO, EISDIR, ENOSPC, a file that
 * vanished mid-run) is a read this extractor was supposed to make and did
 * not, and must be counted rather than dropped: an uncounted read failure is
 * indistinguishable downstream from a store that simply had less in it.
 */
function isAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function uriToPath(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ *
 * Workspace folder index — workspaceStorage/<hash>/workspace.json
 * ------------------------------------------------------------------------ */

interface WorkspaceFolder {
  folderPath: string;
}

/**
 * One entry per resolvable `workspaceStorage/<hash>/workspace.json`, sorted
 * longest-path-first so a nested folder wins over an ancestor during
 * matching. Hash directories with no `workspace.json`, an unparsable one, or
 * only a multi-root `workspace` pointer are silently skipped — they simply
 * don't contribute an entry, which is the correct behaviour (their sessions
 * fall back to directory-based grouping, never a fabricated folder).
 */
async function buildWorkspaceFolderIndex(workspaceStorageDir: string): Promise<WorkspaceFolder[]> {
  let hashDirs: string[] = [];
  try {
    hashDirs = (await fs.readdir(workspaceStorageDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const folders: WorkspaceFolder[] = [];
  for (const hash of hashDirs) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(workspaceStorageDir, hash, "workspace.json"), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const folderPath = uriToPath((parsed as Record<string, unknown>).folder);
    if (folderPath) folders.push({ folderPath });
  }
  return folders.sort((a, b) => b.folderPath.length - a.folderPath.length);
}

/** Resolves a file path to its workspace root via longest-prefix match
 * against the index. Falls back to the file's own containing directory when
 * nothing matches — real, never fabricated, just coarser than a true
 * workspace root. */
function workspaceRootOf(filePath: string, index: WorkspaceFolder[]): string {
  for (const folder of index) {
    const withSlash = folder.folderPath.endsWith("/") ? folder.folderPath : `${folder.folderPath}/`;
    if (filePath === folder.folderPath || filePath.startsWith(withSlash)) {
      return folder.folderPath;
    }
  }
  return path.dirname(filePath);
}

/* ------------------------------------------------------------------------ *
 * Timeline local history — User/History/<hash>/entries.json
 * ------------------------------------------------------------------------ */

interface HistoryEntry {
  source?: unknown;
  timestamp?: unknown;
}

interface HistorySniff {
  resource: string;
  entries: HistoryEntry[];
}

/** Parses one `entries.json`. Returns null for anything that isn't valid
 * JSON, isn't `version: 1`, or is missing the fields this extractor reads —
 * every one of those is a file-level `unparsed`, not a half-read. */
function sniffHistoryFile(raw: string): HistorySniff | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== KNOWN_HISTORY_VERSION) return null;
  if (typeof record.resource !== "string" || !Array.isArray(record.entries)) return null;
  return { resource: record.resource, entries: record.entries as HistoryEntry[] };
}

/** One calendar day's Chat-Edit tally for one workspace. */
interface EditDayFold {
  date: string;
  workspaceRoot: string;
  chatEditCount: number;
  totalEntryCount: number;
  lastTs: string;
}

interface EditDaysResult {
  days: Map<string, EditDayFold>;
  unparsedFiles: number;
  /** Files this extractor was supposed to read and could not — distinct from
   * `unparsedFiles` (read fine, schema unknown). */
  unreadableFiles: number;
  malformedEntries: number;
  oldest: string | null;
  newest: string | null;
}

async function foldEditDays(historyDir: string, index: WorkspaceFolder[]): Promise<EditDaysResult> {
  const result: EditDaysResult = {
    days: new Map(),
    unparsedFiles: 0,
    unreadableFiles: 0,
    malformedEntries: 0,
    oldest: null,
    newest: null
  };

  let hashDirs: string[] = [];
  try {
    hashDirs = (await fs.readdir(historyDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result; // No Timeline history in this snapshot — not an error.
  }

  for (const hash of hashDirs.sort()) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(historyDir, hash, "entries.json"), "utf8");
    } catch (error) {
      // A hash directory without entries.json isn't this store's concern; a
      // hash directory whose entries.json we could not READ very much is.
      if (!isAbsence(error)) result.unreadableFiles += 1;
      continue;
    }
    const sniffed = sniffHistoryFile(raw);
    if (!sniffed) {
      result.unparsedFiles += 1;
      continue;
    }
    const resourcePath = uriToPath(sniffed.resource);
    if (!resourcePath) {
      result.unparsedFiles += 1; // Self-labelled version 1 but the resource URI didn't decode.
      continue;
    }
    const workspaceRoot = workspaceRootOf(resourcePath, index);

    for (const entry of sniffed.entries) {
      const ts = typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp) ? entry.timestamp : null;
      if (ts === null) {
        result.malformedEntries += 1;
        continue;
      }
      const iso = new Date(ts).toISOString();
      const date = iso.slice(0, 10);
      if (!result.oldest || iso < result.oldest) result.oldest = iso;
      if (!result.newest || iso > result.newest) result.newest = iso;

      const key = `${date}\0${workspaceRoot}`;
      let fold = result.days.get(key);
      if (!fold) {
        fold = { date, workspaceRoot, chatEditCount: 0, totalEntryCount: 0, lastTs: iso };
        result.days.set(key, fold);
      }
      fold.totalEntryCount += 1;
      if (iso > fold.lastTs) fold.lastTs = iso;
      // Only the prefix is read here — everything after it is the prompt,
      // which never leaves this function.
      if (typeof entry.source === "string" && entry.source.startsWith(CHAT_EDIT_PREFIX)) {
        fold.chatEditCount += 1;
      }
    }
  }

  return result;
}

/* ------------------------------------------------------------------------ *
 * Copilot chat sessions — workspaceStorage/<ws>/chatSessions/*.json
 * ------------------------------------------------------------------------ */

interface ChatSessionFold {
  sessionId: string;
  workspaceRoot: string | null;
  firstTs: string | null;
  lastTs: string | null;
  requestCount: number;
  afterHoursRequests: number;
  canceledCount: number;
  errorCount: number;
  models: Map<string, number>;
  /** Timestamps only — the source for one `ai_prompt_submitted` per human
   * message, never the message/response text itself. */
  requestTimestamps: string[];
}

interface ChatSessionsResult {
  sessions: ChatSessionFold[];
  unparsedFiles: number;
  /** Session files that could not be read at all. Distinct from
   * `unparsedFiles` (read fine, schema unknown) and `unrecognisedFiles`
   * (never opened, extension unknown): this is an attempted read that failed. */
  unreadableFiles: number;
  /** Files in a `chatSessions/` directory whose extension this extractor has
   * no reader for. Counted rather than ignored: VS Code migrated this store
   * from `.json` to `.jsonl` in Feb 2026 and the `.json`-only filter dropped
   * seven months of sessions without ever attempting a parse, so
   * `unparsedFiles` stayed 0 and the import reported clean. A glob is a blind
   * spot the parser cannot see past; this counter is what makes it visible. */
  unrecognisedFiles: number;
  /** Sessions opened and never used. Excluded by the same rule Cursor
   * applies — a window nobody typed into is not work — and counted, so the
   * exclusion is visible rather than inferred from a shortfall. */
  emptyDrafts: number;
  /** Lines inside a `.jsonl` session that did not parse. A truncated tail is
   * normal for a session VS Code was still writing; a large count is not. */
  malformedLines: number;
}

/**
 * A `.jsonl` chat session is a keypath-delta log, not a document: line 1 is
 * `{kind:0, v:<the session object>}` and every later line mutates it —
 * `{kind:1, k:[...path], v}` sets a value, `{kind:2, k:[...path], v:[...], i?}`
 * splices into an array (appending when `i` is absent).
 *
 * Folding the deltas is not optional. The `kind:0` headers alone carry a
 * small fraction of a session's requests; the rest arrive as appends. Reading
 * only the header restores the sessions with most of their prompts missing —
 * a quieter wrong answer than the empty months it replaced, because nothing
 * downstream would flag a deflated count.
 */
const JSONL_KIND_HEADER = 0;
const JSONL_KIND_SET = 1;
const JSONL_KIND_SPLICE = 2;

type KeyPath = (string | number)[];

/** Walks `path` from `root`, returning the container it addresses, or null if
 * any segment is missing — a delta against a path the header never had is
 * dropped, never conjured into existence. */
function resolvePath(root: unknown, path: KeyPath): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (typeof seg === "number") {
      if (!Array.isArray(cur) || seg >= cur.length) return null;
      cur = cur[seg];
    } else {
      if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return null;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur ?? null;
}

function applySet(root: unknown, path: KeyPath, value: unknown): void {
  if (path.length === 0) return;
  const parent = resolvePath(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (typeof last === "number") {
    if (!Array.isArray(parent)) return;
    while (parent.length <= last) parent.push(null);
    parent[last] = value;
  } else {
    if (typeof parent !== "object" || parent === null || Array.isArray(parent)) return;
    (parent as Record<string, unknown>)[last] = value;
  }
}

function applySplice(root: unknown, path: KeyPath, values: unknown[], index: number | null): void {
  const target = resolvePath(root, path);
  if (!Array.isArray(target)) return;
  if (index !== null && index >= 0 && index <= target.length) target.splice(index, 0, ...values);
  else target.push(...values);
}

interface JsonlParse {
  record: Record<string, unknown> | null;
  malformedLines: number;
}

/** Folds one `.jsonl` session into the same record shape the `.json` reader
 * produces, so both formats converge before any counting happens. */
export function parseJsonlChatSession(raw: string): JsonlParse {
  let malformedLines = 0;
  let record: Record<string, unknown> | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      malformedLines += 1;
      continue;
    }
    const delta = parsed as Record<string, unknown>;

    if (delta.kind === JSONL_KIND_HEADER) {
      // The header is the document. A second one would mean a concatenated
      // log; keep the first, which is the session's own creation record.
      if (record === null && typeof delta.v === "object" && delta.v !== null) {
        record = delta.v as Record<string, unknown>;
      }
      continue;
    }
    if (record === null || !Array.isArray(delta.k)) continue;
    const keyPath = delta.k.filter(
      (seg): seg is string | number => typeof seg === "string" || typeof seg === "number"
    );
    if (keyPath.length !== delta.k.length) continue;

    if (delta.kind === JSONL_KIND_SET) {
      applySet(record, keyPath, delta.v);
    } else if (delta.kind === JSONL_KIND_SPLICE && Array.isArray(delta.v)) {
      applySplice(record, keyPath, delta.v, typeof delta.i === "number" ? delta.i : null);
    }
  }

  return { record, malformedLines };
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

async function foldChatSessions(workspaceStorageDir: string): Promise<ChatSessionsResult> {
  const result: ChatSessionsResult = {
    sessions: [],
    unparsedFiles: 0,
    unreadableFiles: 0,
    unrecognisedFiles: 0,
    emptyDrafts: 0,
    malformedLines: 0
  };

  let wsHashes: string[] = [];
  try {
    wsHashes = (await fs.readdir(workspaceStorageDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result;
  }

  for (const hash of wsHashes.sort()) {
    const wsDir = path.join(workspaceStorageDir, hash);
    let workspaceRoot: string | null = null;
    try {
      const raw = await fs.readFile(path.join(wsDir, "workspace.json"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      workspaceRoot = uriToPath(parsed.folder);
    } catch {
      // No workspace.json, or a multi-root pointer — left unresolved, not guessed.
    }

    let files: string[] = [];
    try {
      const entries = await fs.readdir(path.join(wsDir, "chatSessions"));
      files = entries.filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"));
      // Anything else in here is a store shape this extractor does not know.
      // Counted, never silently skipped — see `unrecognisedFiles`.
      result.unrecognisedFiles += entries.length - files.length;
    } catch {
      continue; // Most workspaces have no chatSessions dir — the norm.
    }

    for (const file of files.sort()) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(wsDir, "chatSessions", file), "utf8");
      } catch {
        // `readdir` just listed this file, so every failure here is real —
        // including ENOENT (it vanished mid-run) and ERR_STRING_TOO_LONG (a
        // session larger than V8's max string; several on this machine run to
        // 450 MB). This `continue` used to be bare, which meant an unreadable
        // session was not counted as unparsed, not counted as unrecognised,
        // and absent from the epoch — the import reported clean while dropping
        // it.
        result.unreadableFiles += 1;
        continue;
      }
      // Two on-disk shapes, one record. `.json` is the whole session; `.jsonl`
      // is a delta log whose header plus deltas fold to the same thing. Both
      // must clear the same version gate below — the migration changed the
      // container, not the session schema (still version 3).
      let record: Record<string, unknown> | null = null;
      if (file.endsWith(".jsonl")) {
        const folded = parseJsonlChatSession(raw);
        result.malformedLines += folded.malformedLines;
        record = folded.record;
      } else {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === "object" && parsed !== null) {
            record = parsed as Record<string, unknown>;
          }
        } catch {
          record = null;
        }
      }
      if (record === null) {
        result.unparsedFiles += 1;
        continue;
      }
      if (record.version !== KNOWN_CHAT_SESSION_VERSION) {
        result.unparsedFiles += 1;
        continue;
      }
      const requests = Array.isArray(record.requests) ? record.requests : [];
      if (requests.length === 0) {
        result.emptyDrafts += 1; // An empty draft — no real usage to fold.
        continue;
      }

      const fold: ChatSessionFold = {
        sessionId:
          typeof record.sessionId === "string"
            ? record.sessionId
            : path.basename(file, path.extname(file)),
        workspaceRoot,
        firstTs: null,
        lastTs: null,
        requestCount: 0,
        afterHoursRequests: 0,
        canceledCount: 0,
        errorCount: 0,
        models: new Map(),
        requestTimestamps: []
      };

      for (const r of requests) {
        if (typeof r !== "object" || r === null) continue;
        const req = r as Record<string, unknown>;
        const ts = typeof req.timestamp === "number" && Number.isFinite(req.timestamp) ? req.timestamp : null;
        if (ts === null) continue; // No usable timestamp — not a human-prompt event, not a session anchor.
        const iso = new Date(ts).toISOString();

        fold.requestCount += 1;
        fold.requestTimestamps.push(iso);
        if (!fold.firstTs || iso < fold.firstTs) fold.firstTs = iso;
        if (!fold.lastTs || iso > fold.lastTs) fold.lastTs = iso;
        if (isAfterHours(new Date(iso))) fold.afterHoursRequests += 1;
        if (req.isCanceled === true) fold.canceledCount += 1;
        const requestResult = req.result as Record<string, unknown> | undefined;
        if (requestResult && requestResult.errorDetails) fold.errorCount += 1;
        if (typeof req.modelId === "string") {
          fold.models.set(req.modelId, (fold.models.get(req.modelId) ?? 0) + 1);
        }
      }

      if (fold.requestCount > 0) result.sessions.push(fold);
    }
  }

  return result;
}

/* ------------------------------------------------------------------------ *
 * Extraction entry point
 * ------------------------------------------------------------------------ */

/**
 * Expects `snapshotDir` to contain `history/` (a copy of
 * `Code/User/History`) and `workspaceStorage/` (a copy of
 * `Code/User/workspaceStorage`, surgically limited to `workspace.json` and
 * `chatSessions/*.json` per hash — see `snapshotVsCodeWorkspaceStorage` in
 * `staging.ts`, which is what the CLI's `import` command stages this store
 * with).
 */
/**
 * `source` is either a staging root laid out as `<root>/history` +
 * `<root>/workspaceStorage`, or the two directories named explicitly. The
 * explicit form exists so the caller can point the chat-session read at the
 * LIVE store while still snapshotting the stores that need it — see
 * `cli.ts`. Both sub-stores are addressed independently because they have
 * genuinely different volatility, and pretending otherwise cost 15 GB a run.
 */
export type VsCodeSource = string | { historyDir: string; workspaceStorageDir: string };

export async function* extractVsCode(
  source: VsCodeSource,
  extractionId: string
): AsyncIterable<NormalizedHistoricalEvent> {
  const historyDir =
    typeof source === "string" ? path.join(source, "history") : source.historyDir;
  const workspaceStorageDir =
    typeof source === "string" ? path.join(source, "workspaceStorage") : source.workspaceStorageDir;

  const index = await buildWorkspaceFolderIndex(workspaceStorageDir);
  const editDays = await foldEditDays(historyDir, index);
  const chatSessions = await foldChatSessions(workspaceStorageDir);

  let windowOldest = editDays.oldest;
  let windowNewest = editDays.newest;

  const sortedDays = [...editDays.days.values()].sort((a, b) =>
    `${a.date}\0${a.workspaceRoot}`.localeCompare(`${b.date}\0${b.workspaceRoot}`)
  );
  for (const fold of sortedDays) {
    yield {
      occurredAt: fold.lastTs,
      store: "vscode",
      sourceVersion: String(KNOWN_HISTORY_VERSION),
      sessionRef: null,
      repoRef: fold.workspaceRoot,
      eventKind: "editor_activity",
      metrics: {
        date: fold.date,
        chatEditCount: fold.chatEditCount,
        totalEntryCount: fold.totalEntryCount
      },
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };
  }

  let sessionCount = 0;
  for (const fold of chatSessions.sessions) {
    if (!fold.firstTs || !fold.lastTs) continue;
    sessionCount += 1;
    if (!windowOldest || fold.firstTs < windowOldest) windowOldest = fold.firstTs;
    if (!windowNewest || fold.lastTs > windowNewest) windowNewest = fold.lastTs;

    for (const ts of fold.requestTimestamps) {
      yield {
        occurredAt: ts,
        store: "vscode",
        sourceVersion: String(KNOWN_CHAT_SESSION_VERSION),
        sessionRef: fold.sessionId,
        repoRef: fold.workspaceRoot,
        eventKind: "ai_prompt_submitted",
        metrics: {},
        provenance: HISTORICAL_PROVENANCE.direct,
        extractionId
      };
    }

    const durationMs = Date.parse(fold.lastTs) - Date.parse(fold.firstTs);
    const sessionMetrics: NormalizedHistoricalEvent["metrics"] = {
      requestCount: fold.requestCount,
      afterHoursRequests: fold.afterHoursRequests,
      canceledCount: fold.canceledCount,
      errorCount: fold.errorCount,
      modelCount: fold.models.size,
      sessionStartedAt: fold.firstTs
    };
    const primaryModel = topModel(fold.models);
    if (primaryModel) sessionMetrics.primaryModel = primaryModel;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      sessionMetrics.sessionMinutes = Math.round(durationMs / 60_000);
      const bucket = bucketDurationMs(durationMs);
      if (bucket) sessionMetrics.durationBucket = bucket;
    }

    yield {
      occurredAt: fold.lastTs,
      store: "vscode",
      sourceVersion: String(KNOWN_CHAT_SESSION_VERSION),
      sessionRef: fold.sessionId,
      repoRef: fold.workspaceRoot,
      eventKind: "create_focus_session",
      metrics: sessionMetrics,
      dayBreakdown: sliceSessionByLocalDay(fold.requestTimestamps),
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };

    if (fold.afterHoursRequests > 0) {
      yield {
        occurredAt: fold.lastTs,
        store: "vscode",
        sourceVersion: String(KNOWN_CHAT_SESSION_VERSION),
        sessionRef: fold.sessionId,
        repoRef: fold.workspaceRoot,
        eventKind: "after_hours_ai_session",
        metrics: { afterHoursPrompts: fold.afterHoursRequests },
        provenance: HISTORICAL_PROVENANCE.derived,
        extractionId
      };
    }

    if (fold.errorCount > 0) {
      yield {
        occurredAt: fold.lastTs,
        store: "vscode",
        sourceVersion: String(KNOWN_CHAT_SESSION_VERSION),
        sessionRef: fold.sessionId,
        repoRef: fold.workspaceRoot,
        eventKind: "tool_failure",
        metrics: { toolFailureCount: fold.errorCount },
        provenance: HISTORICAL_PROVENANCE.derived,
        extractionId
      };
    }
  }

  // A store that yielded nothing readable still has something to report. The
  // window guard alone suppressed the epoch in exactly that case, so the
  // counters that exist to expose an unreadable store were themselves hidden
  // by it — the same shape of blind spot as the `.json`-only glob. Emit
  // whenever there is either a window or a read failure to declare.
  const readFailures =
    editDays.unparsedFiles +
    editDays.unreadableFiles +
    editDays.malformedEntries +
    chatSessions.unparsedFiles +
    chatSessions.unreadableFiles +
    chatSessions.unrecognisedFiles +
    chatSessions.malformedLines;

  if ((windowOldest && windowNewest) || readFailures > 0) {
    const window: Record<string, string> =
      windowOldest && windowNewest ? { windowOldest, windowNewest } : {};
    yield {
      // No window means nothing datable was read; the only honest timestamp
      // left is when the read happened.
      occurredAt: windowNewest ?? new Date().toISOString(),
      store: "vscode",
      sourceVersion: null,
      sessionRef: null,
      repoRef: null,
      eventKind: "extraction_epoch",
      metrics: {
        ...window,
        editDayCount: editDays.days.size,
        sessionCount,
        unparsedHistoryFiles: editDays.unparsedFiles,
        unreadableHistoryFiles: editDays.unreadableFiles,
        malformedHistoryEntries: editDays.malformedEntries,
        unparsedChatSessionFiles: chatSessions.unparsedFiles,
        unreadableChatSessionFiles: chatSessions.unreadableFiles,
        unrecognisedChatSessionFiles: chatSessions.unrecognisedFiles,
        emptyChatSessions: chatSessions.emptyDrafts,
        malformedChatSessionLines: chatSessions.malformedLines
      },
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };
  }
}
