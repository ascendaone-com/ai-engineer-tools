import type { SessionDaySlice } from "./daySlice.js";
import type { AutonomyBand } from "@ascenda-one/tool-kit";

/**
 * Shared shapes for the retrospective import.
 *
 * The design rules these encode come from the research note in the Flow
 * workspace (`docs/HISTORICAL_TELEMETRY_IMPORT.md`): copy-then-parse,
 * per-record schema sniffing, UNPARSED over guessing, and provenance class
 * carried as data on every event so downstream charts can render HISTORICAL
 * bars distinctly from LIVE ones.
 */
import { ASCENDA_HISTORICAL_CONSENT_SCOPE } from "@ascenda-one/tool-contract";
import type {
  AscendaTelemetrySource,
  AscendaTelemetryEventType,
  MetricKey,
  MetricValue
} from "@ascenda-one/tool-contract";

/** The stores this importer knows how to read. Ordered by evaporation risk:
 * Claude Code's 30-day rolling purge deletes a day of baseline every day the
 * importer hasn't run, so it always extracts first. Codex sits second because
 * its rollouts are the same shape as Claude Code's transcripts and cost
 * nothing to read — no purge has been observed on them, so its place here is
 * about cheapness, not measured risk. */
export const HISTORY_STORES = ["claude_code", "codex", "cursor", "vscode", "git"] as const;
export type HistoryStore = (typeof HISTORY_STORES)[number];

/** How each store's events identify on the existing telemetry wire. */
export const STORE_SOURCE: Record<HistoryStore, AscendaTelemetrySource> = {
  claude_code: "claude_code",
  // The registry has no codex value; the live Codex hooks ride `cli_agent`
  // with `metadata.host: "codex"` (see STORE_HOST), and the import follows
  // them so a historical Codex row and a live one are the same population.
  codex: "cli_agent",
  cursor: "cursor_mcp",
  vscode: "vscode_extension",
  git: "code_forge"
};

/**
 * The `metadata.host` a store's events carry on the wire, where the source
 * alone does not name the tool. `cli_agent` is shared by every agent CLI
 * without its own registry value, and `host` is how the backend tells them
 * apart later without a contract change — the same convention the live Codex
 * hooks established. Stores whose source already names the tool carry none.
 */
export const STORE_HOST: Partial<Record<HistoryStore, string>> = {
  codex: "codex"
};

/**
 * Provenance classes for imported events. Live events carry
 * `ASCENDA_PROVENANCE` ("ai_work_telemetry"); everything this package emits
 * carries one of these instead, so no historical number can masquerade as a
 * live observation.
 *
 * - `direct`: read verbatim from a store record (a timestamp, a token count).
 * - `derived`: computed across records (session length, gap analysis).
 * - `unparsed`: the record's self-labelled schema version was unknown; the
 *   raw record is retained in staging and nothing was inferred from it.
 */
export const HISTORICAL_PROVENANCE = {
  direct: "historical_direct",
  derived: "historical_derived",
  unparsed: "historical_unparsed"
} as const;
export type HistoricalProvenance =
  (typeof HISTORICAL_PROVENANCE)[keyof typeof HISTORICAL_PROVENANCE];

/**
 * The consent scope imported events must carry. A real `ToolConsentScope`
 * (re-exported from tool-contract rather than restated here, so the two
 * cannot drift): consenting to prospective `ide_telemetry` is not consenting
 * to a read of nine months of history.
 *
 * **Enforcement is live in production, verified 25 August 2026** — a real run
 * of 28,158 backdated events came back `accepted=0 rejected=28158
 * consent_missing_or_expired`, having reached an account with no
 * `HistoricalImport` lease. This comment previously said the gate was still
 * rolling out and that this package must not ship as if it were live; that was
 * accurate when written on 19 August and stopped being accurate when the
 * backend merged, which is exactly the drift P-D30.1 rule 3 requires this line
 * to be kept ahead of.
 *
 * **The gate does not read this string.** The backend decides on the event's
 * *provenance* — the closed `historical_*` set — precisely so an importer that
 * kept declaring `ide_telemetry` could not buy its way in with a label. Sending
 * this scope is still correct: it makes the intent explicit in the audit
 * record, and it is what the consent surface names.
 */
export const HISTORICAL_CONSENT_SCOPE = ASCENDA_HISTORICAL_CONSENT_SCOPE;

/** What `scan` reports per store — the inventory the onboarding surface shows
 * the user before asking for consent. Everything here is countable without
 * parsing record content. */
