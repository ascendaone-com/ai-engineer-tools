# The collector send journal — and what the 17 Aug incident actually was

Response to a handoff document reporting silent telemetry drops.
The ask in that document was sound and is implemented here. Its diagnosis was
wrong in two load-bearing ways, and both are worth recording, because acting on
either would have produced a fix that changed nothing.

## What the handoff got wrong

**1. The classification was never discarded.** `cli.ts` already branched on
`auth_failed` / `consent_missing` and wrote a specific line to stderr. Both
published builds in the npx cache at the time (`0.1.5`, `0.1.8`) contained that
string, and forcing a 401 against a local stub printed it reliably, to a pipe
and to a file alike. The transport even retried once through
`/v1/tool-events/renew-token` first.

The real mechanism was the last line of the file: `.finally(() =>
process.exit(0))`. **Claude Code discards a hook's stderr when it exits 0.** The
message was written every time and read by nobody. Ask #2 of the handoff — make
a rejected token "at least as visible" as a missing one — could not have been
satisfied through stderr at all; that channel does not exist on this path.

The repro offered in §2 was also not one. `npx … Stop </dev/null` supplies an
empty payload, so no event is mapped and no send is attempted. The silence
proved nothing.

**2. The token was never rejected.** Posting to prod `/v1/tool-events` with the
stored 7 Aug token returned `200 {"status":"accepted"}`. Replaying the hook's
own captured payloads — `ai_file_edit` and `editor_verification_activity` under
scope `ide_telemetry` — returned 200 as well. The token-rotation hypothesis has
no support, and a fix aimed at rotation would have been aimed at nothing.

The handoff's *inference method* was fine, though, and worth keeping: the
backend sets `LastSeenAt` only on the accepted path of `IngestToolEventAsync`,
so a stale `lastSeenAt` really does mean no event landed.

## What was actually broken

| Defect | Consequence |
| --- | --- |
| No outcome was recorded anywhere, success or failure | Nothing on the machine could distinguish "sent hundreds of events" from "never ran". This is the whole bug. |
| `parseIngestResponse` **threw** for any status outside `{2xx, 401, 403-consent, 400, 422}` | A 429, 500 or a proxy's 502 unwound to the top-level catch, wrote to the discarded stderr, and dropped the event with no retry and no trace. Far likelier to produce a multi-hour gap than rotation. |
| No timeout was configured on the send | `timeoutMs` was optional and unset, so a hung connection stalled the hook until the host killed it — again losing the event silently. Now capped at 5s. |
| `readJsonFromStdin` ran before argv was validated | Any unrecognised argument blocked forever on a pipe that would never carry a payload. `--version` was measured at over three minutes. A `doctor` subcommand added naively would have inherited this. |
| `process.exit(0)` did not wait for `process.stdout.write` | The un-awaited context injection could be truncated intermittently, with no error anywhere. |

The root cause of the specific 21-hour gap remains unestablished, and cannot be
recovered retrospectively — the evidence was never written down. That is the
point. The server-side rejection ledger (`ToolConnectionAudits`, readable via
`GET /v1/tool-telemetry/metrics`) is the one place that may still hold it, and
was never consulted.

## The rule

> **An operation that can fail silently must record every outcome, including
> success.** Absence of a log is then evidence of absence, which is the only
> thing that makes it debuggable at all.

Recording only failures reproduces the original bug in a new costume: an absent
file would mean both "healthy" and "never ran".

## Where it lives

`packages/tool-kit/src/stateStore.ts`, written from
`AscendaEventSender.post()` — the single choke point every adapter's events
pass through. Claude Code, Codex, the GitHub collector and the MCP server
therefore all journal without each having to remember to. That placement is the
correction to the shape of the incident: the same defect appeared in three
separate components precisely because each was left to notice its own failures.

- Journal: `~/.ascenda/state/<toolInstallationId>.json`, atomic write (hooks run
  concurrently; a half-written journal reads back as no journal).
- `transport_error` is a returned outcome, not an exception, and retries once.
- `npx @ascenda-one/claude-code-hooks doctor` reports id, token age, journal and
  a live round trip.
- One notice per outage reaches the user through `additionalContext`, the only
  channel that survives an exit-0 hook.

Verified end to end against prod on 17 Aug 2026, following §6 of the handoff:
success journalled, a simulated 401 journalled with status and error code,
`doctor` reporting it, the notice appearing exactly once, and recovery clearing
the episode.
