# Transcript Test Corpus Plan

The importer's tests use hand-written fixtures, one real-shaped Claude
transcript, and a lineage store whose figures are pinned
(`tests/lineageFigures.mjs`). Most of the measurements behind its design live
only in code comments: "991 transcripts, 21,826 contested ids" in
`promptLedger.ts`, "11,059 lines, 5,173 messages" in `claudeCode.ts:485`.
Nobody can re-run them, and nothing tells us when a change moves them.

This plan adds a seeded transcript generator that knows the true figures of
everything it writes, plus one small named fixture per edge case. Line
numbers are against `main` at `badbcf6`.

Status: not started. Touches tests only, so it can run beside any other plan.

## 1. Seeded generator

`ascenda-history-import/tests/support/corpus.mjs`, plain ESM, no
dependencies.

```js
export function generateCorpus({ seed, sessions, store, shape }) → {
  files: [{ relPath, text }],   // written under a temp snapshot by the caller
  truth: { sessions: [{ sessionRef, promptCount, toolCallCount,
           toolFailureCount, assistantTurns, compactionCount,
           inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
           subagentTranscripts, subagentToolCallCount }] }
}
```

- **Deterministic.** A small PRNG (mulberry32 is enough) seeded from `seed`.
  Same seed, same bytes. Timestamps start at a fixed instant and advance by
  PRNG-chosen gaps, so active-minute figures are deterministic too.
- **Fictional content only.** Prompt and tool text is drawn from a fixed
  list of placeholder strings ("lorem 1", "Read", "Bash"); paths are
  `/Users/example/Dev/repo-N`. Nothing from a real store, ever.
- **Stores.** `claude_code` and `codex` first, since they carry most edge
  cases. Copilot CLI after, if the first two land well.
- **Shapes** (`shape` is a set of flags; each maps to a real behaviour the
  extractors handle):

  | Flag | Claude Code | Codex |
  |---|---|---|
  | `multiLineMessages` | one API message split over several `assistant` lines, usage repeated | n/a |
  | `subagents` | `subagents/agent-<id>.jsonl` with `.meta.json` | subagent threads with `thread_source: "subagent"` |
  | `forkedSubagent` | sidecar `isFork: true`, opening lines copied from the parent | `forked_from_id` with replayed parent `token_count` |
  | `resumeReplay` | lines repeated in the same file with the same `uuid`s | n/a |
  | `resumeCopy` | a new file that copies the parent's lines, `sessionId` rewritten | continuation pages `rollout-…_<n>.jsonl` |
  | `compaction` | `compact_boundary` system line | `compacted` line, `context_compacted` event |
  | `tokenUsageRecord` | n/a | `token_usage_record` beside or instead of `token_count` |
  | `archivedCopy` | n/a | same rollout under `sessions/` and `archived_sessions/` |
  | `truncatedTail` | last line cut mid-JSON | same |
  | `malformedMiddle` | one invalid line between valid ones | same |

- **Truth is computed by the generator, not by the extractor.** For each
  flag the generator records what a correct reader must report. For example,
  `resumeReplay` adds no tool calls to the truth, and `archivedCopy` counts
  one copy.

## 2. Tests driven by it

`tests/corpusTruth.test.mjs`:

- For each store and each flag on its own, generate 5 sessions with seed 1,
  run the extractor, and compare every truth key with the shipped metric.
  Then all flags at once with seeds 1 to 20.
- When a flag's case is a known open bug (for example `resumeReplay` before
  the replay fix lands), mark that case `todo` with a link to its plan doc.
  It must fail today; when the fix lands, remove the `todo`.
- One run of 2,000 sessions under `ASCENDA_SLOW_TESTS=1`, checking totals
  only, as a smoke test for performance regressions. Print elapsed time; no
  timing assertion.

`tests/corpusDeterminism.test.mjs`: the same seed gives byte-identical files
and identical extractor output twice in a row. This also pins the extractor's
output order.

## 3. Named edge fixtures

`ascenda-history-import/tests/fixtures/edge/<store>/<case>.jsonl`, each under
40 lines, written by hand, with a `README.md` per store listing every case,
the behaviour it pins, and the expected figures. Start with:

- `claude_code/resume-replay.jsonl`
- `claude_code/fork-subagent/` (parent, `subagents/agent-x.jsonl`, `agent-x.meta.json`)
- `claude_code/incomplete-final-record.jsonl`
- `claude_code/malformed-between-valid.jsonl`
- `claude_code/compaction-continues-session.jsonl`
- `codex/token-usage-record-only.jsonl`
- `codex/token-usage-record-and-token-count.jsonl`
- `codex/archived-copy/` (`sessions/…/rollout-x.jsonl`, `archived_sessions/rollout-x.jsonl`)
- `codex/fork-replay.jsonl`

The fixes in `docs/CODEX_TOKEN_ACCOUNTING_PLAN.md` and
`docs/CLAUDE_TRANSCRIPT_REPLAY_PLAN.md` add their own fixtures. If one of
those lands first, move its fixture here instead of duplicating it.

## 4. Re-runnable measurements

`ascenda-history-import/scripts/measure-store.mjs`: reads the developer's own
stores read-only and prints counts only. No content, no paths, no ids. The
first measurements to port are the ones quoted in comments today: repeated
`uuid`s per file, contested ids across files, lines per message, rollouts
present in both Codex roots, and sidecars with `isFork`. Each comment that
quotes a figure then names the script and the date it was measured, so the
figure can be refreshed. Not run in CI; it reads a real home directory.

## Done when

- The generator, both test files and the edge fixtures are in, and
  `npm run verify` passes, with the known open bugs marked `todo`.
- `scripts/measure-store.mjs` prints the five measurements above on a
  developer machine.
- The comments quoting figures in `promptLedger.ts` and `claudeCode.ts` name
  the script.
