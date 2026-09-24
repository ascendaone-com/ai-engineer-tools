# @ascenda-one/history-import

Retrospective AI-usage import: extracts the baseline that already exists on
an engineer's machine — Claude Code transcripts, Codex CLI rollouts, Cursor's
conversation store, VS Code local history and Copilot sessions, git — and
ships it as provenance-classed historical events on the existing telemetry
wire.

The store formats these extractors read are reverse-engineered and
undocumented upstream, so they can change without notice. Each extractor's
header comment states the shape it expects and the invariants it relies on;
read that, and the fixtures under `tests/`, before changing one.

## Why this package exists here, not in the app

The macOS Flow app is sandboxed and child processes inherit the sandbox, so
it can never read `~/.claude` or the editors' Application Support stores. The
app is the consent and display surface; it hands the user one terminal
command (same pattern as hooks pairing) and this CLI does the reading.

## Design rules (non-negotiable)

1. **Evaporation order.** Claude Code first — its 30-day rolling purge is
   deleting a day of baseline per day. Then Codex (no purge observed on its
   rollouts; it sits second because it is the same transcript shape and
   costs nothing to read, not because of measured risk), then Cursor, then
   VS Code, then git.
2. **Copy, then parse.** Extraction only ever reads a staged snapshot
   (`src/staging.ts`), never live files. SQLite snapshots carry their `-wal`.
3. **Sniff per record, dispatch on the self-labelled version** (`version` on
   Claude lines, `cli_version` on a Codex rollout's `session_meta`, `_v` on
   Cursor records, `version: 1` in VS Code entries).
   Unknown shapes become `historical_unparsed` — raw retained in staging,
   nothing inferred. Fixture tests per known (tool, version) pair.
4. **Metrics only by default.** Prompt/response text, thinking blocks and
   file contents never leave the machine. Content-level ingestion, if it ever
   ships, is a separate explicit opt-in — not this package's default path.
5. **Aggregate before shipping, unless a reader counts the rows.** Per-session
   / per-day events, not one event per bubble — a single machine's stores hold
   tens of thousands of them. The one deliberate exception is
   `ai_tool_call_started`: the backend's work-demand rail derives
   `toolCallCount` by counting rows of that type and reads no `toolCallCount`
   key off metadata, so a session-level aggregate would ship, store, and be
   counted by nothing. Per-call events also place the work in the right hour,
   which a session spanning six of them cannot. Expect an order of magnitude
   more events than a session-only import, and an `events.jsonl` to match.
6. **Provenance is data.** Every event carries `historical_direct`,
   `historical_derived` or `historical_unparsed` — never the live
   `ai_work_telemetry` provenance — so no chart can pass history off as
   live observation.

## Status (2026-08-18)

