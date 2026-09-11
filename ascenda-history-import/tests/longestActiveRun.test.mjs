/**
 * The longest unbroken stretch — the one figure on a handoff that is not a
 * total, and the one that cannot be rebuilt from the ones that are.
 *
 * Two reductions stand between a person's stretch and what a reader sees, and
 * each is lossy in exactly the dimension a stretch receipt needs:
 *
 *  * **the midnight clip.** `addSpanByLocalDay` splits every span at each local
 *    midnight it crosses, so a fifty-minute stretch worked 23:40 -> 00:30
 *    arrives as twenty minutes of Monday and thirty of Tuesday. Nothing added
 *    from those returns fifty.
 *  * **the cross-session union.** One continuous stretch worked by two
 *    overlapping sessions is two shorter stretches until the union merges them,
 *    which is why the figure cannot be taken per session either.
 *
 * So the maximum has to be taken after the union and before the clip. These
 * tests pin both ends of that window, and the absent case at the writer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { longestRunOf, unionActiveTime } from "../dist/activeUnion.js";
import { elapsedActiveOf, HANDOFF_SCHEMA } from "../dist/localHandoff.js";

/** Local wall-clock on Monday 3 Aug 2026, or a later day with `dayOffset`. */
const at = (hour, minute = 0, dayOffset = 0) =>
  new Date(2026, 7, 3 + dayOffset, hour, minute).getTime();

const span = (from, to, handsOn = false) => ({ from, to, handsOn, band: "unknown" });

test("a stretch across midnight is one stretch, not two shorter ones", () => {
  // 23:40 Monday -> 00:30 Tuesday. Fifty unbroken minutes of one night.
  const spans = [span(at(23, 40), at(0, 30, 1))];
  assert.equal(unionActiveTime(spans).longestRunMs, 50 * 60_000);

  const elapsed = elapsedActiveOf(spans);
  assert.equal(
    elapsed.longestActiveRunMinutes,
    50,
    "the maximum is taken before the clip; taken after it the best any day could offer is 30"
  );

  // And the very figures it could not have come from, so the loss the key
  // repairs stays visible here rather than being asserted about in prose.
  assert.deepEqual(
    elapsed.days.map((d) => d.agentSupervisingMinutes),
    [20, 30]
  );
});

test("the stretch is dated to the day it began, not the day it ended", () => {
  const elapsed = elapsedActiveOf([span(at(23, 40), at(0, 30, 1))]);
  assert.equal(elapsed.longestActiveRunStartedOn, "2026-08-03");
});

test("two overlapping sessions working one stretch report its length", () => {
  // 14:00-15:00 and 14:30-16:00: one continuous two-hour run, worked by two
  // sessions that each only saw their own part of it.
  const spans = [span(at(14), at(15)), span(at(14, 30), at(16))];
  assert.equal(unionActiveTime(spans).longestRunMs, 120 * 60_000);
  assert.equal(elapsedActiveOf(spans).longestActiveRunMinutes, 120);

  // Per session — the reading available before the union — the best either
  // could report is its own ninety minutes.
  assert.equal(
    unionActiveTime([span(at(14, 30), at(16))]).longestRunMs,
    90 * 60_000
  );
});

test("sessions that hand over to each other are one stretch", () => {
  // One ends exactly where the next begins: a handover, not a hole.
  const union = unionActiveTime([span(at(14), at(15)), span(at(15), at(16))]);
  assert.equal(union.longestRunMs, 120 * 60_000);
});

test("a gap between sessions ends the stretch", () => {
  const union = unionActiveTime([span(at(9), at(11)), span(at(13), at(16))]);
  assert.equal(union.longestRunMs, 180 * 60_000);
  assert.equal(
    union.longestRunFrom,
    at(13),
    "the longest run is the afternoon, so that is the instant reported — not the day's first span"
  );
});

test("typing inside a supervised stretch does not break it", () => {
  // Forty minutes watching an agent, twenty typing, then more watching. The
  // person never stepped away; the partition between the halves is not a gap
  // in their attention.
  const union = unionActiveTime([
    span(at(14), at(16)),
    span(at(14, 40), at(15), true)
  ]);
  assert.equal(union.longestRunMs, 120 * 60_000);
  assert.equal(union.handsOnMs, 20 * 60_000);
  assert.equal(union.agentSupervisingMs, 100 * 60_000);
});

test("no spans means no keys, never a zero-minute stretch", () => {
  const union = unionActiveTime([]);
  assert.equal(union.longestRunMs, null);
  assert.equal(union.longestRunFrom, null);
  assert.equal(longestRunOf([]), null);

  const elapsed = elapsedActiveOf([]);
  assert.ok(!("longestActiveRunMinutes" in elapsed));
  assert.ok(!("longestActiveRunStartedOn" in elapsed));
});

test("the stretch is a schema-6 addition", () => {
  // A reader must be able to tell "this handoff predates the stretch" from
  // "this project had no stretch to report". Absent means NOT COLLECTED, and
  // the schema is the only thing that says which.
  assert.ok(HANDOFF_SCHEMA >= 6);
});
