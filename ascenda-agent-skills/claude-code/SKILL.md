---
name: ascenda-work-signals
description: Report observable work-friction patterns (repeated approach churn, drift from a stated session goal, a stalled or recovered stretch of work, a declared intention or scope change) to Ascenda via the ascenda_emit_work_signal MCP tool, when it is available. Use this passively throughout a session, not on explicit request — it is a background noticing habit, not a command a user invokes.
license: MIT
---

# Ascenda Work Signals

You are noticing, not diagnosing. This skill teaches you to report **observable interaction patterns** — never a read of how the user feels, how competent they are, or what's wrong with them. Everything here is evidence for Ascenda's own baseline evaluation, and evidence for a question you ask the user directly — it is never a conclusion you assert.

## Before anything else: is the tool even there?

Check whether `ascenda_emit_work_signal` is in your available tools. If it isn't, this skill does nothing — don't mention Ascenda, don't apologize for not having it, don't suggest the user install anything unprompted. This is a quiet capability that exists when it exists.

## The six things you can report

Full trigger conditions, thresholds, and required evidence fields: **[docs/EMISSION_CRITERIA.md](../docs/EMISSION_CRITERIA.md)** — read it before your first emission in a session, since the thresholds are specific (e.g. "three or more materially different approaches," not "seems like a lot of tries"). Summary:

| Event | What it reports |
|---|---|
| `approach_churn_detected` | Three-plus different approaches to the same problem, none resolving it |
| `goal_drift_detected` | Work has moved away from a declared intention, unconfirmed |
| `scope_change_declared` | The user just confirmed a deliberate scope change |
| `session_intention_declared` | The user stated what this session is meant to accomplish |
| `progress_stalled` | An extended stretch with no verification pass, commit, or resolution |
| `progress_recovered` | A prior stall or churn period just resolved |

## Five rules, all non-negotiable

1. **Report the pattern, not a diagnosis.** Never write, think toward, or let an emission imply a sentence like "the user is frustrated/tired/struggling." If the only way to justify an emission is by guessing how someone feels, don't emit. Cross-check anything you're about to say against [`copy/banned-vocabulary.txt`](../copy/banned-vocabulary.txt) — if your reasoning uses one of those phrases, stop and rephrase around an observable fact instead.

2. **Evidence for a question, not a verdict — especially for drift.** `goal_drift_detected` exists to set up *"this looks like it's moved from X into Y — deliberate, or did it drift?"*, asked to the user, in the conversation. Emitting the event without asking the question is doing half the job; the app answering the question on the user's behalf (by inferring an answer from the emission alone) is exactly the failure mode this skill exists to prevent.

3. **Never transmit content.** The tool's schema has no field for raw text and will reject anything that isn't a bare identifier or a hash — but don't rely on the schema to catch a mistake. Never put a task description, a code snippet, a file name, or anything the user said into `evidenceCounts`/`evidenceFlags` keys or `taskFingerprint`. Counts and booleans only. If you compute a `taskFingerprint`, it must be a hash you generated locally, never the task text itself.

4. **`skillVersion` is this document's version, exactly.** Check the version line at the top of [EMISSION_CRITERIA.md](../docs/EMISSION_CRITERIA.md) and pass it verbatim as `skillVersion`. Do not invent a version, and do not reuse a cached value from a different copy of this skill — emission rate is only interpretable against a correct version stamp.

5. **You decide what happened; Ascenda decides what to do about it.** This skill's job ends at reporting. Never use an emission as license to change your own behavior toward the user (going gentler, suggesting they take a break, softening your tone) — that's Ascenda's call, made server-side against their baseline, through their own product surfaces. Stay exactly as direct and useful as you'd otherwise be.

## Calling the tool

```json
{
  "eventType": "goal_drift_detected",
  "skillVersion": "1.0.0",
  "windowMinutes": 18,
  "evidenceFlags": { "originalGoalRetained": false },
  "evidenceCounts": { "unrelatedFilesOrTasksTouched": 3 }
}
```

- `eventType` — one of the six, exactly as spelled in the table above.
- `skillVersion` — required, semver, from EMISSION_CRITERIA.md.
- `taskFingerprint` — optional, hash-shaped only, only if you already have a stable local hash for the task.
- `windowMinutes` — optional, roughly how long the pattern spans.
- `evidenceCounts` / `evidenceFlags` — optional, named integers/booleans per the per-event evidence fields in EMISSION_CRITERIA.md.

A rejected call (bad shape, missing consent, revoked pairing) means: say nothing to the user about it, don't retry in a loop, and don't let it interrupt the actual work. This is telemetry, not a task you're accountable for completing.

## What this skill is not

It doesn't decide when to interrupt the user, offer a break, or suggest a remedy — that's Ascenda's ask-slot, running against baselines this skill has no visibility into. It doesn't run on demand ("check my work signals") — there's nothing to check; it's a passive noticing habit over the course of normal work. And it never reports anything about a session that has no paired, consented Ascenda installation — silence is always the safe default.
