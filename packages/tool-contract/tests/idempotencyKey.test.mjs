import { test } from "node:test";
import assert from "node:assert/strict";
import { IDEMPOTENCY_KEY_MAX_LENGTH, TOOL_EVENT_DELIVERED_STATUSES } from "../out/index.js";

/**
 * Pins the two constants the ingest doors define for the idempotencyKey
 * contract (issues #50 / #51; backend asc-core-be#141). Neither is derivable
 * from anything in this repo — both are the backend's numbers, and a change
 * here that the backend did not make is a bug, not a decision.
 *
 * The wire-vocabulary guard next door pins event-type names only, not payload
 * shape, so the payload additions get their own tripwire.
 */

test("the key limit is the backend's 128 — longer is validation_failed, not truncated", () => {
  assert.equal(IDEMPOTENCY_KEY_MAX_LENGTH, 128);
});

test("a v4 UUID fits the limit with room to spare", () => {
  // 36 characters. If a future collector ever wants a structured key, this is
  // the ceiling it has to stay under.
  assert.ok("6f1c2b4e-1d5a-4c2e-9f31-8b0a7d6e5c44".length <= IDEMPOTENCY_KEY_MAX_LENGTH);
});

test("accepted and duplicate are the only two delivered statuses, and both count", () => {
  assert.deepEqual([...TOOL_EVENT_DELIVERED_STATUSES].sort(), ["accepted", "duplicate"]);
});
