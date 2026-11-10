# Proposal: record the effort setting beside the model

Status: the collector half is implemented (steps 1 to 8 below). The backend
reader, the app port and the parity probe's compare lines are still to come.
Where the code settled something differently:

- The class has an `xhigh` bucket. Claude Code writes `xhigh` in real
  transcripts, so `low` / `medium` / `high` / `xhigh` / `max` / `unknown`.
  Codex's `minimal` and `none` read as `low`.
- `effortChanges` rides beside `metrics`, not in it, because `metrics` is flat.
  It reaches the app through the handoff and stays off the wire. The first
  entry is the opening level.
- Codex hook payloads don't carry effort (checked against the captured sample,
  not a live run), so live Codex sends nothing. Its session files do, and the
  importer reads them.
- Open questions 1, 2 and 4 went the way they leaned: the `model` family, fast
  mode and thinking later, missing means unknown. Question 3: both the raw
  string and the class ship now.

## The question

Is it worth moving Opus from `medium` to `high` for some kinds of work? We
can't answer that today. The collectors record which model ran, but not how
hard it was asked to think.

## What exists

- **Live Claude Code hooks** send `modelId` and `modelClass` on `SessionStart`
  (`ascenda-claude-code-hooks/src/mapClaudeEvent.ts`). Both belong to the
  `model` disclosure family.
- **The history importer** folds a session-level `primaryModel` out of Claude
  Code, Codex, Cursor and VS Code stores.
- **Effort is on the wire and dropped.** Claude Code puts
  `"effort": {"level": "high"}` on every hook payload (see
  `ascenda-claude-code-hooks/examples/`). Claude Code transcript lines carry a
  top-level `"effort": "high"`. Codex writes `effort` on each `turn_context`
  line. No mapper or extractor reads any of them.

## What to record

One new field pair, same shape as the model pair:

| Field | Meaning |
| --- | --- |
| `effortLevel` | The raw string the agent reported (`low`, `medium`, `high`, and whatever ships next). |
| `effortClass` | A small normalised bucket, `low` / `medium` / `high` / `max` / `unknown`. |

The raw string is the record; the class is a reading. The classifier follows
`modelClassifier.ts`: total for any input, `undefined` only when nothing was
reported, and a new level we haven't mapped lands in `unknown` rather than
being dropped.

Both fields join the `model` disclosure family, so existing consent covers
them and `SENDS` in `setup.ts` doesn't grow a new entry. Whether effort needs
its own family is the first open question below.

### Live: when to send it

Effort can change mid-session, and it arrives on every event. Sending it on
every tool call would be noise. The mapper sends it on `SessionStart`, and
again on any later event where the level differs from the last one sent for
that session. The last-sent level lives in the existing hook state store.

### Importer: per session, plus a timeline

- `primaryEffort`: the dominant level across the session, chosen the way
  `topModel` chooses `primaryModel`.
- `effortChanges`: the ordered list of `{ at, level }` switches, so a session
  that started on `medium` and moved to `high` isn't flattened to one value.

Codex is the straightforward case. Claude Code needs a pass over real
transcripts first, because older versions may not write the field.

## What this does not do

It doesn't compare outcomes. Whether `high` earns its cost for a kind of work
is a question about verification passing, rework and active minutes, and that
lives in the backend and the app. The collector's job is to make the field
trustworthy and present.

## Open questions

1. **Own disclosure family or `model`?** Effort is a model setting, so `model`
   is the natural home. A separate family would let someone share model choice
   but not effort. Leaning `model`.
2. **Fast mode and extended thinking.** Same kind of setting. Capture them in
   this change or the next? Leaning next, once we've seen where they appear.
3. **Class vocabulary.** Do we pin the bucket names now or ship the raw string
   alone first and add the class once the backend has seen real values?
4. **Backfill.** Importer rows for old sessions will carry effort only where
   the transcript did. Backend needs to treat missing as unknown, not `medium`.

## Flow to make the change

Order follows the new-event-type rule: collector first, backend second, tag
last.

1. **Contract** (`packages/tool-contract`). Add `effortLevel` and `effortClass`
   to `AscendaEventMetadata`, to the field-to-family map beside `modelClass`,
   and to the list that includes `modelClass` near the end of the file.
   Add an `EffortClass` type.
2. **Classifier** (`packages/tool-kit`). Add `effortClassifier.ts` modelled on
   `modelClassifier.ts`, export it, and unit test it: the known levels, case
   and whitespace, an unmapped string, empty, absent.
3. **Claude Code hooks.** Read `effort.level` from the payload in
   `mapClaudeEvent.ts`. Send on `SessionStart` and on change. Both keys or
   neither, as with the model pair. Add fixtures from the existing
   `examples/` payloads, plus one where the level changes mid-session.
4. **Codex hooks.** Check whether its live payloads carry effort. If they do,
   mirror step 3; if not, say so in `CODEX_MAPPING.md`.
5. **Importer.** Fold `primaryEffort` and `effortChanges` in
   `extractors/claudeCode.ts` and `extractors/codex.ts`, carry them through
   `localHandoff.ts`, and cover them in the extractor tests. Cursor and VS Code
   stay as they are until their stores show an effort field.
6. **Parity probe.** Run it, including the sorted-key-list compare, since the
   new keys are collector-only until the app follows.
7. **Docs.** Update the mapping docs and the disclosure text so the list of
   what gets sent matches what the mapper writes.
8. **Release notes.** Draft the `CHANGELOG.md` section and run
   `node scripts/release-notes-voice.mjs` against it.
9. **Merge order.** Collector PR, then the backend PR (it accepts the new
   keys), then the app port, then the tag. One PR per repo, branched from the
   right integration branch for each.

## Verification

- Unit: classifier table, mapper fixtures, extractor fixtures.
- Live: run a real Claude Code session, switch effort with `/effort` partway,
  and confirm the events show exactly two effort values.
- Import: run the importer over a local store and spot-check a session known
  to have switched.