| Piece | State |
|---|---|
| `scan` (per-store inventory, content never opened) | implemented |
| `fix-retention` (Claude `cleanupPeriodDays`, merge-not-clobber) | implemented |
| Staging/snapshot (copy-then-parse, WAL-aware, **torn down by the run that makes it**) | implemented |
| `archive` (durable content-addressed copy, dedup, verify, restore, prune) | **implemented; exercised against a real multi-GB store** |
| **Claude Code extractor** (human-prompt/tool-result split, session folds incl. recursive subagent transcripts, after-hours, compaction, tool failures, context-window peak, human-corrected edits, correction cadence, gap-split active minutes, epoch marker) | **implemented; exercised end to end against the ingest API** |
| **Codex extractor** (`~/.codex/sessions` and `archived_sessions` rollouts: `user_message` prompts, per-turn model mix, issued tool calls, tool and runtime failures, cumulative tokens, context peak against the window the rollout itself records, compaction items, long turns, gap-split active minutes, epoch marker) | **implemented; fixture-tested and run against a developer machine's rollouts** |
| **Active-time split** (hands-on vs agent-supervising, per session, per local day and per project digest; autonomy bands off the transcript's own `permissionMode`) | **implemented; exercised against a real store** |
| **Tool-call counting, all four stores** (`tool_use` items / tool-call `response_item`s / `toolFormerData` / `toolInvocationSerialized`, one `ai_tool_call_started` per call) | **implemented; exercised end to end against all four stores on a developer machine** |
| **Batch shipper** (`POST /v1/tool-events/batch`, salted hashes, stable importKey) | **implemented; exercised end to end against the ingest API** |
| **Cursor extractor** (composerHeaders + bubble aggregation via SQL-side `json_extract`, prompt text never parsed into the process, subagent-composer folding, epoch marker) | **implemented; exercised end to end against the ingest API** |
| **VS Code extractor** (Timeline-history Chat-Edit day×workspace aggregation, Copilot chatSessions folding, workspace identity via `workspace.json` longest-prefix match, epoch marker) | **implemented; exercised end to end against the ingest API** |
| `import [--ship]` end to end | **implemented; exercised end to end against all three stores, dry run and `--ship`, on a developer machine** |
| git extractor | stub — throws with a pointer |
| zsh `EXTENDED_HISTORY` apply | snippet only |

The human-prompt classifier is the load-bearing piece: the large majority of
user-role transcript lines are tool-result round-trips, not typed prompts.
Conflating the two inflates every prompt metric by roughly an order of
magnitude, so its fixtures are the ones to keep green.

Codex has the same trap in a different place. A prompt is an `event_msg` of
type `user_message`; the `response_item` copy that follows it shares
`role: "user"` with injected environment context and aborted-turn notices,
and counting those roughly doubles every prompt figure. Codex rollouts also
carry things Claude Code transcripts do not: the model's real
`model_context_window` (so the context ratio needs no assumed 200k), a
per-turn `duration_ms` (so long turns are the store's own number, bucketed
through the same function the live hooks use), and no `permission_mode` at
all — the rollout records `approval_policy` and `sandbox_policy`, which the
live Codex hooks deliberately leave unmapped, so every agent-supervising
minute on this store lands in the `unknown` band. That is a blind spot stated
as one, not a posture. On the wire Codex rides `cli_agent` with
`metadata.host: "codex"`, exactly as the live hooks do, so historical and
live rows are one population.

## Active time is two figures, never one

`activeMinutes` answers "how much of this session was not idle": every
known-line timestamp, main thread and subagents merged, gap-split at five
minutes. It has always been the honest alternative to wall clock, and it is
unchanged.

It is not, on its own, an answer to "how long did this take me". One prompt can
drive a forty-minute agent run, and forty minutes of an agent working is not
forty minutes of a person at a keyboard. So the same material is also reported
split:

| Figure | What it is |
|---|---|
| `handsOnMinutes` | The human turns: from the agent's last output to the human prompt that follows. The prompt at the end is the evidence: someone read the previous output and typed. |
| `agentSupervisingMinutes` | Every other active interval. The agent produced the lines that bound it. |

Which line *begins* a hands-on span matters more than it looks. A transcript
is not only prompts and turns: the runtime writes bookkeeping around a prompt
(a queue operation as it is dequeued, an attachment as a hook runs), and those
lines land milliseconds before the prompt line. The first version of this
split took the single span ending at the prompt, whatever line began it, and
on any store with that bookkeeping it measured the runtime's write latency
once per prompt. The handoff now stamps `handsOnBoundary` to say which rule cut
it: `human_turn` for Claude Code, whose extractor classifies its lines, and
`nearest_line` for Codex, whose bookkeeping has not been classified yet. A
handoff without the stamp was cut by `nearest_line`.

The two partition `activeMinutes` exactly and there is **no third key holding
their sum**, at session, day or project scale. Adding them reconstructs
`activeMinutes`, which already exists; a differently-named total would be the
same number wearing a claim it cannot support. On a real 400-session store the
split came out 1,074 hands-on minutes against 36,948 supervising — quoting the
combined 38,035 as time spent is off by a factor of thirty-five for the half a
person would recognise as their own.

**`agentSupervisingMinutes` does not claim anyone was watching**, and nothing
in a transcript could show that they were. It is time the agent was working
which the person did not spend typing. Rendering it as attention is a
fabrication the name invites and the data does not support; the honest gloss is
"the agent was working".

### Runs you cut short

Claude Code sessions also count the times you stopped the agent mid-turn.

| Figure | What it is |
|---|---|
| `interruptedRuns` | Runs you cut short. A run is cut short when a human interrupt marker (`[Request interrupted by user]`, or its `for tool use` variant, written when you press Escape) ends an agent turn that was still going. One per marker, per session, on every day slice as well, placed on the marker's local day the way prompts are. A marker after the turn had already ended is a stray keypress and doesn't count. Neither does one the app wrote while shutting down. |

It's a count. It isn't a rate, and nothing places it more finely than a day.

The handoff says whether it was counted. `interruptedRunsCounted: true` on the
file means every session and every day slice carries the figure, so `0` means
none. A handoff without the label wasn't counted: every file written before
this field, and every store other than Claude Code. Absent is never zero. The
schema number doesn't move, because the label is additive.

A turn is still going from the prompt, tool result or notification that starts
it until a reply with a `stop_reason` other than `tool_use`, or the stop-hook
line that closes the turn. The rule is in
[`src/interruptedRuns.ts`](./src/interruptedRuns.ts), and the desktop app's
importer counts by the same one.

A cut counts in the session you pressed Escape in, and in no other. Resuming
a session copies the history it inherits, markers included, so before this
rule every resume in a lineage reported its ancestors' interruptions as
well — a fifth of the counted total on the store this was measured against.
The same ownership rule as the minutes (`minutesBasis: owned_lines`).

### When two files both say a line is theirs

Most copies keep the session id the line was written with, which is how the
import tells a copy from the real thing. Some rewrite it to the file the copy
now sits in, keeping the line's own id and its original timestamp — so the
test that settles every other copy answers "written here" in both places, and
both sessions counted the line. Nothing on the line says which of the two
wrote it: the two records are identical apart from the fields the copy
rewrote.

Where the line sits is what settles it. A line two files claim is contested.
Inside a file, the run of contested lines at the top is the history it
inherited, and it ends at the first line that file claims and nobody else
does — from there on, what it holds it wrote. So a contested line belongs to
the file still holding it after its own history has started.

Not simply the first file the import reaches, which would be the easy rule and
the wrong one: on the store this was measured against it would hand two fifths
of these lines to the copy instead, which is the error this whole rule exists
to remove.

**What that leaves.** A lineage whose earliest file the 30-day cleanup has
already taken has no file that wrote those lines — every one still holding
them holds them in its inherited head, and nothing left on disk says which
session did the work. The line is still counted once, by the first file the
import reaches, the same answer any orphaned line gets. The total is right and
the session it lands on is a guess. That was 16.1% of contested lines here.

Sizes, on the same store: 3.7% of the lines claiming their own file were
claimed by two of them, and counting each once takes 3.9% off the summed
active minutes. **Your week doesn't move** — the union of your active time
holds to a minute, because a line counted twice was one minute counted twice.
Hands-on shifts a little more than that: a span changes sides when the lines
around it move, so the unioned hands-on figure moved by 19 minutes in 6,734.

### What counts as a prompt

`promptCount` on a Claude Code session counts the prompts you typed. Claude
Code also writes `user` lines on your behalf, and none of these count:

- a background task's notification, or another session speaking (`origin.kind`
  of `task-notification` or `peer`);
