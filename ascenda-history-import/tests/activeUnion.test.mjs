import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeIntervals,
  subtractIntervals,
  unionActiveTime,
  unionActiveByLocalDay
} from "../dist/activeUnion.js";
import { buildProjectDigests, HANDOFF_SCHEMA } from "../dist/localHandoff.js";

const MIN = 60_000;
const span = (fromMin, toMin, handsOn = false) => ({
  from: fromMin * MIN,
  to: toMin * MIN,
  handsOn,
  band: "unknown"
});

test("two sessions running the same hour are one hour, not two", () => {
  const union = unionActiveTime([span(0, 60), span(0, 60)]);
  assert.equal(union.agentSupervisingMs, 60 * MIN);
  assert.equal(union.summedAgentSupervisingMs, 120 * MIN);
  assert.equal(union.meanConcurrency, 2);
  assert.equal(union.peakConcurrency, 2);
});

test("sequential sessions union to their sum, and report no concurrency", () => {
  const union = unionActiveTime([span(0, 30), span(30, 60), span(90, 120)]);
  assert.equal(union.agentSupervisingMs, 90 * MIN);
  assert.equal(union.agentSupervisingMs, union.summedAgentSupervisingMs);
  assert.equal(union.meanConcurrency, 1);
  // A span ending exactly where the next begins is a handover, not an overlap.
  assert.equal(union.peakConcurrency, 1);
});

test("hands-on wins the overlap, so the two halves never double-count", () => {
  // One session typing 10:00-10:10 while another's agent runs 10:00-10:30.
  const union = unionActiveTime([span(0, 10, true), span(0, 30, false)]);
  assert.equal(union.handsOnMs, 10 * MIN);
  assert.equal(union.agentSupervisingMs, 20 * MIN);
  // The partition is exact: the halves sum to elapsed time, no more.
  assert.equal(union.handsOnMs + union.agentSupervisingMs, 30 * MIN);
});

test("the union never exceeds the wall clock it sits in", () => {
  // Twelve agents on one hour — the shape that produced 390h in a 168h week.
  const spans = Array.from({ length: 12 }, () => span(0, 60));
  const union = unionActiveTime(spans);
  assert.equal(union.agentSupervisingMs, 60 * MIN);
  assert.equal(union.summedAgentSupervisingMs, 720 * MIN);
  assert.equal(union.meanConcurrency, 12);
});

test("merge treats touching intervals as one stretch", () => {
  assert.deepEqual(mergeIntervals([{ from: 10, to: 20 }, { from: 20, to: 30 }]), [
    { from: 10, to: 30 }
  ]);
});

test("subtract punches every hole and keeps the rest", () => {
  assert.deepEqual(
    subtractIntervals([{ from: 0, to: 100 }], [{ from: 20, to: 30 }, { from: 60, to: 200 }]),
    [{ from: 0, to: 20 }, { from: 30, to: 60 }]
  );
});

test("a span crossing local midnight is split by the day rule, after unioning", () => {
  const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime();
  const byDay = unionActiveByLocalDay([
    { from: at(2026, 9, 1, 23, 50), to: at(2026, 9, 2, 0, 10), handsOn: false, band: "unknown" },
    // A second session covering the same twenty minutes contributes nothing.
    { from: at(2026, 9, 1, 23, 50), to: at(2026, 9, 2, 0, 10), handsOn: false, band: "unknown" }
  ]);
  assert.equal(byDay.get("2026-09-01").agentSupervisingMs, 10 * MIN);
  assert.equal(byDay.get("2026-09-02").agentSupervisingMs, 10 * MIN);
});

test("project digests keep the sum and add the union beside it", () => {
  const session = {
    projectHash: "hash-a",
    projectLabel: "repo-a",
    promptCount: 1,
    handsOnMinutes: 5,
    agentSupervisingMinutes: 60,
    autonomySplit: {},
    days: [{ day: "2026-09-01", prompts: 1 }]
  };
  const spans = { projectHash: "hash-a", projectLabel: "repo-a", spans: [span(0, 60)] };
  const [digest] = buildProjectDigests([session, session], [spans, spans]);

  // Unchanged: the summed figures every existing reader already has.
  assert.equal(digest.agentSupervisingMinutes, 120);
  // Added: the same time as elapsed time.
  assert.equal(digest.elapsed.agentSupervisingMinutes, 60);
  assert.equal(digest.elapsed.meanConcurrency, 2);
  assert.equal(digest.elapsed.peakConcurrency, 2);
  assert.deepEqual(digest.elapsed.days.length, 1);
});

test("a store that hands over no spans gets no elapsed block, not a zero one", () => {
  const [digest] = buildProjectDigests([
    {
      projectHash: null,
      projectLabel: "repo-b",
      promptCount: 1,
      handsOnMinutes: 5,
      agentSupervisingMinutes: 7,
      autonomySplit: {},
      days: []
    }
  ]);
  assert.equal(digest.elapsed, undefined);
  assert.equal(digest.agentSupervisingMinutes, 7);
});

