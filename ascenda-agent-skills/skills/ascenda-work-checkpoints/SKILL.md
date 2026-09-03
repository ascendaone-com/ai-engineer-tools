---
name: ascenda-work-checkpoints
description: Read the Ascenda Flow app's local work-demand context for the project you are working in, and — when that project has had a long day with nothing committed and no verification run recorded — offer a green run and a commit as a checkpoint before starting the next task. Use this at the boundaries the work itself produces, not on a timer, and only when the local tool is available.
license: Apache-2.0
---

# Ascenda Work Checkpoints

A long stretch with no checkpoint is a fact about the work: it means there is
no point you could return to, and no evidence that what exists now runs. This
skill teaches you to notice that from the record the person's own machine
already keeps, and to offer one thing about it — a green run and a commit —
at a moment where stopping costs nothing.

It is about the work. Not about the person, not about how long they have been
at it, and not about what any of that might mean for them. Ascenda has its own
surfaces for the person, and they are not yours to speak from.

## Before anything else: is the tool even there?

Check whether `get_work_demand_context` is in your available tools. It is
served by the Flow app on the user's own Mac, over loopback, on a scope they
ticked. If it isn't there, this skill does nothing — don't mention Ascenda,
don't apologise, don't suggest installing anything. Quiet is the correct
behaviour for an unpaired machine.

## Reading the slice

Call it with your own working directory:

```json
{ "cwd": "/Users/them/Dev/their-repo" }
```

You get back window totals from the person's paired tools, and a `projects`
block cutting the same kind of counters per work context. Four things about
that block decide everything below.

**You may read exactly one entry.** `projects.thisProject` is your `cwd`
resolved on that machine to the same salted digest every Ascenda collector
uses — a linked worktree resolves to the repository it came from, so a
worktree and its parent are one context. Find the entry whose `projectDigest`
matches. **Every other entry is a project you cannot name and must not try
to.** Don't count them, don't mention that there are others, don't infer
anything from how many there are. The digests are opaque on purpose; treating
them as a list of the person's projects is the one thing this payload is
shaped to prevent.

**Two entries can share a digest, and they are not the same finding.** Each
carries a `provenance`. A day a collector actually watched (`live`) and the
same day rebuilt afterwards from a transcript (`retrospective`) are separate
rows, and adding them together would invent a day nobody had. **Read the
`live` row for your digest and nothing else.** If your digest has no `live`
row, there is no finding here — say nothing.

**Never add the two minute figures together.** `handsOnMinutes` is time in
spans where the person themselves acted. `supervisingMinutes` is time in spans
that carried an agent's tool calls and no act of theirs. Their sum is not
"time at the machine": a forty-minute agent run is not forty minutes of
anyone's attention, and the single number that says it is, is the thing this
payload is built to avoid. Quote whichever one you mean, by name, on its own.
`projects.window.gapMinutes` is the gap that ends a span — state it if you
describe the rule, rather than presenting a threshold as a fact of nature.

**A dimension in `notCollected` is unmeasured, not zero.** Every entry carries
its own list, and two are always in it. `verificationPass`: runs going green
are recorded on a rail that is not keyed by project at all, so there is no
per-project answer — the window-level `checkpoints` block above is the only
one. `compactionCount`: counted per day, never per context. Reason from what
is present, and treat `retryStormCount`'s absence the same way: it means
nothing was watching for a storm, not that none happened.

If the whole block says `projects.proEntitlementRequired` or `projects.noRead`
in its `notCollected`, there is nothing to read. Say nothing — and in
particular don't tell the person their week looks empty, because that is not
what either of those means.

## When to offer a checkpoint

Your own entry carries `buckets`, one per day, because "has this run long
today" is a question about a day and the entry's headline figures are the
whole window folded together. **Work from the newest bucket, and name its
date when you speak.**

All four, or say nothing:

1. **The project had a long day.** In that newest bucket, either
   `handsOnMinutes` or `supervisingMinutes` is **90 or more**. Either one
   alone — never the two added.
2. **Nothing recent stands as a checkpoint.** At least one of these is true,
   and neither is merely missing: your entry's `lastCommitAt` is present and
   **more than 90 minutes** old, or the window's
   `checkpoints.minutesSinceLastVerificationPass` is present and **more than
   90**. If the record cannot answer either way — both absent, or named as not
   collected — there is no finding here. Don't offer.
3. **You are at a boundary the work produced.** A task just finished, a
   question just got answered, a piece of work resolved. Never mid-edit, never
   while a run is in flight, never because time has passed. If you are in the
   middle of something, hold it until you are not.
4. **You are allowed to raise it.** If you are speaking unprompted, check
   `intervention.warranted` first: `false` means say nothing about how the
   work is going — either Flow already holds the day's one ask, or the
   baseline behind it cannot support a claim. Honour it rather than reasoning
   around it; `intervention.guidance` says what to do in each case. If the
   person asked you directly what to do next, answer them — but still don't
   add an ask of your own on top.

## What to offer

One sentence of fact, one offer, and then whatever they say goes:

> Today this repo has had a bit over two hours of supervising time, and the
> last commit was at 09:14. Want me to run the tests and commit before I start
> the next thing?

- **The offer is a green run and a commit, in that order.** A commit on top of
  something unverified is a worse checkpoint than none — it looks like a
  return point and isn't one. If there is no verification command you can run,
  offer the commit alone and say that is what you are offering.
- **State the figure you used, and name it.** "Two hours of supervising time"
  or "ninety minutes hands-on" — never an unlabelled duration, and never a
  total. If the newest bucket is not today, say which day it is.
- **Once per session.** If they decline, or ignore it, or say "later", drop
  it. Don't re-raise at the next boundary. A second offer is nagging, and this
  skill has no budget for it.
- **Their call, entirely.** They may commit without running anything, run
  without committing, or keep going. Do what they say and move on without
  comment.

## The vocabulary line

Everything you say from this skill describes **the work**. Check anything you
are about to write against [`copy/banned-vocabulary.txt`](../../copy/banned-vocabulary.txt)
— and note that the list is the floor, not the ceiling. These are all wrong
even though none of them is on it:

- *"You've been going a long time — maybe take a break."* Not yours to say.
  You are looking at a repository's counters, not at a person, and the two are
  not the same thing even when they correlate.
- *"That's a lot of retries."* A retry-storm count is a fact about tools
  failing. Making it an assessment turns a counter into a verdict.
- *"You seem to be losing steam."* There is nothing in this payload that could
  support that, which is exactly why it is tempting to say it.

If the only way to justify raising something is a sentence about how the
person is doing, you have left this skill's remit. The offer above is the
whole of it: a fact about the work, and one thing you could do about it.

## What this skill is not

It doesn't decide when Ascenda interrupts anyone — that is the app's own ask
slot, running against baselines you cannot see, which is what
`intervention.warranted` reports the answer of. It doesn't report anything
back: this is a read, and the only thing that leaves is nothing at all.
(Reporting observed patterns is a separate skill,
[`ascenda-work-signals`](../ascenda-work-signals/SKILL.md), with its own tool
and its own rules.) And it never runs on request — "check my work demand" is
not a thing to answer, because the answer would be a stretch of counters with
no boundary to land at.
