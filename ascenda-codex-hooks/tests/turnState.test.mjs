import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ASCENDA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-turnstate-"));
const { recordTurnStart, consumeTurnDurationMs } = await import("../dist/turnState.js");

test("records at prompt, consumes at stop, once", () => {
  recordTurnStart("sess-1", 1_000_000);
  assert.equal(consumeTurnDurationMs("sess-1", 1_000_000 + 45 * 60000), 45 * 60000);
  assert.equal(consumeTurnDurationMs("sess-1", 2_000_000), undefined, "state is consumed on read");
});

test("degrades to undefined on missing or bad state", () => {
  assert.equal(consumeTurnDurationMs("never-recorded"), undefined);
  assert.equal(consumeTurnDurationMs(undefined), undefined);
  recordTurnStart("sess-clock", 5_000_000);
  assert.equal(consumeTurnDurationMs("sess-clock", 4_000_000), undefined, "clock skew rejected");
});

test("session ids are sanitised into file names", () => {
  recordTurnStart("weird/../id", 1_000);
  assert.equal(consumeTurnDurationMs("weird/../id", 61_000), 60_000);
  const leftovers = fs.readdirSync(process.env.ASCENDA_STATE_DIR);
  assert.deepEqual(leftovers, [], "no stray files outside the state dir");
});