- its own bookkeeping: `isMeta`, and the summary a compaction leaves
  (`isCompactSummary`);
- a line that's empty once its wrapper elements are stripped: `system-reminder`,
  `command-name`, `command-message`, `command-args`, `local-command-stdout`,
  `local-command-stderr`, `local-command-caveat`. That's what a slash command
  and its output look like. A prompt with typed text beside a wrapper still
  counts, and so does one that merely starts with a tag's name;
- the interrupt marker, `[Request interrupted by user]` and its `for tool use`
  variant.

Each session carries `syntheticPromptLines`, the number of lines it left out.

These lines aren't you, and they aren't the agent, so they don't start or end a
hands-on span. Prompt events, after-hours prompts and quick re-prompts all
follow the same count. The desktop app's importer declines the same lines; the
test is `isTypedPromptLine` in
[`src/interruptedRuns.ts`](./src/interruptedRuns.ts).

Two more rules need the whole store, so the extractor reads every transcript
once before it folds any session ([`src/promptLedger.ts`](./src/promptLedger.ts)):

- **Each line belongs to one session.** Resuming or forking a session writes a
  new transcript that copies the history it inherited, line ids and timestamps
  included. Each copy has one owner: the transcript the line's `sessionId`
  names, or, where the purge took that file, the first in the walk's sorted
  order. The owner counts the prompt, and the owner's timeline carries the
  instant — so `activeMinutes`, the hands-on split, the day slices and
  `startedAt` describe the session you resumed rather than everything behind
  it. Two files can both name themselves on one line, which "When two files
  both say a line is theirs" above settles. A line with no id is counted
  wherever it appears; on the reference store that's `queue-operation` lines
  and nothing else.
