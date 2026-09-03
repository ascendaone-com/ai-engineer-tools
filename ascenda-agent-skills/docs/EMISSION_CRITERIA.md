# Emission Criteria — v1

The versioned trigger conditions for each of the six semantic event types. "Versioned" is load-bearing: emission depends on a model remembering to apply these criteria, and that behaviour drifts across model and skill revisions. Every emitted event carries this document's version as `skillVersion`, so a downstream change in emission rate is attributable to a version bump rather than mistaken for a change in the work itself.

**Current version: `1.0.0`.** Bump on any change to a threshold or a criterion below — not on wording-only edits to this file.

Every criterion below is written to be checked against **observable interaction facts** (attempt counts, elapsed time, what the user actually said), never against a read of the user's mood, effort, or competence. If a criterion can only be satisfied by guessing how someone feels, it is not one of these six events.

---

## `approach_churn_detected`

**Fires when:** the same underlying problem has been attempted via **three or more materially different approaches** within one continuous working stretch, and none has resolved it.

- "Materially different" means a different method, not a retry of the identical thing with a typo fixed — that's already covered by the deterministic `ai_correction_prompt`/retry-storm signals the hooks emit, and re-reporting it here would double-count.
- "Same underlying problem" is a judgement call the skill makes from the conversation, not from string-matching error messages. State the basis for the judgement to yourself before emitting; if you can't name what's the same across attempts, don't emit.
- Do **not** fire for legitimate exploration (trying three implementations to compare them, deliberately) — the tell is usually stated intent ("let me try a different approach and compare") versus escalating attempts at the same fix. When genuinely unsure, don't emit; a missed signal costs less than a wrong one.

**Evidence to attach:**
- `evidenceCounts.approachCount` — number of distinct approaches tried.
- `evidenceFlags.sameUnderlyingProblem` — `true` (the schema requires you to have already made this judgement to reach this point).
- `windowMinutes` — roughly how long the churn has spanned.

## `goal_drift_detected`

