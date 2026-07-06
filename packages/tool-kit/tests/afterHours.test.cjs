const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isAfterHours } = require("../out/index.js");

const at = (hours, minutes = 0) => new Date(2026, 0, 5, hours, minutes);

test("default window 19:00-07:00 (crosses midnight)", () => {
  assert.equal(isAfterHours(at(21)), true, "9pm is after hours");
  assert.equal(isAfterHours(at(2)), true, "2am is after hours");
  assert.equal(isAfterHours(at(6, 59)), true, "6:59am is after hours");
  assert.equal(isAfterHours(at(7)), false, "7:00am ends the window");
  assert.equal(isAfterHours(at(12)), false, "midday is working hours");
  assert.equal(isAfterHours(at(18, 59)), false, "6:59pm is working hours");
  assert.equal(isAfterHours(at(19)), true, "7:00pm starts the window");
});

test("non-crossing window (start < end)", () => {
  assert.equal(isAfterHours(at(14), "13:00", "15:00"), true);
  assert.equal(isAfterHours(at(12, 59), "13:00", "15:00"), false);
  assert.equal(isAfterHours(at(15), "13:00", "15:00"), false);
});

test("equal start and end disables the window", () => {
  for (const h of [0, 9, 12, 21]) {
    assert.equal(isAfterHours(at(h), "09:00", "09:00"), false, `${h}:00 with zero-length window`);
  }
});

test("malformed times fall back to the 19:00/07:00 defaults", () => {
  assert.equal(isAfterHours(at(21), "banana", "07:00"), true);
  assert.equal(isAfterHours(at(12), "banana", "also-bad"), false);
});