- **A chip's prompt isn't typed.** A session launched from a `spawn_task` chip
  opens on the chip's prompt. When a line's text, wrappers stripped, matches a
  chip that some session in the store offered, it counts in
  `dispatchedPromptLines`, not `promptCount`. The agent still runs on it, so an
  interrupt during that first turn is still a cut-short run. Only hashes of
  chip prompts are kept, and only for the run. If the store's cleanup has
  already removed the session that offered the chip, there's nothing to match
  and the opener counts as typed.

The handoff stamps `promptBasis: "typed_once"`. `"typed"` means the rules above
the list, with every resumed copy counted again and chip prompts counted as
typed. A handoff without the stamp counted every `user` line that wasn't a tool
result. Prompt counts for the same week run highest under that rule and lowest
under `typed_once`. The schema number doesn't move.

Beside it, `minutesBasis: "owned_lines"` says the minutes were cut the same
way. `"every_line"` — and an absent stamp — means a transcript's whole
contents counted there, inherited history included. Gate on this before
comparing minutes across two handoffs: a store's figures drop when it changes,
and nothing else in the file says so.

### How much history a resume carries

Enough to matter, which is why the rule above covers the minutes and not only
the counts. On one real store of 984 transcripts, 151 carried inherited lines:
275,801 of them, 29% of every dated line in the store. They held the whole of
the gap between what the sessions claimed and what the clock allowed. Both
columns are the same 983 sessions, read from one snapshot:

| | Every line | Owned lines |
|---|---|---|
| Summed active minutes | 70,212 | 53,600 |
| Summed hands-on minutes | 12,238 | 8,006 |
| Union of every active interval | 25,078 | 25,077 |
| Exact-duplicate spans | 262,500 of 873,599 | 21,982 of 635,126 |
| Sessions apparently spanning over a day | 158 | 154 |

The union is the control. It holds to the minute, so no work anyone did was
dropped: what went was the copy of it. Duplicate spans fell from 30% of the
store to 3.5%, which matters to any count of how many agents were running at
once, since a duplicate reads as a second agent. 127 sessions now start when
they were resumed, 13 of them more than an hour later than they used to.

That 3.5% was not the floor, and it was not coincidence: four fifths of it was
the copy path settled above. On a later and slightly larger snapshot of the
same store, the duplicate spans go from 21,982 to 4,087 once contested lines
are settled.

An earlier reading of this exposure put it at 0.72% of sessions. It counted
repeated `sessionRef`s, and a resumed transcript carries a fresh one, so it saw
three sessions where 151 transcripts were affected.

### Autonomy bands

`permissionMode` is on the transcript's human-prompt lines and nowhere else —
across 120 real stores it appears on 6.7% of `user` lines and on no
`assistant`, `system` or `attachment` line. So posture is known at prompt
boundaries and carried forward between them, and supervising minutes are banded
by it through `autonomyBand`. Time before the first declaration lands in
`unknown` and is never folded into a neighbouring band.

The band map rides in the local handoff only (`autonomySplit`), never on the
wire: banding is a reader's vocabulary derived from the stored token at query
time, and storing the band would freeze a decision deliberately left open.

### The counters

Three diagnostics ship with the split, read by neither the backend nor the
handoff on purpose:

- `activeSplitInstants` — distinct timestamps the split ran over. Two minutes
  off four instants and off four hundred are not the same measurement.
- `activeSplitUndatedLines` — known lines whose `timestamp` would not parse.
  They still move the session's wall clock by string comparison, so only this
  says both active figures are short.
- `activeSplitUnposturedInstants` — instants reached before any
  `permissionMode` was declared. The posture blind spot as a count, not
  inferred from the `unknown` band being present.

### The defect this replaced

The per-day slices used to gap-split the **prompt timestamps** while the
session figure gap-split the **whole timeline**. The threshold was shared and
commented as keeping one definition of "active"; the material was not. Across
200 real sessions the prompts-only reading came to 2,730 minutes against
18,938 — an 85.6% under-report, concentrated exactly on the sessions where an
agent did the most work. Both now cross the call, and
`tests/activeSplit.test.mjs` pins it against a real transcript.

## What the backend enforces on a second run

Both of the blockers this section used to list — the consent scope and
idempotency — are enforced by the deployed backend, and have been since
20 Aug 2026 (verified against a real backfill on 25 Aug 2026). They stopped
gating publication then, and the package ships from the release tag like
every other CLI here. Two things stand apart from them and are decided
elsewhere: which tier the batch ship belongs to, and the consent surface that
grants the lease. Without that grant every event of a backfill is rejected
`consent_missing_or_expired` — the gate working, not a broken token.

