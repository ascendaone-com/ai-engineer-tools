/**
 * Codex usage-limit readings: `rate_limits` on main-thread `token_count`
 * lines, folded into the session's `usageLimit*` keys and each day slice's
 * own peaks. The account and plan fields on the same object never ship.
 */
import "./isolateHome.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractCodex } from "../dist/extractors/codex.js";
import { toWirePayload } from "../dist/ship.js";
import { buildCodexHandoff } from "../dist/localHandoff.js";

const MAIN = "019c0000-0000-7000-8000-00000000000a";
const SUB = "019c0000-0000-7000-8000-00000000000b";
const CWD = "/work/repo-a";

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function limits(shortPct, longPct, extra = {}) {
  return {
    limit_id: "plan-limit-id",
    limit_name: "plan-limit-name",
    plan_type: "plan-type",
    primary: { used_percent: shortPct, window_minutes: 300, resets_at: 1800000000 },
    secondary: { used_percent: longPct, window_minutes: 10080, resets_at: 1800500000 },
    credits: { has_credits: false, unlimited: false, balance: "12.34" },
    individual_limit: { amount: 1 },
    spend_control_reached: null,
    rate_limit_reached_type: null,
    ...extra
  };
}

function tokenCount(timestamp, rateLimits, info = null) {
  return line(timestamp, "event_msg", { type: "token_count", info, rate_limits: rateLimits });
}

function meta(timestamp, id, extra = {}) {
  return line(timestamp, "session_meta", { id, timestamp, cwd: CWD, cli_version: "0.169.0", ...extra });
}

function prompt(timestamp) {
  return line(timestamp, "event_msg", { type: "user_message", message: "redacted", images: [] });
}

async function storeWith(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-limits-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  return root;
}

const rollout = (day, ts, id) => `sessions/2026/11/${day}/rollout-2026-11-${day}T${ts}-${id}.jsonl`;
const body = (lines) => lines.join("\n") + "\n";

async function sessionOf(root) {
  const out = [];
  for await (const e of extractCodex(root, "x1")) out.push(e);
  const sessions = out.filter((e) => e.eventKind === "create_focus_session");
  assert.equal(sessions.length, 1);
  return { session: sessions[0], events: out };
}

function usageKeys(metrics) {
  return Object.keys(metrics).filter((k) => k.startsWith("usageLimit")).sort();
}

test("the peaks are the largest reading of each window, rounded", async () => {
  const root = await storeWith({
    [rollout("10", "01-00-00", MAIN)]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      tokenCount("2026-11-10T01:00:05.000Z", limits(10, 3)),
      tokenCount("2026-11-10T01:00:09.000Z", limits(40.4, 7.6)),
      tokenCount("2026-11-10T01:00:12.000Z", limits(25, 5))
    ])
  });
  const { session } = await sessionOf(root);
  assert.equal(session.metrics.usageLimitShortPeakPct, 40);
  assert.equal(session.metrics.usageLimitLongPeakPct, 8);
  assert.equal(session.metrics.usageLimitShortWindowMinutes, 300);
  assert.equal(session.metrics.usageLimitLongWindowMinutes, 10080);
  assert.equal(session.metrics.usageLimitReached, false);
  assert.equal("usageLimitReachedType" in session.metrics, false);
  assert.equal("usageLimitFirstReachedAt" in session.metrics, false);
});

test("the window sizes come from the line, not an assumption", async () => {
  const odd = limits(12, 4);
  odd.primary.window_minutes = 60;
  odd.secondary.window_minutes = 1440;
  const root = await storeWith({
    [rollout("10", "01-00-00", MAIN)]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      tokenCount("2026-11-10T01:00:05.000Z", odd)
    ])
  });
  const { session } = await sessionOf(root);
  assert.equal(session.metrics.usageLimitShortWindowMinutes, 60);
  assert.equal(session.metrics.usageLimitLongWindowMinutes, 1440);
});

