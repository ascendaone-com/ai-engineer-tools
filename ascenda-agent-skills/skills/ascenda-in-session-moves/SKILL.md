---
name: ascenda-in-session-moves
description: When you have just seen a known work pattern in this session (three or more different approaches to the same problem with none working, the work drifting from the goal the person stated, about twenty minutes with no passing run, commit or fix, a change of 200 or more lines you wrote just accepted, or this session's context compacted after more than two hours), ask the Ascenda Flow app's local get_in_session_move tool whether you may offer one change to try, and if it says yes, offer that one change once, as a question, at the next boundary the work produces. Use this passively, only when the local tool is available, and never more than once per session.
license: Apache-2.0
---

# Ascenda In-Session Moves

Some patterns in a working session have a known change that answers them.
Three approaches to the same bug without a fix usually means the problem
statement is off, and a fourth approach will not land either. A big accepted
change is easier to understand now than after the next three. A long session
that has started compacting keeps compacting, and a fresh one starts with an
empty context. You can see these patterns as they happen. The person's Flow
app knows the things you cannot: whether they have asked to be offered things
to try at all, whether the app is already asking them something today, and
how this change went the last time they tried it.

So you ask the app first, and you offer only what it hands back.

It is about the work. Not about the person, not about how they are doing, and
not about what the pattern might say about them.

## Before anything else: is the tool even there?

Check whether `get_in_session_move` is in your available tools. It is served
by the Flow app on the person's own Mac, over loopback, under the *Demand &
workload* scope they ticked when they paired you. If it isn't there, this
skill does nothing: don't mention Ascenda, don't apologise, don't suggest
installing anything. Quiet is the correct behaviour for an unpaired machine,
and for a Flow build that does not have the tool yet.

## The five patterns

Ask only when one of these is true **in this session**, from what you have
seen yourself:

| `trigger` | When |
|---|---|
| `large_accepted_change` | A change of 200 or more lines that you wrote has just been accepted. |
| `approach_churn_detected` | Three or more materially different approaches to the same problem, none of them resolving it. Retrying the same approach with a tweak is not a new approach. |
| `progress_stalled` | About twenty minutes of iterating with no passing run, no commit and no fix. The same line going nowhere, not three different ones. |
| `goal_drift_detected` | The person said what this session is for, and the work has moved to unrelated files or tasks without them confirming the change. No stated goal, no drift. |
| `session_compacted` | This session's context has been compacted, and the session has run for more than two hours. |

Churn, a stall and drift use the same thresholds as the events of the same
names in [`ascenda-work-signals`](../ascenda-work-signals/SKILL.md). If you
hold both skills, report the event there and ask here. Neither depends on the
other. For drift, work-signals tells you to pair the event with a question:
when this tool is available, the question is this skill's, asked this way,
so the person hears one question about the drift, not two.

**When more than one holds,** name the one that produced the boundary you are
at. If you can't tell, take them in the table's order: a large change first,
because it is happening now; churn before a stall, because churn is the more
specific of the two.

## Asking

```json
{ "trigger": "approach_churn_detected" }
```

The answer always carries `offer`, `reason` and `guidance`.

**When `offer` is false, say nothing about the pattern or the change.** Follow
`guidance` and carry on with the work. The reasons, so you are not tempted to
reason around them:

- `line_says_no`: the person has told Flow not to offer them things to try.
  That is their setting, and it holds here too.
- `flow_holds_the_ask`: Flow is already asking them something today. A second
  ask from you spends a budget you cannot see.
- `rested`: they set this change aside recently. Do not offer it, and do not
  mention that they set it aside.
- `history_unread`: the app has not read their past changes yet. Ask again
  next session, not this one.

Ask once per pattern. Do not call the tool again for the same pattern in the
same session to see whether the answer has changed. A refusal for one pattern
does not stop you asking about a different one later, unless you have already
made an offer.

## When `offer` is true

You get one change, in `move`: its `name`, a `description` of what it means,
and `ask`, the question to put to them. You may also get two sentences you
may quote exactly as given:

- `pattern`: the person's own history, in their own figures, over a long
  enough stretch to mean something.
- `lastTime`: how the last run of this change went, in their own word.

Then:

1. **Wait for a boundary the work produced.** A piece of work finished, a run
   came back, a question got answered. Never mid-edit, never while something
   is running, never because time has passed.
2. **Say what you saw in this session, as counts.** "That's three different
   approaches to this test in about forty minutes, and none has fixed it."
   Name the counts you actually saw. No estimate dressed as a count.
3. **Quote `pattern` or `lastTime` if you have them, as given.** Side by side,
   never joined by a cause. Not "because last time it worked", not "so this
   should help". Two facts, and the person draws the line between them or
   doesn't.
4. **Ask `move.ask` as written.** It is a question so that declining costs
   nothing.

> That's three different approaches to this failing test in about forty
> minutes, and none has fixed it. Want to restate the problem from scratch
> before trying a fourth way?

## Once per session, and their call

- **One offer per session, across every pattern.** If you offered a change
  for churn an hour ago, a compaction later in the session gets nothing. A
  second offer is nagging.
- **If they decline, ignore it, or say "later", drop it.** Do not raise it at
  the next boundary. Do not mention it again.
- **If they say yes, help them do it.** Restating the problem means writing
  it down fresh, without your earlier framing. A fresh read means stopping,
  going back to the last good state if there is one, and getting a second
  opinion (a reviewer, a colleague, a new session given only the problem).
  Re-setting the goal means writing the new one down, or noting the detour
  and going back. Explaining a change means saying what it does, why it
  works and what is most likely to break, plainly enough that they could
  have said it. A fresh session means writing down where things stand so a
  new session can pick it up. Then carry on.
- **Never say they planned, promised or meant to do it,** even if you happen
  to know they are trying the same change this week. "You said you would" is
  a grade, and this skill never grades.

## The vocabulary line

Everything you say from this skill describes **the work**. Check anything you
are about to write against [`copy/banned-vocabulary.txt`](../../copy/banned-vocabulary.txt),
and treat that list as the floor, not the ceiling. All of these are wrong,
even though none of them is on it:

- *"Looks like this one is getting to you."* Not yours to say, and nothing
  you have seen supports it.
- *"You keep going in circles."* The pattern is approaches that did not fix a
  problem. Making the person the subject turns a count into a verdict.
- *"You've been at this a long time, maybe take a break."* The trigger is a
  compacted context, not a person's hours, and the change on offer is a fresh
  session, not a rest.
- *"You've wandered off track."* Drift is the work moving, not the person.
  Say what moved: "We started on the importer and the last three changes
  were in the settings screen."
- *"Did you actually read that?"* A large change is a size, not a doubt
  about them. The offer is to explain it, not to check them.

If the only way to justify raising something is a sentence about how the
person is doing, you have left this skill's remit.

## What this skill is not

It does not report anything back: the tool is a read, and nothing about your
offer or their answer is stored or sent. (Reporting patterns is
[`ascenda-work-signals`](../ascenda-work-signals/SKILL.md), with its own tool
and its own rules.) It does not pick the change: the app does, from the same
catalogue its weekly review runs, so the person meets one set of changes
wherever they meet them. And it never runs on request. "Give me a tip" is a
question to answer directly, not a pattern to ask the app about.
