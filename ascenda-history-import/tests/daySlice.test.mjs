import { test } from "node:test";
import assert from "node:assert/strict";
import { sliceSessionByLocalDay, LOCAL_TIMEZONE } from "../dist/daySlice.js";
import { shippableEvents, toWirePayload } from "../dist/ship.js";

// Local-time fixtures, built from field values rather than UTC strings, so
// these hold wherever the suite runs — the same technique the after-hours
// assertions use.
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

test("a session is placed on the days it has prompts, not the days it spans", () => {
  // Opened 22 Jun, last touched 5 Jul, nothing in between. Placing it on its
  // end day loses 22 Jun; filling its span invents thirteen days.
  const slices = sliceSessionByLocalDay([
    at(2026, 6, 22, 17),
    at(2026, 6, 22, 18),
    at(2026, 7, 5, 14)
  ]);

  assert.deepEqual(
    slices.map((s) => s.day),
    ["2026-06-22", "2026-07-05"]
  );
  assert.deepEqual(
    slices.map((s) => s.prompts),
    [2, 1]
  );
});

test("active minutes split at local midnight", () => {
  // Two qualifying gaps straddling midnight: the work is continuous across
  // the boundary, so neither day may claim the whole of it.
  const slices = sliceSessionByLocalDay(
    [at(2026, 7, 1, 23, 56), at(2026, 7, 2, 0, 0), at(2026, 7, 2, 0, 3)],
    { activeGapMs: 5 * 60_000 }
  );

  assert.deepEqual(
    slices.map((s) => s.day),
    ["2026-07-01", "2026-07-02"]
  );
  // 23:56 -> 00:00 is four minutes of the 1st; 00:00 -> 00:03 is three of
  // the 2nd. Neither day gets the whole seven.
  assert.equal(slices[0].activeMinutes, 4);
  assert.equal(slices[1].activeMinutes, 3);
  assert.equal(slices[0].prompts, 1);
  assert.equal(slices[1].prompts, 2);
});

test("a gap wider than the threshold is idle, and lands on no day", () => {
  const slices = sliceSessionByLocalDay(
    [at(2026, 7, 1, 9), at(2026, 7, 1, 17)],
    { activeGapMs: 5 * 60_000 }
  );
  assert.equal(slices.length, 1);
  assert.equal(slices[0].prompts, 2);
  assert.equal(slices[0].activeMinutes, 0, "eight idle hours are not active work");
});

test("a store that cannot measure active time claims none", () => {
  const slices = sliceSessionByLocalDay([at(2026, 7, 1, 9), at(2026, 7, 1, 10)]);
  assert.equal(slices[0].prompts, 2);
  assert.equal(
    "activeMinutes" in slices[0],
    false,
    "absent, not zero — zero would read as measured and idle"
  );
});

test("unusable timestamps are dropped, never placed on a guessed day", () => {
  const slices = sliceSessionByLocalDay([
    null,
    undefined,
    "",
    "not-a-date",
    at(2026, 7, 1, 9)
  ]);
  assert.deepEqual(slices, [{ day: "2026-07-01", prompts: 1 }]);
});

test("a session with nothing to place yields no days at all", () => {
  assert.deepEqual(sliceSessionByLocalDay([]), []);
  assert.deepEqual(sliceSessionByLocalDay([null, "nonsense"]), []);
});

test("out-of-order timestamps are sorted before slicing", () => {
  const forward = sliceSessionByLocalDay(
    [at(2026, 7, 1, 9), at(2026, 7, 1, 9, 3), at(2026, 7, 2, 11)],
    { activeGapMs: 5 * 60_000 }
  );
  const shuffled = sliceSessionByLocalDay(
    [at(2026, 7, 2, 11), at(2026, 7, 1, 9, 3), at(2026, 7, 1, 9)],
    { activeGapMs: 5 * 60_000 }
  );
  assert.deepEqual(shuffled, forward);
});

test("the timezone the slices were cut in is nameable", () => {
  assert.ok(
    LOCAL_TIMEZONE === null || typeof LOCAL_TIMEZONE === "string",
    "either a zone or an honest null"
  );
});

test("day slices never reach the wire", () => {
  // They ride beside `metrics` rather than inside it precisely so this
  // cannot happen by accident — the local handoff may carry per-day detail,
  // the backend is not offered it.
  const event = {
    occurredAt: at(2026, 7, 1, 9),
    store: "claude_code",
    sourceVersion: "2.1.0",
    sessionRef: "s-1",
    repoRef: "/Users/someone/dev/repo",
    eventKind: "create_focus_session",
    metrics: { promptCount: 3 },
    // A sentinel day deliberately unrelated to occurredAt. Asserting the
    // absence of the event's OWN date would be a tautology in some zones and
    // a false pass in others: at UTC+10 this fixture's occurredAt serialises
    // to the previous UTC day, so the check passed locally and failed on a
    // UTC runner. The string being hunted has to belong only to the slice.
    dayBreakdown: [{ day: "1999-12-31", prompts: 3, activeMinutes: 12 }],
    provenance: "historical_derived",
    extractionId: "e-1"
  };

  const payload = toWirePayload(shippableEvents([event])[0], 0, "claude_code:test");
  const serialised = JSON.stringify(payload);
  assert.equal(serialised.includes("dayBreakdown"), false);
  assert.equal(serialised.includes("1999-12-31"), false);
  assert.equal(payload.metadata.promptCount, 3, "the session itself still ships");
});
