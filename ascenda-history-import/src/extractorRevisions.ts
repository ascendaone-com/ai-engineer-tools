import type { HistoryStore } from "./types.js";

/**
 * The revision of each store's extractor, for rows already shipped.
 *
 * A re-run sends the same `importKey` for the same record, and the backend
 * keeps the first copy it saw. When an extractor fix changes a figure it
 * already shipped, the row that carries the new figure has to say so, or the
 * backend answers `duplicate` and the old figure stays. This number is how it
 * says so: a higher revision under the same key replaces the stored row.
 *
 * Bump a store's revision in the same change as any fix that alters a figure
 * that store already ships. Don't bump it for a new metric: an added key
 * doesn't make an old row wrong. `tests/extractorRevision.test.mjs` records a
 * hash of each store's output and fails when the hash moves without a bump.
 *
 * The macOS app's Dart extractor ships the same keys, so both writers must
 * agree on what a rung means. A writer claims a rung only when it carries
 * that rung's fix. Rows stored before this existed carry no revision and
 * read as 0.
 *
 * | Store | Rev | Fix it stands for |
 * | ----- | --- | ----------------- |
 * | all   | 1   | The first rung. Nothing is corrected yet. |
 * | claude_code | 2 | A line whose `uuid` already appeared in the same transcript, or, in a forked subagent's transcript, in the parent's main transcript, adds nothing. Tool calls, tool results, tool failures and API errors drop on resumed sessions. |
 * | codex | 2   | `inputTokens` leaves out cache reads and writes; `token_usage_record` folds as a total and `item_completed` is a meta line, so neither is drift; a rollout under both roots is read once. |
 */
export const EXTRACTOR_REVISION = {
  claude_code: 2,
  codex: 2,
  copilot_cli: 1,
  cursor: 1,
  vscode: 1,
  git: 1
} as const satisfies Record<HistoryStore, number>;