test("elapsed is a schema-5 addition, and 4 stays the app writer's rung", () => {
  // A reader must be able to tell "this handoff predates the union" from "this
  // project's sessions never overlapped": both leave the summed and elapsed
  // figures equal, and only the schema separates them.
  assert.ok(HANDOFF_SCHEMA >= 5, "elapsed is a schema-5 addition");
  // 4 is the app's in-app extractor's rung, for the model and token fold this
  // writer does not produce. Claiming it here would claim those fields.
  assert.notEqual(HANDOFF_SCHEMA, 4);
});

test("a day carries its own summed minutes, so a window can state its concurrency", () => {
  // Two sessions covering the same hour on one day.
  const day = unionActiveByLocalDay([span(0, 60), span(0, 60)]);
  const [only] = [...day.values()];
  assert.equal(only.agentSupervisingMs, 60 * MIN);
  assert.equal(only.summedAgentSupervisingMs, 120 * MIN);
  assert.equal(only.peakConcurrency, 2);
});

test("a window's mean concurrency comes out of its own days, not the corpus", () => {
  const at = (d, h) => new Date(2026, 8, d, h).getTime();
  const s = (d, h1, h2) => ({ from: at(d, h1), to: at(d, h2), handsOn: false, band: "unknown" });
  // 1 Sep: four sessions on one hour. 2 Sep: one session, three hours.
  const byDay = unionActiveByLocalDay([
    s(1, 9, 10), s(1, 9, 10), s(1, 9, 10), s(1, 9, 10),
    s(2, 9, 12)
  ]);

  const windowOf = (days) => {
    const rows = days.map((d) => byDay.get(d));
    const unioned = rows.reduce((n, r) => n + r.handsOnMs + r.agentSupervisingMs, 0);
    const summed = rows.reduce((n, r) => n + r.summedHandsOnMs + r.summedAgentSupervisingMs, 0);
    return { mean: summed / unioned, peak: Math.max(...rows.map((r) => r.peakConcurrency)) };
  };

  // Each day states its own truth...
  assert.equal(windowOf(["2026-09-01"]).mean, 4);
  assert.equal(windowOf(["2026-09-02"]).mean, 1);
  // ...and the two-day window is neither of them, which is the whole point:
  // 7h summed over 4h elapsed. A corpus-wide figure would have said one number
  // for every window a card could ask about.
  assert.equal(windowOf(["2026-09-01", "2026-09-02"]).mean, 7 / 4);
  // Peak is a maximum, so it composes by max and never by sum or average.
  assert.equal(windowOf(["2026-09-01", "2026-09-02"]).peak, 4);
});

test("a span crossing midnight is deep on both days it touches", () => {
  const at = (d, h, m = 0) => new Date(2026, 8, d, h, m).getTime();
  const s = () => ({ from: at(1, 23, 50), to: at(2, 0, 10), handsOn: false, band: "unknown" });
  const byDay = unionActiveByLocalDay([s(), s(), s()]);
  // Three sessions across the boundary: each day sees depth 3 for its half,
  // and neither day is made shallower by the work having begun in the other.
  assert.equal(byDay.get("2026-09-01").peakConcurrency, 3);
  assert.equal(byDay.get("2026-09-02").peakConcurrency, 3);
  assert.equal(byDay.get("2026-09-01").summedAgentSupervisingMs, 30 * MIN);
  assert.equal(byDay.get("2026-09-02").agentSupervisingMs, 10 * MIN);
});

test("per-day figures reach the digest, and did not buy a schema rung", () => {
  const session = {
    projectHash: "hash-c", projectLabel: "repo-c", promptCount: 1,
    handsOnMinutes: 0, agentSupervisingMinutes: 60, autonomySplit: {},
    days: [{ day: "2026-09-01", prompts: 1 }]
  };
  const spans = { projectHash: "hash-c", projectLabel: "repo-c", spans: [span(0, 60)] };
  const [digest] = buildProjectDigests([session, session], [spans, spans]);
  const [day] = digest.elapsed.days;
  assert.equal(day.agentSupervisingMinutes, 60);
  assert.equal(day.summedAgentSupervisingMinutes, 120);
  assert.equal(day.peakConcurrency, 2);
  // These did not buy the rung and never will: they are additive inside the
  // shape schema 5 already describes. 6 is the longest unbroken stretch's, a
  // maximum no reader can derive from the day figures above.
  assert.ok(HANDOFF_SCHEMA >= 5);
});

test("the handoff says which gap rule cut its figures", async () => {
  const { buildHandoff, buildCodexHandoff, HANDOFF_SCHEMA } = await import("../dist/localHandoff.js");
  const { DEFAULT_ACTIVE_GAP_MS } = await import("../dist/activeSplit.js");

  for (const build of [buildHandoff, buildCodexHandoff]) {
    const file = build([], "extraction-1", new Date().toISOString());
    // Provenance, not configuration: the number reported is the number the
    // extractors split with, read from the same constant rather than repeated
    // as a literal that could drift from the rule it claims to describe.
    assert.equal(file.activeGapMinutes, DEFAULT_ACTIVE_GAP_MS / 60_000);
    assert.equal(file.activeGapMinutes, 5);
    // Additive inside the rung the file already claims: the app refuses an
    // unknown schema whole, so a label cannot be bought at the price of the
    // file becoming unreadable.
    assert.equal(file.schema, HANDOFF_SCHEMA);
  }
});
