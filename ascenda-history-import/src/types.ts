/**
 * Shared shapes for the retrospective import.
 *
 * The design rules these encode come from the research note in the Flow
 * workspace (`docs/HISTORICAL_TELEMETRY_IMPORT.md`): copy-then-parse,
 * per-record schema sniffing, UNPARSED over guessing, and provenance class
 * carried as data on every event so downstream charts can render HISTORICAL
 * bars distinctly from LIVE ones.
 */
import type { AscendaTelemetrySource } from "@ascenda-one/tool-contract";

/** The stores this importer knows how to read. Ordered by evaporation risk:
 * Claude Code's 30-day rolling purge deletes a day of baseline every day the
 * importer hasn't run, so it always extracts first. */
export const HISTORY_STORES = ["claude_code", "cursor", "vscode", "git"] as const;
export type HistoryStore = (typeof HISTORY_STORES)[number];

/** How each store's events identify on the existing telemetry wire. */
export const STORE_SOURCE: Record<HistoryStore, AscendaTelemetrySource> = {
  claude_code: "claude_code",
  cursor: "cursor_mcp",
  vscode: "vscode_extension",
  git: "code_forge"
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
 * The consent scope imported events must carry. Deliberately NOT one of
 * tool-contract's `ToolConsentScope` values yet: consenting to prospective
 * `ide_telemetry` is not consenting to a read of nine months of history, so
 * this scope must be added to the contract AND enforced by backend ingestion
 * before the first real import runs. Typed as plain string until then so the
 * gap stays visible rather than silently widening the union here.
 */
export const HISTORICAL_CONSENT_SCOPE = "historical_import";

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
  eventKind: string;
  /** Bucketed/counted metrics only — never prompt or response text. Content
   * stays on the machine; see the doc's privacy line. */
  metrics: Record<string, number | string | boolean>;
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