test("a reached type marks the session and dates the first hit", async () => {
  const root = await storeWith({
    [rollout("10", "01-00-00", MAIN)]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      tokenCount("2026-11-10T01:00:05.000Z", limits(90, 30)),
      tokenCount("2026-11-10T01:00:09.000Z", limits(100, 31, { rate_limit_reached_type: "primary" })),
      tokenCount("2026-11-10T01:00:12.000Z", limits(100, 31, { rate_limit_reached_type: "primary" }))
    ])
  });
  const { session } = await sessionOf(root);
  assert.equal(session.metrics.usageLimitReached, true);
  assert.equal(session.metrics.usageLimitReachedType, "primary");
  assert.equal(session.metrics.usageLimitFirstReachedAt, "2026-11-10T01:00:09.000Z");
});

test("an unknown reached type is kept as other", async () => {
  const root = await storeWith({
    [rollout("10", "01-00-00", MAIN)]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      tokenCount("2026-11-10T01:00:05.000Z", limits(100, 50, { rate_limit_reached_type: "a brand new limit" }))
    ])
  });
  const { session } = await sessionOf(root);
  assert.equal(session.metrics.usageLimitReachedType, "other");
});

test("a rollout with no readings has no usageLimit keys", async () => {
  const root = await storeWith({
    [rollout("10", "01-00-00", MAIN)]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      line("2026-11-10T01:00:05.000Z", "event_msg", { type: "token_count", info: null })
    ])
  });
  const { session } = await sessionOf(root);
  assert.deepEqual(usageKeys(session.metrics), []);
  for (const day of session.dayBreakdown) assert.equal("usageLimitShortPeakPct" in day, false);
});

test("a subagent thread's reading doesn't move the peak", async () => {
  const root = await storeWith({
    [rollout("10", "01-00-00", MAIN)]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      tokenCount("2026-11-10T01:00:05.000Z", limits(20, 5))
    ]),
    [rollout("10", "01-01-00", SUB)]: body([
      meta("2026-11-10T01:01:00.000Z", SUB, { thread_source: "subagent", parent_thread_id: MAIN }),
      prompt("2026-11-10T01:01:01.000Z"),
      tokenCount("2026-11-10T01:01:05.000Z", limits(95, 60, { rate_limit_reached_type: "primary" }))
    ])
  });
  const { session } = await sessionOf(root);
  assert.equal(session.metrics.usageLimitShortPeakPct, 20);
  assert.equal(session.metrics.usageLimitLongPeakPct, 5);
  assert.equal(session.metrics.usageLimitReached, false);
});

test("the account and plan fields never reach any event", async () => {
  const root = await storeWith({
    [rollout("10", "01-00-00", MAIN)]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      tokenCount("2026-11-10T01:00:05.000Z", limits(10, 3, { rate_limit_reached_type: "secondary" }))
    ])
  });
  const { events } = await sessionOf(root);
  const text = JSON.stringify(events);
  for (const leak of ["plan-limit-id", "plan-limit-name", "plan-type", "12.34", "individual_limit", "credits"]) {
    assert.equal(text.includes(leak), false, `${leak} reached an event`);
  }
  assert.deepEqual(
    usageKeys(events.find((e) => e.eventKind === "create_focus_session").metrics),
    [
      "usageLimitFirstReachedAt",
      "usageLimitLongPeakPct",
      "usageLimitLongWindowMinutes",
      "usageLimitReached",
      "usageLimitReachedType",
      "usageLimitShortPeakPct",
      "usageLimitShortWindowMinutes"
    ]
  );
});

test("each day slice carries that day's own peaks", async () => {
  // Two days apart, so they're different local days in any timezone.
  const root = await storeWith({
    [rollout("10", "10-00-00", MAIN)]: body([
      meta("2026-11-10T10:00:00.000Z", MAIN),
      prompt("2026-11-10T10:00:01.000Z"),
      tokenCount("2026-11-10T10:00:05.000Z", limits(70, 20)),
      tokenCount("2026-11-10T10:00:09.000Z", limits(55, 21)),
      prompt("2026-11-12T10:00:01.000Z"),
      tokenCount("2026-11-12T10:00:05.000Z", limits(15, 33))
    ])
  });
  const { session } = await sessionOf(root);
  assert.equal(session.metrics.usageLimitShortPeakPct, 70);
  assert.equal(session.metrics.usageLimitLongPeakPct, 33);
  const withPeaks = session.dayBreakdown.filter((d) => "usageLimitShortPeakPct" in d);
  assert.deepEqual(
    withPeaks.map((d) => [d.usageLimitShortPeakPct, d.usageLimitLongPeakPct]),
    [
      [70, 21],
      [15, 33]
    ]
  );
});

