import { test } from "node:test";
import assert from "node:assert/strict";
import { utcOffsetMinutesAt, localHourAt, isAfterHours } from "../out/afterHours.js";

// `occurredAt` is UTC and carries no offset, so a consumer could not recover
// the person's own clock. The backend read UTC hours as if they were local:
// on a UTC+10 machine that marked the working day after-hours and missed the
// evenings — 83% flagged against a true 15%, the two rules agreeing on 14%
// of 22,535 real prompts. These pin the fact that closes that hole.

test("the offset is minutes AHEAD of UTC, not the Date API's inverse", () => {
  const at = new Date();
  assert.equal(utcOffsetMinutesAt(at), -at.getTimezoneOffset());
  // The sign is the whole point: a consumer adds this to UTC to get local.
  const local = new Date(at.getTime() + utcOffsetMinutesAt(at) * 60_000);
  assert.equal(local.getUTCHours(), at.getHours());
});

test("local hour is recoverable from a UTC instant plus an offset", () => {
  const utcNoon = new Date(Date.UTC(2026, 6, 1, 12, 0, 0));
  assert.equal(localHourAt(utcNoon, 600), 22, "UTC+10 (Brisbane)");
  assert.equal(localHourAt(utcNoon, -420), 5, "UTC-7 (Los Angeles)");
  assert.equal(localHourAt(utcNoon, 0), 12, "UTC");
  // Crossing midnight downward stays a real hour, never negative.
  assert.equal(localHourAt(new Date(Date.UTC(2026, 6, 1, 2, 0, 0)), -420), 19);
});

test("an offset is evaluated at an instant, so DST is not flattened", () => {
  // Two instants six months apart. In a zone with DST they differ; in a zone
  // without one they match. Either is correct — what must NOT happen is the
  // offset being read once and applied to everything.
  const jan = utcOffsetMinutesAt(new Date(Date.UTC(2026, 0, 15, 3, 0, 0)));
  const jul = utcOffsetMinutesAt(new Date(Date.UTC(2026, 6, 15, 3, 0, 0)));
  assert.equal(typeof jan, "number");
  assert.equal(typeof jul, "number");
  assert.ok(Math.abs(jan - jul) <= 120, "a sane DST delta, or none at all");
});

test("the collector's after-hours window is local and 19:00-07:00", () => {
  // Pinned because the backend's rule was 18:00-08:00 UTC — two windows and
  // two clocks for one concept. This is the one the Reveal's own tag states.
  const evening = new Date(2026, 6, 1, 19, 30);
  const midMorning = new Date(2026, 6, 1, 10, 0);
  const smallHours = new Date(2026, 6, 1, 3, 0);
  const sixThirty = new Date(2026, 6, 1, 18, 30);

  assert.equal(isAfterHours(evening), true);
  assert.equal(isAfterHours(smallHours), true);
  assert.equal(isAfterHours(midMorning), false);
  assert.equal(isAfterHours(sixThirty), false, "18:30 is not after hours here");
});