- **Consent scope.** `historical_import` is a distinct `ToolConsentScope`,
  separate from the lease granted for live IDE telemetry, and a backfill
  requires it. Paying for a capability is not the same act as agreeing to a
  specific read of months of local history, and pairing grants neither: a
  paired tool has consent to watch you from now on, never to read backwards.
  Enforcement keys on the event's **provenance** rather than the scope string
  a client sends, so backdated events cannot ride in under live-telemetry
  consent.
- **Idempotency.** `(pairedUser, toolInstallation, importKey)` is unique, and
  `importKey` is required on any historical event. A replayed event answers
  `duplicate` and writes nothing at all (not the event, not `lastSeenAt`, not
  an audit row); the batch response counts duplicates apart from both accepted
  and rejected.

  **The dedup key is the source record ref alone — not `extractionId` + ref,
  as this list originally said.** An extraction id is minted per run, so
  including it would make every key unique and dedup nothing, which is exactly
  the case a re-run is. The source record is the stable identity, so it is the
  whole key; a re-run with a fresh `extractionId` over the same records
  therefore still dedups, and the first run's extraction stays on record.
  The backend's ingest tests pin this on its side.
- **The key survives a changing store.** `ordinal` numbers an event only
  among events sharing its whole identity — store, session, kind, instant —
  so it separates genuine same-millisecond duplicates without encoding the
  event's position in the run. Deleting a day, a session or an entire store
  between runs leaves every surviving key untouched. Pinned by
  `tests/importKeyStability.test.mjs`. (Until 20 Aug 2026 this was the
  event's index in the whole shipped array, which re-keyed unchanged records
  after a purge — the one case a re-run is for.)

Still open, and worth knowing before trusting a second run completely:

- **The 18 Aug 2026 shipment cannot be deduped against.** Production accepted
  8,720 backdated events from one machine before the `ImportKey` column
  existed, so those rows carry `NULL` and the unique index is filtered on
  `IS NOT NULL`. Nothing will ever match them. A clean re-ship needs them
  removed backend-side first, or that window lands twice — once. Runs from
  here are idempotent with each other.
- **Epoch markers** (Copilot→Cursor→Claude eras, Ascenda install) are not yet
  event types anywhere.

## Usage

```
ascenda-history-import scan            # human-readable inventory
ascenda-history-import scan --json     # what the app's consent surface renders
ascenda-history-import fix-retention   # dry-run; --apply to write
ascenda-history-import import          # Claude Code + Codex + Cursor + VS Code, dry run; --ship to send
ascenda-history-import archive         # the durable copy; --verify / --list / --restore <dir> / --prune
```

### Staging is scaffolding; `archive` is the copy

`import` snapshots each store, extracts, and **deletes the snapshot in a
`finally`** — success or failure — keeping only `events.jsonl`.
It also sweeps snapshots left by earlier runs. This is not tidiness: nineteen
runs once left 254 GB on a 926 GB disk and took free space to 279 MB, and the
first thing to notice was unrelated tooling failing with `ENOSPC`.

The comment that made it possible claimed APFS clone-on-write made a snapshot
free. Measured on macOS 15 / APFS / Node 24, it is not — `fs.copyFile` with
`COPYFILE_FICLONE` costs exactly as much as a plain copy (450 MB source,
464 MB consumed), while `/bin/cp -c` on the same file costs zero. Node's copy
path does not use reflinks here. Never assume a Node copy is cheap.

`fix-retention` is the other half, and is also **not a backup**: it stops
Claude Code trimming itself *in place* and does nothing if that store is lost.
`archive` is the durable copy:

- lives outside `staging/`, so no sweep can reach it;
- content-addressed, so re-archiving an unchanged 4 GB store costs ~0
  (measured: first generation 4.1 GB in 20 s, second 48 MB in 2.8 s);
- keeps every generation, so a transcript that grew is recoverable at both
  states;
- `--verify` re-hashes every blob, and **exits non-zero** if any is missing or
  corrupted;
- `--restore <dir>` never writes to the live store;
- `--prune --keep N` bounds it, because storage that only grows is the same
  defect wearing a different hat.

VS Code chat sessions (15 GB, which VS Code is not deleting) are skipped by
default; `--include-vscode-sessions` opts in.