export interface StoreInventory {
  store: HistoryStore;
  rootPath: string;
  present: boolean;
  /** Observed data window, from file timestamps — cheap and content-free. */
  oldest?: string;
  newest?: string;
  /** Store-specific counts (files, sessions, bytes…). Keys are stable per
   * store; see each scanner for what it promises. */
  counts: Record<string, number>;
  /** Human-readable retention warning, when the store is evaporating. */
  retentionRisk?: string;
  notes: string[];
}

/**
 * The extraction-window marker every extractor emits once per store. It is
 * **not** a work event: it carries no session, no repo, and its metrics are
 * statistics about the extraction run itself (observed window, unparsed file
 * counts). It exists so `scan`/`import` can report the window and so the
 * handoff can bound its own data, and the shipper drops it before the wire —
 * there is no canonical telemetry type for "here is what I read", and
 * inventing one would put extraction bookkeeping into the work catalog.
 */
export const EXTRACTION_EPOCH_KIND = "extraction_epoch" as const;

/**
 * What an extractor may put in `eventKind`: a canonical telemetry type, or the
 * local-only epoch marker above.
 *
 * Typed against the contract rather than `string` on purpose. This field is
 * cast straight onto the wire in the shipper, so an invented name here reaches
 * the backend, is accepted, and is bucketed as `unclassified` where no view
 * reads it — a silent import that reports success. Narrowing it to the union
 * makes that failure a compile error instead.
 */
export type HistoricalEventKind = AscendaTelemetryEventType | typeof EXTRACTION_EPOCH_KIND;

/**
 * The normalized event every extractor emits — the doc's
 * `(occurred_at, source, source_version, session_ref, repo_ref, event_kind,
 * metrics{}, provenance_class, extraction_id)` schema. Mapping onto
 * `AscendaEventPayload` for the batch wire happens in one place (the shipper),
 * not per extractor.
 */
export interface NormalizedHistoricalEvent {
  occurredAt: string;
  store: HistoryStore;
  /** The store record's self-labelled schema version (`version` on a Claude
   * line, `_v` on a Cursor record) — the anchor contract tests pin against. */
  sourceVersion: string | null;
  sessionRef: string | null;
  repoRef: string | null;
  eventKind: HistoricalEventKind;
  /** Bucketed/counted metrics only — never prompt or response text. Content
   * stays on the machine; see the doc's privacy line.
   *
   * Keyed by {@link MetricKey}, not `string`. It was `Record<string, ...>`
   * until an extractor emitted `contextUsagePercent` where every reader looked
   * up `contextWindowPeakPct`; that shipped, was accepted, and read as "not
   * collected" for roughly 8,720 rows without anything raising. An
   * unregistered key is now a compile error — declare it in `METRIC_KEYS`,
   * saying who reads it, and it stops being possible to ship a metric nothing
   * can consume. */
  metrics: Partial<Record<MetricKey, MetricValue>>;
  /**
   * Per-local-day slices of a session, oldest first. Local-only: `metrics` is
   * flat by contract because it becomes wire metadata, and this is nested, so
   * it rides beside rather than inside — which also means it cannot reach the
   * backend by accident. Only `create_focus_session` carries it, and only
   * where the store gave prompt timestamps to slice.
   */
  dayBreakdown?: SessionDaySlice[];
  /**
   * Agent-supervising minutes by autonomy band — how much latitude the agent
   * had while it was working, for the part of active time the person did not
   * spend typing.
   *
   * Local-only for the same reason `dayBreakdown` is: `metrics` is flat by
   * contract because it becomes wire metadata, and a per-band map is not. It
   * also should not reach the wire on its own merits — banding is a *reader's*
   * vocabulary that `autonomyBand` derives at query time from the stored
   * `autonomyMode` token, precisely so it can be changed later; storing the
   * band would freeze a decision that was deliberately left open.
   *
   * Bands with no time are absent rather than zero, and `unknown` is a real
   * band: a session that ran before any `permissionMode` was declared has
   * supervising minutes nobody can place, and folding those into a neighbour
   * would make a guess indistinguishable from a measurement.
   */
  autonomySplit?: Partial<Record<AutonomyBand, number>>;
  provenance: HistoricalProvenance;
  extractionId: string;
}

/** One store's importer. `scan` is safe to run any time; `snapshot` copies the
 * live store into staging (never parse live files); `extract` reads only the
 * snapshot. */
export interface StoreExtractor {
  store: HistoryStore;
  scan(): Promise<StoreInventory>;
  snapshot(stagingDir: string): Promise<string>;
  extract(snapshotDir: string, extractionId: string): AsyncIterable<NormalizedHistoricalEvent>;
}
