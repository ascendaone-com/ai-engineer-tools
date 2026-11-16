# Usage Limit Readings Plan

Recent Codex builds write the provider's own usage-limit readings into every
rollout. We read none of them. This plan ships them from the history import,
then checks whether the live Codex hooks can see them too. Line numbers are
against `main` at `badbcf6`.

**Changed after this plan was built: the readings stay on the machine.** They
say how much of an allowance was left on an account with the provider, which
is about the account and not about the work. So the import folds them into
the local handoff and sends none of them, and the live Codex hooks no longer
read them at all. Where a step below says "ship", read "write to the
handoff". Step 3's finding stands as a record of what the hook payloads
carry; the `Stop` reader it describes was removed. The keys are registered
`family: "local"` and `readBy: ["handoff"]`, and `ship.ts` leaves a `local`
key out of the wire payload.

Status: steps 1 and 2 built and kept local, step 3 built then removed, step
4 deliberately not. Touches `codex.ts`, so
it lands after `docs/CODEX_TOKEN_ACCOUNTING_PLAN.md`. Line numbers below are
the original plan's; the fold now lives in `usageLimitFold.ts`.

## What the rollouts carry

On a developer machine in November 2026, 1,881 `event_msg/token_count` lines
across 8 rollouts carried a `rate_limits` object beside `info`. Its shape,
with the values replaced:

```json
"rate_limits": {
  "limit_id": "…", "limit_name": null, "plan_type": "…",
  "primary":   { "used_percent": <float>, "window_minutes": 300,   "resets_at": <epoch s> },
  "secondary": { "used_percent": <float>, "window_minutes": 10080, "resets_at": <epoch s> },
  "credits": { "has_credits": false, "unlimited": false, "balance": "…" },
  "individual_limit": null, "spend_control_reached": null,
  "rate_limit_reached_type": null
}
```

`primary` is the five-hour window and `secondary` the weekly one on every
line seen. `resets_at` is epoch seconds. `rate_limit_reached_type` was null
on all of them. By its name it marks a limit that was hit; confirm that on
a session that hits one before relying on it.

Checked again on 16 Nov across all 60 rollouts (52 compressed): 4,109
readings, `rate_limit_reached_type` null on every one, including two whose
short window read `used_percent: 100.0`. So a full window doesn't set it, or
doesn't set it on a `token_count` line. Until a non-null value is seen,
`usageLimitReached: false` beside a peak of 100 is expected, and the peak is
the better sign that a limit bit.

These are the provider's figures, written by the agent itself, so reading
them needs no credential and no network call. Compare Claude Code, where the
reset time exists only in prose and `usageLimitReset.ts` parses it out of the
message.

## Step 1: fold the readings per session

In `foldLinesInto` (`codex.ts:608` onward), in the `token_count` case
(`codex.ts:720-740`), read `payload.rate_limits` on main-thread lines only
(`if (sub) break` already guards the context figures there).

Keep per session:

- `usageLimitShortPeakPct`: the largest `primary.used_percent` seen, rounded
  to a whole number.
- `usageLimitLongPeakPct`: the same for `secondary`.
- `usageLimitShortWindowMinutes`, `usageLimitLongWindowMinutes`: the window
  sizes as reported. Don't assume 300 and 10080; take them from the line.
- `usageLimitReached`: `true` if any line had a non-null
  `rate_limit_reached_type`, and `usageLimitReachedType` with its value
  passed through a fixed allow-list (start with the values seen; anything
  else becomes `"other"`).
- `usageLimitFirstReachedAt`: ISO timestamp of the first such line.

Don't ship `limit_id`, `limit_name`, `plan_type`, `credits.balance` or
`individual_limit`. They identify the account or its plan, and the figures
above don't need them.

A session with no `rate_limits` line ships none of these keys. Absent means
the build didn't write them, not that the user had headroom.

Register every key in `packages/tool-contract/src/metricKeys.ts` with
`readBy: ["backend"]` and a unit (`percent`, `minutes`, `boolean`).

## Step 2: per-day readings

Peak per session hides which day a limit bit. Add the same two peak figures
to each day slice that `sliceSessionByLocalDay` produces (`daySlice.ts`), so
a session crossing midnight reports each day's own peak.

