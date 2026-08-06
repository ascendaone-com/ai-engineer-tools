import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeForHook, looksLikeCorrection, getString, getNestedString } from "../dist/safeExtract.js";

// This adapter derives outcome from *which hook fired*, not from the payload
// (see outcomeForHook in @ascenda-one/tool-kit, and docs/CLAUDE_MAPPING.md
// "Outcome comes from the event"). inferOutcome — payload-shape inference,
// still used by the Codex adapter — is tested in
// packages/tool-kit/tests/payload.test.cjs, not here, because this package
// deliberately no longer calls it.

// Captured from a live Claude Code session, 27 Jul 2026.
const successPayload = {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "npm test", description: "Run test suite" },
  tool_response: {
    stdout: "All tests passed",
    // A successful call routinely carries stderr — a shell notice here.
    stderr: "\nShell cwd was reset to /repo",
    interrupted: false,
    isImage: false,
    noOutputExpected: false
  },
  tool_use_id: "toolu_015QMp4tK56CNYH6Waz8zDW6",
  duration_ms: 36
};

const failurePayload = {
  hook_event_name: "PostToolUseFailure",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  tool_use_id: "toolu_01xyz",
  duration_ms: 251,
  // No tool_response at all; the exit code lives inside a string.
  error: "Exit code 254\nnpm error code ENOENT",
  is_interrupt: false
};

test("outcomeForHook: the event carries the outcome, not the payload", () => {
  // There is no exit code or status field anywhere in a PostToolUse payload —
  // its arrival is itself the success signal, because a failed call is routed
  // to PostToolUseFailure and never reaches PostToolUse.
  assert.equal(outcomeForHook("PostToolUse", successPayload), "success");
  assert.equal(outcomeForHook("PostToolUseFailure", failurePayload), "failure");
});

test("outcomeForHook: stderr on a successful call is not a failure", () => {
  assert.ok(successPayload.tool_response.stderr.length > 0);
  assert.equal(outcomeForHook("PostToolUse", successPayload), "success");
});

test("outcomeForHook: an interrupted call is cancelled, not failed", () => {
  assert.equal(
    outcomeForHook("PostToolUseFailure", { ...failurePayload, is_interrupt: true }),
    "cancelled"
  );
  assert.equal(
    outcomeForHook("PostToolUse", {
      ...successPayload,
      tool_response: { ...successPayload.tool_response, interrupted: true }
    }),
    "cancelled"
  );
});

test("outcomeForHook: other hooks stay unknown", () => {
  assert.equal(outcomeForHook("PreToolUse", {}), "unknown");
  assert.equal(outcomeForHook("Stop", {}), "unknown");
  assert.equal(outcomeForHook("Notification", {}), "unknown");
});

test("looksLikeCorrection: positive and negative phrases", () => {
  for (const t of ["that's wrong", "incorrect output", "try again please", "fix the import", "redo this", "it doesn't work"]) {
    assert.equal(looksLikeCorrection(t), true, t);
  }
  for (const t of ["add a new endpoint", "looks great, continue", "write tests for the parser", undefined, ""]) {
    assert.equal(looksLikeCorrection(t), false, String(t));
  }
});

test("getString / getNestedString: first non-empty wins", () => {
  assert.equal(getString({ a: "", b: "x" }, ["a", "b"]), "x");
  assert.equal(getString({}, ["a"]), undefined);
  assert.equal(getNestedString({ p: { q: "deep" } }, [["missing", "x"], ["p", "q"]]), "deep");
});
