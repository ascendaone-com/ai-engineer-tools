const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ASCENDA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-turnstate-"));
const { recordTurnStart, consumeTurnDurationMs } = require("../out/index.js");

test("records at prompt, consumes at stop, once", () => {
  recordTurnStart("codex", "sess-1", 1_000_000);
  assert.equal(consumeTurnDurationMs("codex", "sess-1", 1_000_000 + 45 * 60000), 45 * 60000);
  assert.equal(consumeTurnDurationMs("codex", "sess-1", 2_000_000), undefined, "state is consumed on read");
});

test("degrades to undefined on missing or bad state", () => {
  assert.equal(consumeTurnDurationMs("codex", "never-recorded"), undefined);
  assert.equal(consumeTurnDurationMs("codex", undefined), undefined);
  recordTurnStart("codex", "sess-clock", 5_000_000);
  assert.equal(consumeTurnDurationMs("codex", "sess-clock", 4_000_000), undefined, "clock skew rejected");
});

test("session ids are sanitised into file names", () => {
  recordTurnStart("codex", "weird/../id", 1_000);
  assert.equal(consumeTurnDurationMs("codex", "weird/../id", 61_000), 60_000);
  assert.deepEqual(fs.readdirSync(process.env.ASCENDA_STATE_DIR), [], "no stray files outside the state dir");
});

test("agents with the same session id do not consume each other's turns", () => {
  // Two agents running in one workspace can plausibly mint the same session id;
  // without the agent prefix, whichever finished first would eat the other's start.
  recordTurnStart("cursor", "shared-id", 1_000_000);
  recordTurnStart("gemini", "shared-id", 1_000_000);

  assert.equal(consumeTurnDurationMs("cursor", "shared-id", 1_060_000), 60_000);
  assert.equal(consumeTurnDurationMs("gemini", "shared-id", 1_120_000), 120_000, "gemini's turn survived cursor's");
});

test("the agent name is sanitised too", () => {
  recordTurnStart("../evil", "s", 1_000);
  assert.equal(consumeTurnDurationMs("../evil", "s", 2_000), 1_000);
  assert.deepEqual(fs.readdirSync(process.env.ASCENDA_STATE_DIR), []);
});
