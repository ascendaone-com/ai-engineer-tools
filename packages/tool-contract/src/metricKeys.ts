/**
 * The metric-key vocabulary.
 *
 * `eventKind` has had a canonical vocabulary and a guard since three invented
 * event names shipped and were bucketed as `unclassified`. The keys *inside*
 * `metrics{}` never got one: `metrics` was typed `Record<string, ...>`, so any
 * spelling compiled, shipped, and was accepted. Whether anything downstream
 * could read it was left to whoever wrote the reader.
 *
 * It could not. The Cursor extractor emitted `contextUsagePercent` — Cursor's
 * own column name — while every consumer looked up `contextWindowPeakPct`. The
 * value arrived, was stored, and read as "not collected" for roughly 8,720
 * imported rows. Nothing raised at any point: not the compiler, not ingestion,
 * not a test. The gauge showed a dash and that was the only symptom.
 *
 * This module is the missing half. Every key an extractor may put in `metrics`
 * is declared here with the one thing the old shape could not express — **who
 * reads it**. `MetricKey` is the union of these names and `metrics` is typed
 * against it, so an unregistered key is now a compile error rather than a
 * silent no-op. That is the same enforcement `eventKind` already has, and it
 * is deliberately the primary guard: a static scan of extractor source was
 * tried first and produced false positives (`size`, `window`, `0`) from
 * nested expressions, and a guard that cries wolf gets switched off.
 *
 * ## `readBy` is the point
 *
 * A key is not "good" because something reads it — several here are read by
 * nobody on purpose, and that is a legitimate, declared state:
 *
 * - `backend`  — a server-side reader resolves it. `backendAliases` lists the
 *                spellings that reader accepts, canonical first. If this is
 *                wrong the key is silently dropped, which is the bug above.
 * - `handoff`  — `localHandoff.ts` reads it for the desktop app. Never leaves
 *                the machine.
 * - `diagnostic` — read by neither, and meant to be. These are the honesty
 *                counters: unparsed lines, unreadable files, which timeline
 *                fallback dated a session. They exist so a reader can tell
 *                "nothing happened" from "this store could not answer", and
 *                deleting them because nothing consumes them would destroy
 *                exactly the signal they were added to preserve.
 *
 * ## Keeping it true
 *
 * `readBy: "handoff"` is checked against `localHandoff.ts` by the guard test
 * in this repo. `readBy: "backend"` cannot be — the reader is C# in another
 * repo — so `backendAliases` mirrors it by hand and the counterpart test
 * (`MetadataKeyRegistryTests` in asc-core-be) pins the same list from the
 * other side. Two mirrors, each self-checked. That does not make drift
 * impossible; it makes drift *visible*, which is strictly more than the
 * nothing that was there before.
 *
 * Adding a key: declare it here first. If it is `backend`, add the spelling to
 * the backend's reader in the same change, or it will not be read.
 */

/** Who consumes a metric key. See the module docblock — `diagnostic` is a
 * declared destination, not a gap. */
export type MetricReader = "backend" | "handoff" | "diagnostic";

export interface MetricKeySpec {
  readonly readBy: readonly MetricReader[];
  /** Only for `backend` keys: the spellings the server-side reader accepts,
   * canonical first. Mirrors the C# alias list; the backend pins the same. */
  readonly backendAliases?: readonly string[];
  /** Stated wherever the number alone is ambiguous — the mismatch this module
   * exists for was half a naming problem and half a unit problem. */
  readonly unit?: string;
  readonly note?: string;
}

// Two groups, not one list, mirroring the backend's
// `TelemetryMetadataKeys.ResolveContextOccupancy`: the canonical spellings
// share an ambiguous unit (fraction or percent, told apart by a > 1.0
// heuristic), while `contextUsagePercent` is unit-explicit — Cursor stores a
// percent, so the backend divides it by 100 unconditionally. The canonical
// group is tried first, so an event carrying both resolves on the canonical.
const CONTEXT_WINDOW_CANONICAL_ALIASES = [
  "contextWindowPeakPct",
  "context_window_peak_pct",
  "contextWindowPct",
  "context_window_pct"
] as const;

// Kept so already-imported rows stay readable; never merged into the
// canonical group, because sharing that group's heuristic would read a
// sub-1% session as 100× its true occupancy.
const CONTEXT_WINDOW_CURSOR_PERCENT_ALIASES = ["contextUsagePercent"] as const;

