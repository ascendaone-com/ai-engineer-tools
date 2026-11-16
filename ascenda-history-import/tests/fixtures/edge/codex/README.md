# Codex edge cases

A single `.jsonl` is placed at `sessions/2026/03/02/rollout-<ts>-<id>.jsonl`
by the test. A directory is already shaped like a snapshot root.

Figures are what a correct reader reports. In every case below no tokens are
cached, so `inputTokens` is the same whether a reader counts cache reads in
it or not.

| Case | What it pins | Expected |
|---|---|---|
| `token-usage-record-only.jsonl` | Totals arrive only on a top-level `token_usage_record` line. It's a known line type, and it's a source of totals. | `unknownLines` 0, `inputTokens` 1000, `outputTokens` 50, `promptCount` 1 |
| `token-usage-record-and-token-count.jsonl` | Both lines carry the same running total. Figures match a rollout with `token_count` alone. | `unknownLines` 0, `inputTokens` 1000, `outputTokens` 50, `promptCount` 1 |
| `archived-copy/` | One rollout under `sessions/` and again under `archived_sessions/`. It counts once. | `promptCount` 1, `mainThreadToolCallCount` 1, `assistantTurns` 1, `inputTokens` 1000, `outputTokens` 50 |
| `fork-replay.jsonl` | A fork replays its parent's session header, prompt and running total (500 in, 50 out) with older timestamps, then works. Only the fork's own work counts. | `promptCount` 1, `mainThreadToolCallCount` 1, `assistantTurns` 1, `inputTokens` 300, `outputTokens` 40, `unknownLines` 0 |
