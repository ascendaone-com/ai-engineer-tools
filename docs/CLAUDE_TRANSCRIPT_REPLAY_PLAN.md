# Claude Transcript Replay Plan

Three gaps in how `ascenda-history-import` reads Claude Code transcripts: a
resumed session that repeats lines inside its own file, forked subagents that
repeat their parent's lines, and Claude Desktop's Cowork sessions, which we
never find. Line numbers are against `main` at `badbcf6`.

Status: not started.

## 1. Repeated lines inside one transcript

### What happens

A resumed session can write lines into its transcript that the same file
already holds, with the original `uuid`s and timestamps. On a developer
machine in November 2026, 36 of 1,743 main transcripts did this, 9,374
repeated lines in all (3,121 `assistant`, 2,153 `user`, 3,950 `attachment`,
150 `system`).

`TimelineOwnership.owns` (`promptLedger.ts:504-527`) answers per line. For a line
whose `sessionId` names this file and whose `uuid` nobody else claims, it
returns true every time, so the fold counts each repeat
(`claudeCode.ts:902-906` and the counters after it).

What that does to shipped figures, from the extractor on `main` run against
the three worst transcripts, as they are and with repeats removed:

| | `toolCallCount` | `toolFailureCount` | `apiErrorCount` |
|---|---|---|---|
| Transcript A | 1,139 vs 611 | 40 vs 21 | 24 vs 12 |
| Transcript B | 3,069 vs 2,418 | 35 vs 31 | 0 vs 0 |
| Transcript C | 895 vs 693 | 40 vs 33 | 16 vs 16 |

`toolResultCount` moves with `toolCallCount`. Tokens, `promptCount`,
`assistantTurns`, `compactionCount` and `activeMinutes` come out the same
both ways: tokens dedupe on `message.id|requestId` (`claudeCode.ts:481-490`),
prompts on `PromptLedger.claim` (`promptLedger.ts:145-158`), and the rest
don't hold up when a line repeats. So the fix touches counters only.

### Change

Keep a per-file set of seen `uuid`s and treat a repeat exactly like a copy:
still read, because turn state needs every line, but adding nothing.

- In the per-file reader (`claudeCode.ts:840` onward), create
  `const seenInFile = new Set<string>()` beside `turnRunning`.
- Where `owned` is computed (`claudeCode.ts:902`), check the set first:

  ```ts
  const repeat = sniffed.uuid !== null && seenInFile.has(sniffed.uuid);
  if (sniffed.uuid !== null) seenInFile.add(sniffed.uuid);
  const owned = !repeat && opts.ownership.owns(sniffed, filePath, …);
  ```

  Check before calling `owns`, not after: `owns` records orphan claims
  (`promptLedger.ts:524-525`), and a repeat must not claim anything.
- Count repeats in a new `repeatedLines` session metric, shipped only when
  above 0. Register it in `packages/tool-contract/src/metricKeys.ts` next to
  `syntheticPromptLines`.
- Sidechain files get the same set: each subagent transcript is read through
  the same function.
- The macOS app's Dart extractor reads the same files. Open a matching change
  on the app's integration branch and link it here.

### Tests

New fixture `tests/fixtures/claude-resume-replay.jsonl`, written by hand: a
session with two tool calls, one failure and an API error, then the same
lines repeated with the same `uuid`s, then one new tool call. Expect
`toolCallCount: 3`, `toolFailureCount: 1`, `apiErrorCount: 1`,
`repeatedLines` equal to the repeated count, and token and prompt figures
identical to the fixture with the repeats deleted.

## 2. Forked subagents

### What happens

A subagent's sidecar `agent-<id>.meta.json` can carry `isFork: true`. A forked
subagent starts from a copy of its parent's conversation, so its transcript
opens with lines that also sit in the parent's file. We already read the
sidecar (`claudeCode.ts:855-862`) but keep only `agentType` and `toolUseId`.
On the machine checked, 1 of 542 sidecars sets `isFork`, so this is rare
today; the fork feature is new and the count will grow.

