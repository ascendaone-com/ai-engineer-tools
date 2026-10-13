const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ASCENDA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-turnstate-"));
const { recordTurnStart, consumeTurnDurationMs, readTurnPromptId, withPromptId } = require("../out/index.js");

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

test("the first hook of a turn mints a prompt id and the rest read it back", () => {
  const minted = recordTurnStart("codex", "sess-id", 1_000_000);
  assert.match(minted, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(readTurnPromptId("codex", "sess-id"), minted);
  assert.equal(readTurnPromptId("codex", "sess-id"), minted, "reading doesn't end the turn");
  assert.equal(consumeTurnDurationMs("codex", "sess-id", 1_060_000), 60_000, "the duration still reads past the id");
  assert.equal(readTurnPromptId("codex", "sess-id"), undefined, "the id goes with the turn");
});

test("each turn gets its own id, and the id is not the prompt", () => {
  const first = recordTurnStart("codex", "sess-two", 1_000);
  const second = recordTurnStart("codex", "sess-two", 2_000);
  assert.notEqual(first, second);
  consumeTurnDurationMs("codex", "sess-two", 3_000);
});

test("no session means no id, and an old timestamp-only file reads as no id", () => {
  assert.equal(recordTurnStart("codex", undefined), undefined);
  assert.equal(readTurnPromptId("codex", undefined), undefined);
  fs.writeFileSync(path.join(process.env.ASCENDA_STATE_DIR, "codex-turn-old"), "1000000");
  assert.equal(readTurnPromptId("codex", "old"), undefined);
  assert.equal(consumeTurnDurationMs("codex", "old", 1_030_000), 30_000);
});

test("withPromptId stamps events that have none and leaves an agent's own id alone", () => {
  const stamped = withPromptId([{ eventType: "a", metadata: { x: 1 } }, { eventType: "b", metadata: { promptId: "native" } }, { eventType: "c" }], "minted");
  assert.deepEqual(stamped.map((e) => e.metadata.promptId), ["minted", "native", "minted"]);
  assert.deepEqual(withPromptId([{ eventType: "a" }], undefined), [{ eventType: "a" }]);
});