export const METRIC_KEYS = {
  // ── Read by a backend reader ────────────────────────────────────────────
  contextWindowPeakPct: {
    readBy: ["backend", "handoff"],
    backendAliases: CONTEXT_WINDOW_CANONICAL_ALIASES,
    unit: "fraction of the context window (0–1; uncapped for >200k contexts)",
    note: "Claude Code reports a true per-session peak. Cursor reports its composer's last known occupancy under the same key — the closest its store can answer, and not the same measurement."
  },
  contextUsagePercent: {
    readBy: ["backend", "handoff"],
    backendAliases: CONTEXT_WINDOW_CURSOR_PERCENT_ALIASES,
    unit: "percent (0–100)",
    note: "Cursor's own column name. Superseded by contextWindowPeakPct on the wire; kept because the handoff reads it and imported rows carry it. Unit-explicit on the backend: always divided by 100, never put through the fraction-or-percent heuristic."
  },
  promptCount: { readBy: ["backend", "handoff"], backendAliases: ["promptCount", "prompt_count"] },
  sessionMinutes: { readBy: ["backend"], backendAliases: ["sessionMinutes", "session_minutes"], unit: "minutes" },
  durationBucket: { readBy: ["backend", "handoff"], backendAliases: ["durationBucket", "duration_bucket"] },
  afterHoursPrompts: { readBy: ["backend", "handoff"], backendAliases: ["afterHoursPrompts", "after_hours_prompts"] },
  inputTokens: { readBy: ["backend"], backendAliases: ["inputTokens", "input_tokens"], unit: "tokens" },
  outputTokens: { readBy: ["backend"], backendAliases: ["outputTokens", "output_tokens"], unit: "tokens" },
  cacheReadTokens: { readBy: ["backend"], backendAliases: ["cacheReadTokens", "cache_read_tokens"], unit: "tokens" },
  queuedPrompts: { readBy: ["backend"], backendAliases: ["queuedPrompts", "queued_prompts"] },
  linesChangedBucket: { readBy: ["backend"], backendAliases: ["linesChangedBucket", "lines_changed_bucket"] },

  // ── Read by the local handoff only ──────────────────────────────────────
  activeMinutes: { readBy: ["handoff"], unit: "minutes" },
  afterHoursRequests: { readBy: ["handoff"] },
  approximateLintErrorsCount: { readBy: ["handoff"] },
  canceledCount: { readBy: ["handoff"] },
  chatEditCount: { readBy: ["handoff"] },
  compactionCount: {
    readBy: ["handoff"],
    note: "The backend counts context_compression_* event rows, not this key. Both are emitted; this one is for the handoff."
  },
  contextWindowPeakTokens: {
    readBy: ["handoff"],
    unit: "tokens",
    note: "The measured quantity, with no assumed denominator. Prefer this to the ratio for any within-person baseline."
  },
  date: { readBy: ["handoff"] },
  errorCount: { readBy: ["handoff"] },
  filesChangedCount: { readBy: ["handoff"] },
  humanChangesCount: { readBy: ["handoff"] },
  linesAdded: { readBy: ["handoff"] },
  linesRemoved: { readBy: ["handoff"] },
  primaryModel: { readBy: ["handoff"] },
  requestCount: { readBy: ["handoff"] },
  sessionStartedAt: { readBy: ["handoff"] },
  subagentComposers: { readBy: ["handoff"] },
  subagentToolCallCount: {
    readBy: ["handoff"],
    note: "Claude Code only: calls made inside subagent transcripts, kept out of toolCallCount so the main-loop count matches what the wire events carry."
  },
  subagentTranscripts: { readBy: ["handoff"] },
  toolCallCount: {
    readBy: ["handoff"],
    note: "The backend counts ai_tool_call_started event rows, not this key — same split as compactionCount. Deduplicated on the tool-call id; see each extractor for what one call means in its store."
  },
  toolCallsUndated: {
    readBy: ["handoff"],
    note: "Cursor only: calls whose every record carries an empty createdAt. Counted in toolCallCount, but no event exists for them — the wire total is smaller than this session count by exactly this number."
  },
  toolFailureCount: { readBy: ["handoff"] },
  totalEntryCount: { readBy: ["handoff"] },
  userModifiedEditCount: {
    readBy: ["handoff"],
    note: "Null, never 0 — Claude Code never sets userModified true, so 0 would assert 'no AI edit was ever corrected by hand'."
  },

  // ── Diagnostic: read by nobody, on purpose ──────────────────────────────
  abandonedPromptCount: { readBy: ["diagnostic"] },
  // Epoch-marker metrics. The marker is local-only and never reaches the wire
  // (see EXTRACTION_EPOCH_KIND), but it travels as a NormalizedHistoricalEvent
  // and so is keyed by the same vocabulary.
  windowOldest: { readBy: ["handoff"], note: "Oldest event the extraction saw — the marker's left edge." },
  windowNewest: { readBy: ["handoff"], note: "Newest event the extraction saw — the marker's right edge." },
  projectsWithNoReadableTranscript: { readBy: ["diagnostic"] },
  unparsedComposerHeaders: { readBy: ["diagnostic"] },
  unknownComposerHeaderTypes: { readBy: ["diagnostic"] },
  orphanedBubbles: { readBy: ["diagnostic"] },
  orphanedSubagentBubbles: { readBy: ["diagnostic"] },
  sessionsWithoutTimeline: { readBy: ["diagnostic"] },
  emptyComposers: { readBy: ["diagnostic"] },
  apiErrorCount: { readBy: ["diagnostic"] },
  assistantTurns: { readBy: ["diagnostic"] },
  compactionAutoCount: { readBy: ["diagnostic"] },
  compactionManualCount: { readBy: ["diagnostic"] },
  editDayCount: { readBy: ["diagnostic"] },
  emptyChatSessions: { readBy: ["diagnostic"] },
  gitBranch: { readBy: ["diagnostic"] },
  linesChanged: { readBy: ["diagnostic"] },
  malformedChatSessionLines: { readBy: ["diagnostic"] },
  malformedHistoryEntries: { readBy: ["diagnostic"] },
  mode: { readBy: ["diagnostic"] },
  modelCount: { readBy: ["diagnostic"] },
  modelSwitchCount: { readBy: ["diagnostic"] },
  rapidRepromptCount: { readBy: ["diagnostic"] },
  schemaUnreadable: { readBy: ["diagnostic"] },
  sessionCount: { readBy: ["diagnostic"] },
  sessionsFromBubbleTimeline: { readBy: ["diagnostic"] },
  sessionsFromCheckpointTimeline: { readBy: ["diagnostic"] },
  sessionsFromRecencyTimeline: { readBy: ["diagnostic"] },
  subagentAssistantTurns: { readBy: ["diagnostic"] },
  subagentPrompts: { readBy: ["diagnostic"] },
  subagentTokensTotal: { readBy: ["diagnostic"] },
  toolName: {
    readBy: ["diagnostic"],
    note: "Set per ai_tool_call_started event by #43's extractors and shipped in wire metadata, but no reader resolves it server-side yet (the backend's ToolName column is MCP audit, not telemetry). Registered after the fact: #38 and #43 merged past each other, and the union caught it on the next compile — metaLines all over again."
  },
  toolResultCount: { readBy: ["diagnostic"] },
  toolResultErrorCount: { readBy: ["diagnostic"] },
  unknownBubbles: { readBy: ["diagnostic"] },
  unknownLines: { readBy: ["diagnostic"] },
  metaLines: {
    readBy: ["diagnostic"],
    note: "Recognised-but-skipped transcript machinery (file-history-snapshot, queued-command, …). Split out of unknownLines by #43 so that number keeps meaning \"a type nobody has looked at\". Registered here after the fact: #41 and #43 merged past each other, and the union caught it on the next compile — which is this module doing its job."
  },
  unparsedBubbles: { readBy: ["diagnostic"] },
  unparsedChatSessionFiles: { readBy: ["diagnostic"] },
  unparsedHistoryFiles: { readBy: ["diagnostic"] },
  unparsedLines: { readBy: ["diagnostic"] },
  unreadableChatSessionFiles: { readBy: ["diagnostic"] },
  unreadableHistoryFiles: { readBy: ["diagnostic"] },
  unrecognisedChatSessionFiles: { readBy: ["diagnostic"] }
} as const satisfies Record<string, MetricKeySpec>;

/** Every key an extractor may place in `metrics{}`. Anything else is a
 * compile error — which is the whole point. */
export type MetricKey = keyof typeof METRIC_KEYS;

/** The value shape of `metrics{}`: flat, bucketed, never free text. */
export type MetricValue = number | string | boolean;

/** Keys a server-side reader resolves, with the spellings it accepts. */
export function backendMetricKeys(): ReadonlyArray<readonly [MetricKey, readonly string[]]> {
  return (Object.entries(METRIC_KEYS) as Array<[MetricKey, MetricKeySpec]>)
    .filter(([, spec]) => spec.readBy.includes("backend"))
    .map(([key, spec]) => [key, spec.backendAliases ?? [key]] as const);
}