/* ------------------------------------------------------------------------ *
 * The readings stay on the machine
 * ------------------------------------------------------------------------ */

test("the readings reach the handoff and never the wire payload", async () => {
  const root = await storeWith({
    [rollout("10", "01-00-00", MAIN)]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      tokenCount("2026-11-10T01:00:05.000Z", limits(40, 25)),
      tokenCount("2026-11-10T01:05:00.000Z", limits(100, 31, { rate_limit_reached_type: "primary" }))
    ])
  });
  const { session, events } = await sessionOf(root);
  assert.equal(session.metrics.usageLimitShortPeakPct, 100, "the extractor still folds them");

  const payload = toWirePayload(session, 0, "cli_agent:test-install");
  const sent = Object.keys(payload.metadata).filter((k) => /usage.?limit/i.test(k));
  assert.deepEqual(sent, [], "no usage-limit key is sent");
  assert.equal(typeof payload.metadata.promptCount, "number", "the rest of the session still is");

  const handoff = buildCodexHandoff(events, "x1", "2026-11-11T00:00:00.000Z");
  assert.equal(handoff.sessions.length, 1);
  const local = handoff.sessions[0];
  assert.equal(local.usageLimitShortPeakPct, 100);
  assert.equal(local.usageLimitLongPeakPct, 31);
  assert.equal(local.usageLimitShortWindowMinutes, 300);
  assert.equal(local.usageLimitLongWindowMinutes, 10080);
  assert.equal(local.usageLimitReached, true);
  assert.equal(local.usageLimitReachedType, "primary");
  assert.equal(local.usageLimitFirstReachedAt, "2026-11-10T01:05:00.000Z");
  assert.equal(local.days[0].usageLimitShortPeakPct, 100);
});

test("a session with no readings is null in the handoff, never zero", async () => {
  const root = await storeWith({
    [rollout("10", "01-00-00", MAIN)]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      line("2026-11-10T01:00:05.000Z", "event_msg", { type: "token_count", info: null })
    ])
  });
  const { events } = await sessionOf(root);
  const local = buildCodexHandoff(events, "x1", "2026-11-11T00:00:00.000Z").sessions[0];
  assert.equal(local.usageLimitShortPeakPct, null);
  assert.equal(local.usageLimitLongPeakPct, null);
  assert.equal(local.usageLimitReached, null);
});

async function metricsFor(lines) {
  const root = await storeWith({
    [rollout("10", "01-00-00", MAIN)]: body([meta("2026-11-10T01:00:00.000Z", MAIN), prompt("2026-11-10T01:00:01.000Z"), ...lines])
  });
  return (await sessionOf(root)).session.metrics;
}

test("a window with resets_in_seconds and no resets_at is still read", async () => {
  const m = await metricsFor([
    tokenCount("2026-11-10T01:00:05.000Z", {
      primary: { used_percent: 42, window_minutes: 300, resets_in_seconds: 600 },
      secondary: null
    })
  ]);
  assert.equal(m.usageLimitShortPeakPct, 42);
});

test("a window whose reset has passed is cleared, not held", async () => {
  const m = await metricsFor([
    tokenCount("2026-11-10T01:00:05.000Z", {
      primary: { used_percent: 97, window_minutes: 300, resets_at: Date.parse("2026-11-10T00:30:00Z") / 1000 },
      secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1800500000 },
      rate_limit_reached_type: "primary"
    })
  ]);
  assert.equal(m.usageLimitShortPeakPct, undefined);
  assert.equal(m.usageLimitLongPeakPct, 20);
  assert.equal(m.usageLimitReached, false);
});

test("additional_rate_limits windows count toward the peaks", async () => {
  const m = await metricsFor([
    tokenCount("2026-11-10T01:00:05.000Z", {
      primary: { used_percent: 10, window_minutes: 300, resets_at: 1800000000 },
      secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1800500000 },
      additional_rate_limits: [
        { limit_name: "extra", primary: { used_percent: 60, window_minutes: 300, resets_in_seconds: 100 }, secondary: null }
      ]
    })
  ]);
  assert.equal(m.usageLimitShortPeakPct, 60);
  assert.equal(m.usageLimitLongPeakPct, 5);
});
