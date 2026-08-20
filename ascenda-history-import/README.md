# @ascenda-one/history-import

Retrospective AI-usage import: extracts the baseline that already exists on
an engineer's machine — Claude Code transcripts, Cursor's conversation store,
VS Code local history and Copilot sessions, git — and ships it as
provenance-classed historical events on the existing telemetry wire.

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
   deleting a day of baseline per day. Then Cursor, then VS Code, then git.
2. **Copy, then parse.** Extraction only ever reads a staged snapshot
   (`src/staging.ts`), never live files. SQLite snapshots carry their `-wal`.
3. **Sniff per record, dispatch on the self-labelled version** (`version` on
   Claude lines, `_v` on Cursor records, `version: 1` in VS Code entries).
   Unknown shapes become `historical_unparsed` — raw retained in staging,
   nothing inferred. Fixture tests per known (tool, version) pair.
4. **Metrics only by default.** Prompt/response text, thinking blocks and
   file contents never leave the machine. Content-level ingestion, if it ever
   ships, is a separate explicit opt-in — not this package's default path.
5. **Aggregate before shipping.** Per-session / per-day events, not one event
   per bubble — a single machine's stores hold tens of thousands of them.
6. **Provenance is data.** Every event carries `historical_direct`,
   `historical_derived` or `historical_unparsed` — never the live
   `ai_work_telemetry` provenance — so no chart can pass history off as
   live observation.

## Status (2026-08-18)

| Piece | State |
|---|---|
| `scan` (per-store inventory, content never opened) | implemented |
| `fix-retention` (Claude `cleanupPeriodDays`, merge-not-clobber) | implemented |
| Staging/snapshot (copy-then-parse, WAL-aware, APFS clone-on-write) | implemented |
| **Claude Code extractor** (human-prompt/tool-result split, session folds incl. recursive subagent transcripts, after-hours, compaction, tool failures, context-window peak, human-corrected edits, correction cadence, gap-split active minutes, epoch marker) | **implemented, verified live** |
| **Batch shipper** (`POST /v1/tool-events/batch`, salted hashes, stable importKey) | **implemented, verified live** |
| **Cursor extractor** (composerHeaders + bubble aggregation via SQL-side `json_extract`, prompt text never parsed into the process, subagent-composer folding, epoch marker) | **implemented, verified live** |
| **VS Code extractor** (Timeline-history Chat-Edit day×workspace aggregation, Copilot chatSessions folding, workspace identity via `workspace.json` longest-prefix match, epoch marker) | **implemented, verified live** |
| `import [--ship]` end to end | **implemented; exercised end to end against all three stores, dry run and `--ship`, on a developer machine** |
| git extractor | stub — throws with a pointer |
| zsh `EXTENDED_HISTORY` apply | snippet only |

The human-prompt classifier is the load-bearing piece: the large majority of
user-role transcript lines are tool-result round-trips, not typed prompts.
Conflating the two inflates every prompt metric by roughly an order of
magnitude, so its fixtures are the ones to keep green.

## Gaps that block a real user running this twice

Both blockers are enforced server-side, and both are **still landing**. Until
they are live in the deployed backend, this package stays unpublished — a
client anyone could install must not be able to backfill history against a
backend that has not yet gated it.

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
  Pinned by the backend's historical-import ingest tests.

Still open, and worth knowing before trusting a second run completely:

- **`importKey` includes a global `ordinal`.** It is the event's index in the
  whole shipped array, so a later run over a *shrunken* store — Claude Code's
  30-day purge having eaten the oldest days — shifts every subsequent ordinal
  and re-keys records that have not changed. Those re-key as new events and
  land twice. Same-store re-runs are safe; re-running after a purge is not
  fully. The fix is a per-`(store, sessionRef)` ordinal in `importKeyOf`,
  here, not in the backend.
- **Epoch markers** (Copilot→Cursor→Claude eras, Ascenda install) are not yet
  event types anywhere.

## Usage

```
ascenda-history-import scan            # human-readable inventory
ascenda-history-import scan --json     # what the app's consent surface renders
ascenda-history-import fix-retention   # dry-run; --apply to write
ascenda-history-import import          # Claude Code + Cursor + VS Code, dry run; --ship to send
```
