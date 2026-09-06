import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeIntervals,
  subtractIntervals,
  unionActiveTime,
  unionActiveByLocalDay
} from "../dist/activeUnion.js";
import { buildProjectDigests } from "../dist/localHandoff.js";

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
