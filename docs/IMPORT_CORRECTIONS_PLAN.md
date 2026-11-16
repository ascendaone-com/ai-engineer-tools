# Import Corrections Plan

When an extractor fix changes a session's figures, the fix reaches new
sessions only. Every session already imported keeps the old figures, because
the corrected row arrives under the same `importKey` and the backend drops it
as a duplicate. This plan adds an extractor revision so a corrected row
replaces the one it corrects. Line numbers are against `main` at `badbcf6`
here and `a6665fb3` in the backend (`Ascenda-One-Pty-Ltd/asc-core-be`).

Status: not started. Blocks the shipped-figure fixes in
`docs/CODEX_TOKEN_ACCOUNTING_PLAN.md` and `docs/CLAUDE_TRANSCRIPT_REPLAY_PLAN.md`.

## Why it's needed

`importKeyOf` (`ship.ts:115-123`) hashes
`store|sessionRef|eventKind|occurredAt|ordinal`. None of those change when an
extractor learns to count better, which is the point: a re-run must not
duplicate a store. But the backend's batch ingest treats any known key as a
replay (`Services/ToolPairingService.cs:1551-1566`), answers `duplicate`
with reason `already_imported`, and writes nothing. So:

- A `create_focus_session` whose `toolCallCount` was 1,139 and is now 611
  stays at 1,139 on the backend forever.
- A per-call `ai_tool_call_started` that the fix stops emitting (a repeated
  line) stays stored, because nothing tells the backend it's gone.

`collectorVersion` already rides every row (`ship.ts:181-186`), but it's a
build number, not a statement about what changed, and the macOS app ships the
same keys from its own Dart extractor with its own version numbers.

## Design

**A revision per store, owned by the extractor.** A new module
`ascenda-history-import/src/extractorRevisions.ts`:

```ts
/** Bumped when a store's extractor changes a figure it already shipped. Not
 * for a new metric: an added key doesn't make an old row wrong. */
export const EXTRACTOR_REVISION = {
  claude_code: 1,
  codex: 1,
  copilot_cli: 1,
  cursor: 1,
  vscode: 1,
  git: 1
} as const satisfies Record<HistoryStore, number>;
```

Rows already stored carry no revision and read as 0.

**The ladder is shared with the app.** The app's Dart extractor ships the same
`importKey` for the same record (see the header of `ship.ts`, lines 24-29).
Both writers must agree on what revision N of a store means, the way they
share the handoff schema ladder (`localHandoff.ts:60-100`): a writer may claim
only a rung whose fix it actually carries. Record each bump, with the fix it
stands for, in a table in this module's doc comment and in the app's copy.

**On the wire:** `toWirePayload` adds `extractorRevision:
EXTRACTOR_REVISION[event.store]` to `metadata` beside `importSchema`
(`ship.ts:179-186`). Register `extractorRevision` in
`packages/tool-contract/src/metricKeys.ts` with `readBy: ["backend"]`.

## Backend change

In `ToolPairingService` batch ingest (`Services/ToolPairingService.cs`
around 1500-1570):

1. Load the stored revision with the existing key lookup: where it builds
   `alreadyImported` from `ImportKey`, select `(ImportKey,
   ExtractorRevision)` pairs instead. Add a nullable `int ExtractorRevision`
   column to `ToolTelemetryEvents` with a migration; null reads as 0.
2. When an incoming event's key is known and its `extractorRevision` is
   higher than the stored one, update the stored row's metadata, revision and
   received-at in place, and report a new status, `revised`. Same or lower
   revision stays `duplicate`, as today.
3. **Supersede rows the fix stopped emitting.** After a batch, for each
   `(store, sessionRef)` that had any `revised` or `accepted` row at revision
   R, mark stored rows for that session with a revision below R and a key
   not seen in this run as superseded (a `SupersededAt` timestamp; never a
   delete, so the history stays auditable). Readers exclude superseded rows.
   The importer sends every event of a session in the same run, so "not seen
   in this run" is well defined per session. Pass the run's `extractionId`
   so the check is scoped to it, and do the sweep when the importer says
   the run is complete (step 4), not per batch, because one session can span
   two batches.
4. A closing call, `POST /v1/tool-events/import-complete {extractionId}`,
   that the importer sends after its last batch. The sweep in step 3 runs
   there. A run that dies before sending it supersedes nothing, so a crash
   can never lose rows.

Live rows (no `importKey`) are untouched by all of this.

## Collector changes

- `ship.ts`: add `extractorRevision` to the wire payload; count `revised` in
  `perStore` beside `duplicate` (`ship.ts:300-360`); send `import-complete`
  after the last batch only when every batch got a response.
- `cli.ts` output: report "N revised" next to accepted and duplicate.
- Bump a store's revision in the same PR as any fix that changes a figure it
  already ships. Add a guard test, `tests/extractorRevision.test.mjs`: run
  each extractor over its existing fixtures, hash the normalized output, and
  compare against a recorded `{store: {revision, outputHash}}` file. A
  changed hash with an unchanged revision fails with a message saying to
  bump the revision or, for an additive metric, re-record the hash only.

## Order of work

This adds a wire field and a status, so follow the merge order for new event
types: collector PR here, then the backend PR straight after, then tag.

1. Backend: column, migration, `revised` status, `import-complete` endpoint.
   Behind a setting, off until step 2 ships.
2. Collector: `extractorRevision` on the wire, `revised` in reporting,
   `import-complete` call, output-hash guard. Every store at revision 1.
3. Turn the backend setting on.
4. The fixes in the Codex and Claude plans bump their stores to 2.
5. App: send `extractorRevision` from the Dart extractor at the same rungs.

## Tests

- `tests/importKeyStability.test.mjs`: the key is unchanged by the revision
  (the revision is metadata, not preimage).
- `tests/shipReporting.test.mjs`: a batch response with `revised` items is
  counted and printed.
- New: `import-complete` is sent after a clean run and not after a run whose
  last batch failed.
- Backend: same key and higher revision updates in place and reports
  `revised`; same revision reports `duplicate`; `import-complete` supersedes
  an unseen lower-revision row of the same session and nothing in another
  session; a run without `import-complete` supersedes nothing.

## Done when

- A re-run after a revision bump reports the session as `revised`, the
  backend row shows the new figures, and the removed per-call rows are
  superseded.
- A re-run with no bump reports everything `duplicate`, as today.
- `npm run verify` passes, and the backend tests pass.
