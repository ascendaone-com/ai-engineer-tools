---
name: ascenda-reveal-read
description: At the start of a session, read once what the Ascenda Flow app showed this person about their own imported history (the Reveal) over its local get_reveal tool, and hold it as context. Say nothing about it unless they ask, or unless placing a piece of work is the decision in front of you. Counts and dates only, projects as opaque digests, never a label about the person, and only when the local tool is available.
license: Apache-2.0
---

# Ascenda Reveal Read

When someone imports their coding history into the Flow app, the app shows
them a short read of it once: which days ran heavy and which ran light, how
the weeks climbed or fell, the hour band their work leans to, one crossing
of two facts, and a receipt. That read is theirs. This skill lets you read
the same thing, from their own machine, so that when they ask what their
record shows, or when you are deciding where in a day to put a hard piece
of work, you are working from the record and not from a guess.

It is about the work. Not about the person, not about what any of it
means for them. The app has its own surfaces for the person, and they are
not yours to speak from.

## Before anything else: is the tool even there?

Check whether `get_reveal` is in your available tools. It is served by the
Flow app on the user's own Mac, over loopback, on a scope they ticked
(*Demand & workload*). If it isn't there, this skill does nothing: don't
mention Ascenda, don't apologise, don't suggest installing anything. Quiet
is the correct behaviour for an unpaired machine.

## Reading it

**Once per session, at the start, and never again.** The read is the
imported record, which does not change while you work. Call it with your
own working directory:

```json
{ "cwd": "/Users/them/Dev/their-repo" }
```

What comes back, and what each part is for:

- **`eligible`.** If it is `false` the record is below the Reveal's own
  floors (they are stated in `floors`, with what the record has in `have`).
  There is nothing to hold and nothing to say. Don't tell the person their
  history is thin; that is not what a floor means.
- **`facts`.** The receipt: a list of sentences the app itself showed, each
  with a `line`, a `receipt` (the counted evidence) and a `tag` naming the
  boundary the fact was made under. These are already written to the app's
  own rules. **Quote them; don't paraphrase them into something stronger.**
- **`days`.** Every imported day placed on the record's own scale, quietest
  0 to heaviest 1, with prompts, whether any of it ran past 7 pm, and the
  amber rule the app used. A day with no placement is a day the record
  holds nothing for, not a quiet one.
- **`weeks`.** The weekly series the app drew, with the columns it carried.
- **`band`.** The hour band the work leans to: the median first prompt of
  the day, its spread, the after-hours share. It is the work leg only. It
  says when the day's work started; it cannot say when the person woke, and
  neither can you.
- **`crossing`.** Two facts from the same record set side by side, with the
  name the literature gives that shape under `shape.literature` and its
  citation. Its `tag` is the whole of what may be said about the relation
  between the two: **a pairing, not a cause.**
- **`projects`.** Every project on the record as an opaque digest.
  `projects.thisProject` is your `cwd` resolved on that machine to the same
  salted digest every Ascenda collector uses. **You may read exactly one
  entry, and it is that one.** Every other entry is a project you cannot
  name and must not try to: don't count them, don't mention that there are
  others, don't infer anything from how many there are.
- **`notCollected`.** A dimension named here is unmeasured, not zero. The
  weekday sentence is absent until the record's era clears a quarter of a
  year; a crossing is absent when no pairing clears the spread. Absent is
  absent.

## When to use it

Hold the read. Use it in two situations and no others.

1. **They ask.** "What does my record say?", "When do I usually start?",
   "Which weeks were the heavy ones?" Answer from the facts, quoting the
   line and its receipt, and name the window the read covers.
2. **Placing work is the decision in front of you.** When the person is
   deciding what to do first, or when in the day, and the band or the days
   bear on it, you may say what the record shows in one sentence, as a
   fact about the record, and leave the choice with them:

   > On this record the first prompt of the day usually lands around 06:40,
   > and the heaviest days ran past seven. Want the review in the morning
   > and the long agent run after?

Never volunteer it otherwise. A read that arrives unasked, on a timer, or as
a preamble to unrelated work is the thing this skill is shaped to prevent.
If you are speaking unprompted and `get_work_demand_context` is also
available, its `intervention.warranted` is the app's own answer to whether
anything about the work may be raised today; honour it rather than
reasoning around it.

## What you may not say

- **Never a label about the person.** The band is a reading of when the
  work started. The app proposes a bird from it and the person keeps it or
  not; that label is theirs, lives on a different scope, and is not in this
  payload. If they tell you their word for it, use their word. Never call
  them anything from the numbers.
- **Never the word "because" between the two facts of the crossing.** The
  literature's name describes the shape. It does not explain the person.
  "The week with the most switching was also the week with the most
  re-prompts" is the whole sentence; what it means is theirs to say.
- **Never a project by name.** You hold one digest, your own. The prose in
  `facts` already has names held back; keep them held back.
- **Never a verdict.** Heavy is a placement on the person's own scale, not
  an assessment. A late day is a day that ran past seven. A retry is not a
  mistake.

Check anything you are about to write against
[`copy/banned-vocabulary.txt`](../../copy/banned-vocabulary.txt), and note
that the list is the floor, not the ceiling.

## What this skill is not

It doesn't report anything back: this is a read, and the only thing that
leaves is nothing at all. (Reporting observed patterns is a separate skill,
[`ascenda-work-signals`](../ascenda-work-signals/SKILL.md), with its own
tool.) It doesn't offer checkpoints; that is
[`ascenda-work-checkpoints`](../ascenda-work-checkpoints/SKILL.md), reading
a different tool about today rather than the imported past. And it never
turns the record into advice about the person: the record shows the
pattern, and the person names it.