**Fires when:** a session has a declared intention (from `session_intention_declared`, or one already visible via the Flow app's `get_plans` tool as a `kind: "intention"` row — it rides the plans scope, not the work-demand one, because it is a sentence the person wrote) and the actual work has moved somewhere else **without an explicit decision to do so**.

- This is evidence for a question, never a conclusion. Before emitting, you should already be planning to ask the user something like *"this looks like it's moved from [declared intention] into [what's happening now] — deliberate, or did it drift?"* The event and the question are a pair; emitting without intending to ask is half the job.
- If the user has already said "yes, I'm deliberately switching to X" — that is `scope_change_declared`, not this. This event is specifically the *unasked* or *unconfirmed* case.
- No declared intention exists yet → this event cannot fire. There is nothing to have drifted from (dark-flow-gap-analysis §1, Layer 1: the intention is the reference point everything else needs).

**Evidence to attach:**
- `evidenceFlags.originalGoalRetained` — `false`.
- `evidenceCounts.unrelatedFilesOrTasksTouched` — a rough count, if it's meaningfully more than the declared scope implied.

## `scope_change_declared`

**Fires when:** the user explicitly confirms a deliberate scope change — in direct response to a drift question (above), or unprompted ("actually, let's also fix X while we're here, that's the real goal now").

- This is a **marker**, not a content carrier. The schema has no field for what the new scope is — that distinction (a fact occurred vs. what the fact contains) is deliberate. See "What this event is not" below.
- Emit once per confirmed change, not once per subsequent action inside the new scope.

**Evidence to attach:**
- `evidenceFlags.confirmedByUser` — always `true` for this event; if it wasn't confirmed by the user, it isn't this event.

## `session_intention_declared`

**Fires when:** the user states, at or near the start of a working session, what the session is meant to accomplish — whether you asked ("what would make this session count?") or they volunteered it.

- **Never invent the intention on the user's behalf.** If they haven't said what they're doing, don't infer one from the first file they opened and emit it as if declared.
- This is a **marker**, not a content carrier — same reasoning as `scope_change_declared`. See below.

**Evidence to attach:**
- `evidenceFlags.statedByUser` — always `true`.

### What `session_intention_declared` / `scope_change_declared` are not

Neither event transmits the actual sentence the user said. The schema has no free-text field, by design (see the tool's own docs: nothing here should ever carry raw content). These two events are **timing markers** — "a declaration happened, roughly now" — useful for aggregate frequency/timing, not for reconstructing what was said.

**The authoritative record of what the user actually intended lives in the Flow app itself**, captured through its own local ask-slot surface (macOS: the session-intention card; mobile: the equivalent capture), which the user fills in directly — never relayed through this pipe. If you elicit an intention in conversation, the honest move is to invite the user to also confirm it in the Flow app if it's open, not to treat your emission of this marker as having recorded it anywhere durable.

## `progress_stalled`

**Fires when:** roughly **20 minutes or more** have passed with continued iteration (prompts, edits, tool calls) but no verification pass, commit, or resolved sub-problem — i.e., visible motion without a checkpoint.

- The 20-minute figure is a starting threshold, not a hard rule to apply mechanically without judgement — a genuinely hard problem worked carefully is not this event. The distinguishing signal is usually rising correction/retry density alongside the elapsed time, not elapsed time alone.
- Don't fire more than once per stall — a second emission for the same still-ongoing stall before it resolves or you emit `progress_recovered` is noise, not a stronger signal.

**Evidence to attach:**
- `windowMinutes` — how long since the last checkpoint.
- `evidenceCounts.attemptsSinceLastCheckpoint`, if you have a usable count.

## `progress_recovered`

**Fires when:** following a stall or churn period, a clear resolution occurs — tests pass, the build goes green, the user confirms the problem is solved.

- This is the good-news counterpart, and it matters as much as the other five: a signal stream that only ever reports friction is not honest about the work (dark-flow-gap-analysis's "honest failure" principle, applied in reverse — wins need to render too). If you emitted `progress_stalled` or `approach_churn_detected` earlier in a stretch that then resolved, emit this to close the loop.
- Don't fire for ordinary progress that was never stalled — this event specifically closes a prior friction signal, it isn't a general "things are going well" ping.

**Evidence to attach:**
- `evidenceCounts.minutesToResolve`, if a prior stall/churn window is known.

## Rework signals, and the one we deliberately do not collect

Two of the report's rework signals now travel deterministically, on the
existing `ai_tool_call_completed` event rather than a new type:

| Signal | How | Where it lands |
|---|---|---|
| Reversions | `gitAction: revert \| reset_hard \| restore`, plus `activity: "rework_reversion"` | the rework half of velocity–quality |
| Boundaries | `gitAction: commit \| push` | work boundaries, `commits_per_day` |

`amend` is recorded and is neither: it rewrites a commit that already counted,
so treating it as a boundary would count the same work twice, and treating it
as a reversion would call ordinary history tidying lost work.

### Same-file re-edit churn: not collected, and not for want of trying

Churn — the same file edited over and over inside one session — is the other
rework signal the report names, and it is **not collected on purpose**.

No file identity travels today. `ai_file_write` and `ai_file_edit` carry a
lines-changed bucket and nothing that says *which* file, so churn cannot be
computed here, in the hooks, or server-side from the event stream. It is not a
missing calculation; the input does not exist anywhere.

Making it computable would mean introducing a per-file identifier — a salted
fingerprint, following `taskFingerprint`'s precedent. That is pseudonymous
rather than anonymous: a stable per-file token is exactly what makes "this same
file again" answerable, which is the point, and also what makes it a new
consent question rather than a new field. **It is a governance decision, not an
implementation one**, and it should go through the consent-class process the
same way `semantic_work_signals` did before any code emits it.

Until then the velocity–quality divergence stays declared-unavailable, with
reversions as the only rework input it has.