## Step 3: live Codex hooks

`ascenda-codex-hooks` maps hook payloads in `mapCodexEvent.ts` and never sees
the rollout. Check on a real install whether any Codex hook payload carries
`rate_limits` or a rollout path:

1. Add a temporary, uncommitted dump of each raw hook payload's key tree
   (keys only, no values) to a temp file in `cli.ts`, install the hooks from
   that build, and run a short Codex session.
2. Record which events carry which top-level keys. Remove the dump.

If a payload carries `rate_limits`, map the two peaks onto `ai_turn_completed`
the same way. If it carries a rollout path, read the last `token_count` line
from the tail of that file at `Stop` and do the same. If neither, stop here
and note it in this doc; the history import covers it a day late.

### Finding (16 Nov 2026, Codex CLI 0.169.0-alpha)

Checked with a throwaway `CODEX_HOME` whose `hooks.json` pointed every event
at a keys-only dump, and one short `codex exec` session that ran one shell
command. The installed hooks weren't touched, so nothing in the repo changed
for the probe.

| Event | Top-level keys |
|---|---|
| `SessionStart` | `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `source`, `transcript_path` |
| `UserPromptSubmit` | the same minus `source`, plus `prompt`, `turn_id` |
| `PreToolUse` | `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`, `turn_id` |
| `PostToolUse` | as `PreToolUse`, plus `tool_response` |
| `Stop` | `cwd`, `hook_event_name`, `last_assistant_message`, `model`, `permission_mode`, `session_id`, `stop_hook_active`, `transcript_path`, `turn_id` |

No payload carries `rate_limits`. Every one carries `transcript_path`, and it
is the session's rollout (`sessions/YYYY/MM/DD/rollout-*.jsonl`). A second
run recorded only booleans about that file at each hook: before `Stop` it
held no `rate_limits` line; at `Stop` it held two, and its last line was the
turn's closing `token_count` with a reading.

So the rollout path is the live source. `Stop` now reads the last 64 KB of
`transcript_path` (`ascenda-codex-hooks/src/usageLimitReading.ts`) and puts
`usageLimitShortPeakPct` and `usageLimitLongPeakPct` on `ai_turn_completed`.
On a turn they're the reading at the turn's end, which is the turn's peak
unless a window reset mid-turn. The Codex adapter's disclosure now names the
`context` family, whose sentence says usage limits.

## Step 4: feed the usage-limit hold

The live bus already has `resumesAt` for a halted turn
(`packages/tool-kit/src/liveBus.ts:218-225`), filled today from Claude Code
prose. Where step 3 finds a live `resets_at` and a non-null
`rate_limit_reached_type`, fill `resumesAt` from it for Codex, under the same
six-hour cap (`usageLimitReset.ts`, `MAX_RESUME_AHEAD_MS`).

### Not built

`resumesAt` means the agent will carry on by itself when the limit lifts
(`LiveBusSignal.resumesAt`: "only when the agent is set to continue at the
reset"). Claude Code has `autoContinueAtUsageLimit` for that. Codex has no
such setting, so a reset time on a Codex halt would hold a Mac awake for a
turn that never resumes. The probe session also hit no limit, so which hook
fires on a hit, and what `rate_limit_reached_type` says, is still unseen.
Revisit if Codex adds a resume-at-reset mode.

## Tests

- `tests/codex.test.mjs`: a rollout with three `rate_limits` lines at 10%,
  40% and 25% ships `usageLimitShortPeakPct: 40`. A line with
  `rate_limit_reached_type: "primary"` sets `usageLimitReached: true` and the
  first-reached timestamp. A rollout with none ships no `usageLimit*` keys.
- A subagent thread's `rate_limits` line doesn't move the peak.
- An unknown `rate_limit_reached_type` value ships as `"other"`.
- `tests/metricVocabulary.test.mjs` passes with the new keys registered.

## Done when

- `npm run verify` passes.
- A local `ascenda-history-import import` (no `--ship`) on a store with recent
  rollouts shows the peaks.
- Step 3's finding is written into this doc either way.
- The release notes for the tag that ships this name it. `CHANGELOG.md` has
  no unreleased heading (its newest section must name a tag), so the line is
  written then.