`ownsSidechainLine` (`promptLedger.ts:537-546`) returns true for any line
whose `sessionId` equals the session it was found under, which is true of
the copied lines too. They count again as subagent tool calls and turns.

### Change

- Read `isFork` from the sidecar into the tally (`claudeCode.ts:858-859`).
- When it's true, skip lines whose `uuid` already appeared in the parent's
  main transcript. The parent's file is read before its subagents in walk
  order (check this in `walkJsonlFiles`, `claudeCode.ts:1274`, and add an
  assertion if it isn't guaranteed), so collect main-thread `uuid`s for the session into a set on
  the fold and consult it for fork sidechains only.
- A missing or unreadable sidecar keeps today's behaviour.
- Count skipped lines into the same `repeatedLines` metric.

### Tests

A session directory with a parent transcript, a `subagents/agent-x.jsonl`
that starts with three of the parent's lines (same `uuid`s) then two of its
own, and `agent-x.meta.json` with `isFork: true`. Expect
`subagentToolCallCount` and `subagentAssistantTurns` from the two own lines
only. The same directory without `isFork` keeps today's figures.

## 3. Claude Desktop Cowork sessions

### What happens

Claude Desktop runs Cowork sessions with their own config dir, so their
transcripts never land in `~/.claude`:

```
~/Library/Application Support/Claude/local-agent-mode-sessions/
  <account>/<org>/local_<id>/.claude/projects/<slug>/<sessionId>.jsonl
  <account>/<org>/agent/local_ditto_<id>/.claude/projects/<slug>/<sessionId>.jsonl
```

Each session folder also has an `audit.jsonl` beside `.claude/`. It repeats
the session's usage and must not be read. `claude-code-sessions/` next to it
holds JSON manifests for Code tab sessions, whose transcripts are already in
`~/.claude/projects`; leave it alone.

`resolveStorePaths` (`stores.ts:111-151`) builds `claudeProjectsDirs` from
`CLAUDE_CONFIG_DIR` or `~/.claude` only (`stores.ts:81-103`), so none of
these are read.

### Change

- In `stores.ts`, add `claudeDesktopSessionsRoot:
  path.join(appSupport, "Claude", "local-agent-mode-sessions")` to
  `StorePaths`.
- Add a resolver `coworkProjectsDirsOf(root)` that walks at most five levels
  for directories named `projects` whose parent is named `.claude`, and
  returns them sorted. It never descends into a `.claude/projects` folder and
  never returns a path containing `audit`.
- Append the result to `claudeProjectsDirs` after the config dirs, so the
  existing staging and walk read them with no other change. Keep
  `claudeConfigDirs` as it is; Cowork dirs have no `settings.json` worth
  reading.
- Mark events from these dirs so a reader can tell them apart: set
  `clientName: "claude-desktop-cowork"` on the session (the key exists in
  `metricKeys.ts`).
- Linux and Windows: Claude Desktop's app-support path differs. Resolve only
  on macOS in this change and say so in the doc comment.

### Tests

In `tests/storePaths.test.mjs`, a temp home with both folder shapes above,
an `audit.jsonl` and a `claude-code-sessions/` manifest. Expect exactly the
two `projects` dirs, in sorted order, after the `~/.claude` one. An extract
over that home ships two sessions with `clientName:
"claude-desktop-cowork"`.

## Order of work

These change shipped figures for sessions already imported, so land them
after, or together with, `docs/IMPORT_CORRECTIONS_PLAN.md`. Parts 1 and 2
both touch the per-file reader in `claudeCode.ts`; do them in one branch.
Part 3 touches only `stores.ts` and can go first on its own.

## Done when

- `npm run verify` passes with the tests above.
- A local `ascenda-history-import import` (no `--ship`) on a real store
  shows `repeatedLines` on resumed sessions and Cowork sessions present.
- The app's matching change for part 1 is linked.
- `CHANGELOG.md` has a line under the unreleased heading.
