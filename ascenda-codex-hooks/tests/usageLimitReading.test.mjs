import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readLastUsageLimitReading, usageLimitReadingOfLine } from "../dist/usageLimitReading.js";
import { mapCodexEvent } from "../dist/mapCodexEvent.js";

function tokenCount(shortPct, longPct) {
  return JSON.stringify({
    timestamp: "2026-11-16T10:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        limit_id: "plan-limit-id",
        plan_type: "plan-type",
        primary: { used_percent: shortPct, window_minutes: 300, resets_at: 1763300000 },
        secondary: { used_percent: longPct, window_minutes: 10080, resets_at: 1763800000 },
        credits: { balance: "12.34" },
        rate_limit_reached_type: null
      }
    }
  });
}

function rolloutWith(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-"));
  const file = path.join(dir, "rollout-2026-11-16T10-00-00-019c0000-0000-7000-8000-00000000000a.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("the last reading in the rollout wins, rounded", () => {
  const file = rolloutWith([
    tokenCount(12, 3),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x" } }),
    tokenCount(40.6, 7.4),
    JSON.stringify({ type: "event_msg", payload: { type: "item_completed" } })
  ]);
  assert.deepEqual(readLastUsageLimitReading(file), { shortPct: 41, longPct: 7 });
});

test("a rollout with no reading, a non-rollout path and a missing file all read as nothing", () => {
  assert.equal(readLastUsageLimitReading(rolloutWith([JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } })])), undefined);
  assert.equal(readLastUsageLimitReading("/etc/hosts"), undefined);
  assert.equal(readLastUsageLimitReading("/nowhere/rollout-x.jsonl"), undefined);
  assert.equal(readLastUsageLimitReading(undefined), undefined);
});

test("a reading past the tail window is still found when a long line follows it", () => {
  const file = rolloutWith([tokenCount(55, 9), JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "y".repeat(40_000) } })]);
  assert.deepEqual(readLastUsageLimitReading(file), { shortPct: 55, longPct: 9 });
});

test("only the two percentages are taken from the line", () => {
  const reading = usageLimitReadingOfLine(tokenCount(20, 5));
  assert.deepEqual(reading, { shortPct: 20, longPct: 5 });
});

test("Stop carries the reading on ai_turn_completed, and nothing without one", () => {
  const withReading = mapCodexEvent("Stop", { cwd: "/tmp" }, undefined, undefined, { shortPct: 40, longPct: 8 });
  const turn = withReading.find((e) => e.eventType === "ai_turn_completed");
  assert.equal(turn.metadata.usageLimitShortPeakPct, 40);
  assert.equal(turn.metadata.usageLimitLongPeakPct, 8);
  const text = JSON.stringify(withReading);
  for (const leak of ["plan-limit-id", "plan-type", "12.34"]) assert.equal(text.includes(leak), false);

  const without = mapCodexEvent("Stop", { cwd: "/tmp" }).find((e) => e.eventType === "ai_turn_completed");
  assert.equal("usageLimitShortPeakPct" in without.metadata, false);
});
