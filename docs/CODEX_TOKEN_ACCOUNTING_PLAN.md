# Codex Token Accounting Plan

The Codex extractor (`ascenda-history-import/src/extractors/codex.ts`) ships
token figures that don't mean what the same keys mean for Claude Code and
Copilot, drops cache writes, and flags a current line type as drift. This plan
fixes all four and makes the reader stream. Line numbers are against `main` at
`badbcf6`.

Status: not started.

## What's wrong today

Checked against real rollouts on a developer machine in November 2026 (59
rollouts, Codex builds from September to November).

1. **`inputTokens` includes cached tokens.** `totalsOf` (`codex.ts:340-347`)
   copies `total_token_usage.input_tokens` straight into `input`, and
   `codex.ts:1082` ships it as `inputTokens`. Codex counts
   `cached_input_tokens` inside that figure; the module doc says so at
   `codex.ts:63-64`. Claude Code's `inputTokens` leaves cache reads out
   (`claudeCode.ts:1175`), and Copilot subtracts both cache figures
   (`copilotCli.ts:265`). So `inputTokens + cacheReadTokens` double-counts
   every cached Codex token. On the eight local sessions with more than a
   million input tokens, 96% to 98% of that input was cached, so the shipped
   `inputTokens` is 25 to 50 times the uncached figure.
2. **Cache writes are dropped.** Every `token_count` in current rollouts
   carries `cache_write_input_tokens` in both `total_token_usage` and
   `last_token_usage`. Nothing reads it, so Codex sessions never ship
   `cacheCreationTokens`.
3. **`token_usage_record` counts as drift.** Current rollouts write a
   top-level `{"type":"token_usage_record", payload: {usage, turn_token_usage,
   thread_token_usage, response_id, turn_id, thread_id, …}}` line beside each
   `event_msg/token_count`. It's in neither `KNOWN_CODEX_LINE_TYPES`
   (`codex.ts:117-123`) nor `META_CODEX_LINE_TYPES` (`codex.ts:133`), so
   `sniffCodexLine` returns `unknown` (`codex.ts:226`) and `foldLinesInto`
   adds it to `unknownLines` (`codex.ts:631`). Eight of the 59 local rollouts
   carry it, 1,880 lines in all. `unknownLines` is meant to be the drift
   alarm, and it now fires on every recent rollout.
4. **The same rollout in two roots counts twice.** `extractCodex` walks
   `sessions/` and `archived_sessions/` (`codex.ts:944-957`).
   `rolloutReadingOrder` (`codex.ts:921-932`) drops a `.jsonl.zst` beside its
   plain twin, but not a file whose basename appears under both roots. A copy
   caught mid-archive, or restored by hand, folds into the same session twice:
   prompts, tool calls and turns double. Tokens survive because totals are a
   max. No such pair exists on the machine checked, so this is a guard.
5. **Whole-file reads.** `readRolloutText` (`codex.ts:882-885`) returns the
   whole file as one string, and `extractCodex` splits it. The largest local
   rollout is 81 MB. A rollout past V8's string limit (about 512 MB) fails and
   is counted in `unreadableRolloutFiles`. Claude Code already streams
   (`claudeCode.ts:840-870`).

## Order of work

Steps 1 to 3 change shipped figures. Land them after, or together with, the
extractor revision in `docs/IMPORT_CORRECTIONS_PLAN.md`; without it the
backend keeps every Codex session already imported at the old figures and
answers `duplicate` to the corrected ones.

1. Input excluding cache, and the contract says so.
2. Cache writes.
3. `token_usage_record`: recognised, and a fallback source of totals.
4. Duplicate-root guard.
5. Streaming read.

Steps 4 and 5 are independent and can go in any order after 3.

## Step 1: `inputTokens` excludes cache reads

In `totalsOf` (`codex.ts:340-347`), keep the raw figure internally, because
the fork-replay check at `codex.ts:726` and the subagent delta at
`codex.ts:333-339` compare raw cumulative inputs, and both are correct today.
Subtract only at emission:

```ts
// codex.ts, at the emission near line 1082
const uncached = (t: TokenTotals) => Math.max(0, t.input - t.cached - t.cacheWrite);
sessionMetrics.inputTokens = uncached(own) + uncached(subagent);
```

(`cacheWrite` arrives in step 2. Until then subtract `cached` only.)

Also:

- `subagentTokensTotal` (`codex.ts:1094`) is input plus output, and the
  comment at `codex.ts:1089-1090` says Codex input already includes the
  cached part. Keep that figure as it is, since it's defined as everything
  the subagent consumed, and rewrite the comment so it names the definition
  instead of leaning on Codex's.
- Update the module doc at `codex.ts:60-66` to say `inputTokens` is uncached
  input, the same as every other store.
- Define the key in the contract. At
  `packages/tool-contract/src/metricKeys.ts:150`, add a doc comment on
  `inputTokens`: "Input tokens billed at the full rate: cache reads and cache
  writes excluded. Every extractor ships it on this definition." Do the same
  for `cacheReadTokens` and `cacheCreationTokens`.
