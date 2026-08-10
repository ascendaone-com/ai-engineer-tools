const { test } = require("node:test");
const assert = require("node:assert/strict");
const { inferOutcome, outcomeForHook } = require("../out/index.js");

// Two outcome functions, two runtimes, and the split is the point:
//
//  - `outcomeForHook` — Claude Code, whose hook model routes success and
//    failure to different events (PostToolUse / PostToolUseFailure) and puts
//    no exit code in either payload. Verified against a live session,
//    27 Jul 2026.
//  - `inferOutcome` — payload-shape inference for adapters whose runtime
//    reports outcome inside the payload. The Codex adapter still uses it;
//    its shapes have NOT been captured from a live Codex run, so these tests
//    pin the function's contract, not Codex's reality. When Codex payloads
//    are captured, test against those and retire whichever branches turn out
//    to be fiction — that is exactly how the Claude-side bug was found.

test("outcomeForHook: PostToolUse is success by arrival — no exit code exists to read", () => {
  const captured = {
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { stdout: "ok", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
    duration_ms: 36
  };
  assert.equal(outcomeForHook("PostToolUse", captured), "success");
});

test("outcomeForHook: PostToolUseFailure is failure; is_interrupt makes it cancelled", () => {
  const captured = {
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    error: "Exit code 1\nnpm error Test failed",
    is_interrupt: false,
    duration_ms: 251
  };
  assert.equal(outcomeForHook("PostToolUseFailure", captured), "failure");
  assert.equal(outcomeForHook("PostToolUseFailure", { ...captured, is_interrupt: true }), "cancelled");
});

test("outcomeForHook: interrupted-on-success reads as cancelled too", () => {
  assert.equal(
    outcomeForHook("PostToolUse", { tool_response: { interrupted: true } }),
    "cancelled"
  );
});

test("outcomeForHook: hooks that carry no outcome stay unknown", () => {
  for (const hook of ["PreToolUse", "Stop", "Notification", "SessionStart"]) {
    assert.equal(outcomeForHook(hook, {}), "unknown", hook);
  }
});

test("inferOutcome: exit codes across payload shapes (Codex contract)", () => {
  assert.equal(inferOutcome({ exitCode: 0 }), "success");
  assert.equal(inferOutcome({ exit_code: 1 }), "failure");
  assert.equal(inferOutcome({ tool_response: { exitCode: 0 } }), "success");
  assert.equal(inferOutcome({ result: { exit_code: 3 } }), "failure");
});

test("inferOutcome: error strings and unknowns (Codex contract)", () => {
  assert.equal(inferOutcome({ error: "boom" }), "failure");
  assert.equal(inferOutcome({ tool_response: { error: "nope" } }), "failure");
  assert.equal(inferOutcome({}), "unknown");
});
