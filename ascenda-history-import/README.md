# @ascenda-one/history-import

Retrospective AI-usage import: extracts the baseline that already exists on
an engineer's machine — Claude Code transcripts, Cursor's conversation store,
VS Code local history and Copilot sessions, git — and ships it as
provenance-classed historical events on the existing telemetry wire.

The research behind this package (what is actually in each store, verified on
a real machine 2026-08-18) lives in the Flow workspace:
`asc-ascenda-app-workspace/docs/HISTORICAL_TELEMETRY_IMPORT.md`. Read it
before touching an extractor — the store formats are reverse-engineered and
every design rule here traces to a finding there.

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
   per bubble (one observed machine holds 17,727 bubbles).
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
| `import [--ship]` end to end | **dry run 2026-08-18: Claude Code 9,198 events (333 sessions, 8,401 human prompts, 135 after-hours sessions, 261 sessions with ≥1 tool failure) + Cursor 661 events (104 sessions, 550 human prompts, 6 after-hours sessions) + VS Code 7,338 events (548 edit-days summing to the full 13,780 verified Chat Edits — monthly rollup reproduces the documented May-2026 cliff: Apr 2,079 → May 343 → Jun 1,047 with no manual tuning; 419 Copilot sessions, 6,131 human prompts, 114 after-hours sessions, 125 sessions with ≥1 request error; 2 Timeline-history files unparsed) — 17,197 total across all three stores. Last `--ship` run: 8,720/8,720 accepted by the backend, 2026-08-18, before this extractor's friction-signal, Cursor and VS Code additions.** |
| git extractor | stub — throws with a pointer |
| zsh `EXTENDED_HISTORY` apply | snippet only |

The human-prompt classifier is the load-bearing piece: on the verified store,
108,528 user-role lines reduce to 8,272 actual typed prompts — the other 92%
are tool-result round-trips that would have inflated every prompt metric ~13x.

## Gaps that block a real user running this twice

Both blockers are **implemented but unmerged** — asc-core-be branch
`claude/historical-import-dedup-and-consent`, not `origin/main` (verified
19 Aug 2026). Neither is enforced by the backend a published client would
actually reach. What they become **once that branch merges**:

- **Consent scope — specified, not yet enforced.** `historical_import` is a
  real `ToolConsentScope` here, and on that branch it is backed by
  `ConsentType.HistoricalImport` (507) with ingestion enforcing it.

  On `origin/main` today none of that exists: `ResolveConsentType` does not
  recognise the scope and falls to its default arm, `AiDataProcessing` — the
  lease already granted for live IDE telemetry. A backfill would ride in on
  live-telemetry consent, which is exactly what the separate scope exists to
  stop. **This gates publishing the package**, independently of any tier or
  entitlement decision: paying for a capability is not the same act as
  agreeing to a specific read of nine months of local history.

  How it behaves once merged: Enforcement keys on the event's **provenance**, not
  on the scope string it sends: any of the three `historical_*` classes
  requires an active historical-import lease, so a client that keeps claiming
  `ide_telemetry` over backdated events is rejected rather than waved through
  to the default consent type. Nothing grants the lease at pairing — a paired
  tool has consent to watch you from now on, never to read backwards.
- **Idempotency — closed.** `(pairedUser, toolInstallation, importKey)` is
  unique in the database, checked before insert and enforced by a partial
  unique index for the concurrent case. A replayed event answers `duplicate`,
  writes nothing at all (not the event, not `lastSeenAt`, not an audit row),
  and the batch response counts duplicates apart from both accepted and
  rejected. `importKey` is **required** on any historical event. (Same caveat:
  this is the branch's behaviour, not main's.)

  **The dedup key is the source record ref alone — not `extractionId` + ref,
  as this list originally said.** An extraction id is minted per run, so
  including it would make every key unique and dedup nothing, which is exactly
  the case a re-run is. The source record is the stable identity, so it is the
  whole key; a re-run with a fresh `extractionId` over the same records
  therefore still dedups, and the first run's extraction stays on record.
  Pinned by `HistoricalImportIngestTests` in asc-core-be.
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
ascenda-history-import import          # Claude Code + Cursor + VS Code, dry run; --ship to send
```