- The macOS app's Dart extractor ships the same keys (see the note at
  `localHandoff.ts:76-81`). Open a matching change on the app's integration
  branch and link it from this PR. Both must ship the same definition or the
  backend sees two meanings again.

**Tests.** In `tests/codex.test.mjs`, a rollout whose last `token_count` has
`input_tokens: 10000, cached_input_tokens: 8000` ships `inputTokens: 2000`
and `cacheReadTokens: 8000`. A subagent thread with its own totals is summed
on the same definition. The fork-replay cases in `tests/codexThreads.test.mjs`
must pass unchanged.

## Step 2: cache writes

- Add `cacheWrite: number` to `TokenTotals` (`codex.ts:291-295`) and
  `NO_TOKENS`, max it in `maxTokens` (`codex.ts:299-305`), subtract it in the
  subagent delta (`codex.ts:333-339`).
- In `totalsOf`, read `total.cache_write_input_tokens`. Absent means 0 for
  the sum but leaves a `cacheWriteSeen` flag false. Set the flag only from a
  thread's own lines, not from a replayed parent's, the way `seen` works on
  `TokenTrack` (`codex.ts:316-327`).
- Ship `cacheCreationTokens` only when some thread reported the field,
  following `claudeCode.ts:1656`:
  `if (fold.cacheWriteSeen) sessionMetrics.cacheCreationTokens = …`.
  A rollout from before the field existed ships no key, not 0.

**Tests.** A rollout with `cache_write_input_tokens: 1200` ships
`cacheCreationTokens: 1200` and takes it out of `inputTokens`. A rollout
without the field ships no `cacheCreationTokens` key.

## Step 3: `token_usage_record`

- Add `"token_usage_record"` to `KNOWN_CODEX_LINE_TYPES` (`codex.ts:117`).
- In `foldLinesInto`, handle it beside `event_msg/token_count`. Read
  `payload.thread_token_usage` as a cumulative total with the same field
  names as `total_token_usage`, and fold it through the same `maxTokens`.
  Because both lines are cumulative and folded by max, a rollout carrying
  both comes out identical to one carrying `token_count` alone, so no pairing
  logic is needed.
- Don't use the two cumulative figures to decide whether two lines describe
  the same response. On the rollouts checked they agree, but nothing
  documents that they share a base, and a max fold doesn't need them to.
- Use `payload.thread_id` to route the line to its thread's track the same
  way `session_meta` identity does, so a subagent's record lands on the
  subagent.
- Don't read `usage` or `turn_token_usage` yet. They're per-response and
  per-turn, and the session figures don't need them.

**Tests.**

- A rollout with both line types ships the same totals as the same rollout
  with the `token_usage_record` lines deleted.
- A rollout with only `token_usage_record` lines (no `token_count`) ships
  totals, not `tokensNotCollected`.
- `unknownLines` is 0 on both.

## Step 4: one rollout, one read

In `rolloutReadingOrder` (`codex.ts:921-932`), after the `.zst` filter, drop
any file whose basename (with `.zst` stripped) was already kept from the
other root. Keep the larger file, since an archive copy caught mid-move is
the shorter one; on a tie keep the `sessions/` copy. Count the dropped files
in a new `duplicateRolloutFiles` metric on the epoch marker so the guard's
effect is visible. Register the key in
`packages/tool-contract/src/metricKeys.ts` beside `unreadableRolloutFiles`.

**Test.** The same rollout placed under both roots gives the prompt, tool-call
and token figures of one copy, and `duplicateRolloutFiles: 1`.

## Step 5: stream the plain read

Change `readRolloutText` to an async line iterator. For a plain `.jsonl`,
use `fs.open(...).readLines()` the way `claudeCode.ts:841-870` does. For
`.jsonl.zst`, stream the decoder's stdout through `readline` instead of
buffering it. `firstSessionMeta` (`codex.ts:589`) only needs the first
`session_meta`, so read lines into a small buffer until it's found, then feed
the buffer and the rest of the iterator to `foldLinesInto`. Change
`foldLinesInto` to accept an `AsyncIterable<string>`.

The same change applies to the Copilot CLI reader at `copilotCli.ts:601`,
which also reads whole files. Do it in the same PR only if the diff stays
small; otherwise leave a follow-up.

**Test.** Add a memory-bound test that generates a 300 MB rollout on the fly
(repeat one `response_item` line) into a temp dir and checks it's read,
not counted as unreadable. Mark it skipped by default and run it under
`ASCENDA_SLOW_TESTS=1`.

## Done when

- `npm run verify` passes, with the new tests above.
- On a real store, a local run (`ascenda-history-import import`, no `--ship`)
  writes normalized events to staging that show Codex
  `inputTokens` below `cacheReadTokens` on long sessions, `cacheCreationTokens`
  present on recent ones, and `unknownLines: 0` on rollouts from November 2026.
- The app's matching change is linked.
- `CHANGELOG.md` has a line under the unreleased heading.
