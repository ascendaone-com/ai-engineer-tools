/**
 * The effort classifier: a raw level onto low / medium / high / xhigh / max /
 * unknown. The live Claude Code hooks and the importer both call it, so a
 * level reads the same whichever path recorded it.
 *
 * `undefined` means nothing was reported and the keys are omitted. `unknown`
 * means something was reported that the table doesn't name.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { classifyEffortClass, readSentEffortLevel, recordSentEffortLevel, clearSentEffortLevel } = require("../out/index.js");

test("the levels Claude Code and Codex write", () => {
  const table = [
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
    // Codex's settings below low share its bucket.
    ["minimal", "low"],
    ["none", "low"]
  ];
  for (const [raw, expected] of table) assert.equal(classifyEffortClass(raw), expected, raw);
});

test("case and surrounding whitespace don't matter", () => {
  assert.equal(classifyEffortClass("High"), "high");
  assert.equal(classifyEffortClass("  MEDIUM\n"), "medium");
  assert.equal(classifyEffortClass("XHigh"), "xhigh");
});

test("a level we haven't mapped is unknown, not dropped", () => {
  assert.equal(classifyEffortClass("ultra"), "unknown");
  // Whole-word only: a near miss isn't guessed into a neighbour.
  assert.equal(classifyEffortClass("higher"), "unknown");
  assert.equal(classifyEffortClass("x-high"), "unknown");
  // A non-string from an unityped store was still reported.
  assert.equal(classifyEffortClass(3), "unknown");
  assert.equal(classifyEffortClass({ level: "high" }), "unknown");
});

test("nothing reported is undefined, never medium", () => {
  assert.equal(classifyEffortClass(undefined), undefined);
  assert.equal(classifyEffortClass(null), undefined);
  assert.equal(classifyEffortClass(""), undefined);
  assert.equal(classifyEffortClass("   "), undefined);
});

test("the last-sent level round-trips per agent and session, and clears", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "effort-state-"));
  const previous = process.env.ASCENDA_STATE_DIR;
  process.env.ASCENDA_STATE_DIR = dir;
  try {
    assert.equal(readSentEffortLevel("claude", "s-1"), undefined);
    recordSentEffortLevel("claude", "s-1", "medium");
    assert.equal(readSentEffortLevel("claude", "s-1"), "medium");
    assert.equal(readSentEffortLevel("claude", "s-2"), undefined);
    assert.equal(readSentEffortLevel("codex", "s-1"), undefined);
    recordSentEffortLevel("claude", "s-1", "high");
    assert.equal(readSentEffortLevel("claude", "s-1"), "high");
    clearSentEffortLevel("claude", "s-1");
    assert.equal(readSentEffortLevel("claude", "s-1"), undefined);
    // No session, no state.
    recordSentEffortLevel("claude", undefined, "high");
    assert.equal(readSentEffortLevel("claude", undefined), undefined);
  } finally {
    if (previous === undefined) delete process.env.ASCENDA_STATE_DIR;
    else process.env.ASCENDA_STATE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
