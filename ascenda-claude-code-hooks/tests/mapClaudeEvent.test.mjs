import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewSessionStart, mapClaudeEvent } from "../dist/mapClaudeEvent.js";

// ── Real payload shapes ────────────────────────────────────────────────────
//
// Captured from a live Claude Code session (27 Jul 2026), not invented. A
// successful call carries `tool_response` (stdout/stderr/interrupted/…) and a
// top-level `duration_ms` — and NO exit code anywhere. A failed call arrives
// on a different hook, PostToolUseFailure, carrying `error` (a string
// beginning "Exit code N\n…") and `is_interrupt`, with no tool_response at
// all. The previous fixtures asserted against `tool_response.exitCode`, a
// shape Claude Code never sends — they passed while the adapter was broken,
// which is why these are captured rather than written.

const okResponse = (over = {}) => ({
  stdout: "ok", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, ...over
});

const failurePayload = (over = {}) => ({
  hook_event_name: "PostToolUseFailure",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  duration_ms: 251,
  error: "Exit code 1\nnpm error Test failed",
  is_interrupt: false,
  ...over
});

test("SessionStart: startup and resume open a focus session", () => {
  for (const source of ["startup", "resume", undefined]) {
    const events = mapClaudeEvent("SessionStart", source ? { source } : {});
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "create_focus_session");
  }
});

test("SessionStart: clear and compact are not new sessions", () => {
  assert.deepEqual(mapClaudeEvent("SessionStart", { source: "clear" }), []);
  assert.deepEqual(mapClaudeEvent("SessionStart", { source: "compact" }), []);
});

test("isNewSessionStart matches mapSessionStart's own gate exactly (cli.ts relies on this)", () => {
  assert.equal(isNewSessionStart({ source: "startup" }), true);
  assert.equal(isNewSessionStart({ source: "resume" }), true);
  assert.equal(isNewSessionStart({}), true);
  assert.equal(isNewSessionStart({ source: "clear" }), false);
  assert.equal(isNewSessionStart({ source: "compact" }), false);
});

test("PostToolUse Edit: lines-changed buckets from old_string/new_string, and neither ever leaves the mapper", () => {
  const bigNewText = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
  const events = mapClaudeEvent("PostToolUse", {
    tool_name: "Edit",
    tool_input: { old_string: "one\ntwo", new_string: bigNewText },
    tool_response: okResponse()
  });
  assert.equal(events[0].metadata.linesChangedBucket, "200+");
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("line 0"), "edited content must never leave the mapper");
});

test("PostToolUse Write: lines-changed buckets from content", () => {
  const events = mapClaudeEvent("PostToolUse", {
    tool_name: "Write",
    tool_input: { content: "a\nb\nc\nd\ne\nf" },
    tool_response: okResponse()
  });
  assert.equal(events[0].metadata.linesChangedBucket, "1-10");
});

test("PostToolUse MultiEdit: lines-changed sums across edits", () => {
  const events = mapClaudeEvent("PostToolUse", {
    tool_name: "MultiEdit",
    tool_input: {
      edits: [
        { old_string: "a", new_string: "a\nb\nc" },
        { old_string: "x", new_string: "x\ny\nz\nw" }
      ]
    },
    tool_response: okResponse()
  });
  // max(1,3) + max(1,4) = 3 + 4 = 7 -> bucket 1-10
  assert.equal(events[0].metadata.linesChangedBucket, "1-10");
});

test("PostToolUse: a write-tool payload with no old_string/new_string/content omits the bucket rather than guessing", () => {
  const events = mapClaudeEvent("PostToolUse", { tool_name: "Edit", tool_response: okResponse() });
  assert.equal(events[0].metadata.linesChangedBucket, undefined);
});

test("UserPromptSubmit: plain prompt -> single creation event", () => {
  const events = mapClaudeEvent("UserPromptSubmit", { prompt: "add a login page" });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "ai_prompt_submitted");
  assert.equal(events[0].severity, "low");
});

test("UserPromptSubmit: correction prompt adds supervision event, no raw text", () => {
  const events = mapClaudeEvent("UserPromptSubmit", { prompt: "no, that's still wrong - try again" });
  assert.equal(events.length, 2);
  assert.equal(events[1].eventType, "ai_correction_prompt");
  assert.equal(events[1].metadata.reason, "repeated_reprompting");
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("still wrong"), "prompt text must never leave the mapper");
});

test("PreToolUse: tool call started with sanitised tool name", () => {
  const events = mapClaudeEvent("PreToolUse", { tool_name: "We!rd Name@@" });
  assert.equal(events[0].eventType, "ai_tool_call_started");
  assert.equal(events[0].metadata.toolName, "WerdName");
});

test("PostToolUse: Write/Edit/MultiEdit map to file creation events", () => {
  assert.equal(mapClaudeEvent("PostToolUse", { tool_name: "Write", tool_response: okResponse() })[0].eventType, "ai_file_write");
  assert.equal(mapClaudeEvent("PostToolUse", { tool_name: "Edit", tool_response: okResponse() })[0].eventType, "ai_file_edit");
  assert.equal(mapClaudeEvent("PostToolUse", { tool_name: "MultiEdit", tool_response: okResponse() })[0].eventType, "ai_file_edit");
});

test("PostToolUse: a verification run marks outcome success — the boundary depends on it", () => {
  const events = mapClaudeEvent("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: okResponse(), duration_ms: 4200 });
  assert.equal(events[0].eventType, "editor_verification_activity");
  assert.equal(events[0].metadata.commandClass, "test");
  // The backend derives a verification_pass boundary only from
  // outcome === "success". While inferOutcome returned "unknown" here, the
  // timeline checkpoint cards and get_work_demand_context's checkpoints
  // could never fire from the Claude Code path at all.
  assert.equal(events[0].metadata.outcome, "success");
  assert.equal(events[0].metadata.durationBucket, "0-1m");
});

test("PostToolUse: stderr on a successful call is not a failure", () => {
  // Captured verbatim: a passing command whose stderr carried a shell notice.
  const events = mapClaudeEvent("PostToolUse", {
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: okResponse({ stderr: "\nShell cwd was reset to /repo" })
  });
  assert.equal(events[0].metadata.outcome, "success");
});

test("PostToolUseFailure: failed verification bash -> compile_error (risk)", () => {
  const events = mapClaudeEvent("PostToolUseFailure", failurePayload());
  assert.equal(events[0].eventType, "compile_error");
  assert.equal(events[0].severity, "medium");
  assert.equal(events[0].metadata.outcome, "failure");
});

test("PostToolUseFailure: failed non-verification tool -> ai_tool_call_failed", () => {
  const events = mapClaudeEvent("PostToolUseFailure", failurePayload({ tool_input: { command: "ls -la" } }));
  assert.equal(events[0].eventType, "ai_tool_call_failed");
  assert.equal(events[0].metadata.outcome, "failure");
});

test("interrupted: cancelled is not a failure, and never a compile_error", () => {
  // Stopped work is not wrong work — an interrupted test run proved nothing
  // either way, and the user pressing escape is routine, not risk.
  const events = mapClaudeEvent("PostToolUseFailure", failurePayload({ is_interrupt: true }));
  assert.equal(events[0].eventType, "ai_tool_call_failed");
  assert.equal(events[0].severity, "low");
  assert.equal(events[0].metadata.outcome, "cancelled");
  assert.equal(events[0].metadata.reason, "manual_interrupt");
});

test("PostToolUse: generic successful tool -> ai_tool_call_completed", () => {
  const events = mapClaudeEvent("PostToolUse", { tool_name: "Grep", tool_response: okResponse() });
  assert.equal(events[0].eventType, "ai_tool_call_completed");
  assert.equal(events[0].metadata.outcome, "success");
});

test("PreCompact: manual vs auto compression", () => {
  const manual = mapClaudeEvent("PreCompact", { trigger: "manual" });
  assert.equal(manual[0].eventType, "context_compression_manual");
  const auto = mapClaudeEvent("PreCompact", { trigger: "auto" });
  assert.equal(auto[0].eventType, "context_compression_auto");
  assert.equal(auto[0].severity, "high");
});

test("PostCompact: context pressure signal", () => {
  const events = mapClaudeEvent("PostCompact", {});
  assert.equal(events[0].eventType, "context_pressure_high");
});

test("Stop: only long sessions produce agent_loop_long", () => {
  assert.deepEqual(mapClaudeEvent("Stop", { durationMs: 5 * 60000 }), []);
  const long = mapClaudeEvent("Stop", { durationMs: 45 * 60000 });
  assert.equal(long[0].eventType, "agent_loop_long");
  assert.equal(long[0].severity, "medium");
  const veryLong = mapClaudeEvent("Stop", { durationMs: 90 * 60000 });
  assert.equal(veryLong[0].severity, "high");
});

test("Notification: skipped (no catalog event)", () => {
  assert.deepEqual(mapClaudeEvent("Notification", { message: "hi" }), []);
});

// ── git actions: the boundary signal that never existed ────────────────────
//
// The backend has read a `gitAction` metadata key since the demand view
// shipped, and nothing ever wrote it. So no user could produce a commit or
// push boundary, and `commits_per_day` — the target metric of the
// commit-at-green remedy — was unmeasurable for everyone. These assert the
// write side of that contract, spelling out the exact strings, because the
// consumer is in another repository and cannot be typechecked against.

test("PostToolUse: a successful commit carries gitAction", () => {
  const events = mapClaudeEvent("PostToolUse", {
    tool_name: "Bash",
    tool_input: { command: "git commit -m 'add the thing'" },
    tool_response: okResponse()
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "ai_tool_call_completed");
  assert.equal(events[0].metadata.gitAction, "commit");
  // The backend's commit boundary needs gitAction AND outcome success on the
  // same event — asserting both because the consumer is in another repo.
  assert.equal(events[0].metadata.outcome, "success");
});

test("PostToolUse: a push carries gitAction", () => {
  const events = mapClaudeEvent("PostToolUse", {
    tool_name: "Bash",
    tool_input: { command: "git push origin main" },
    tool_response: okResponse()
  });

  assert.equal(events[0].metadata.gitAction, "push");
});

test("PostToolUse: a reversion is marked as rework", () => {
  const events = mapClaudeEvent("PostToolUse", {
    tool_name: "Bash",
    tool_input: { command: "git revert abc1234" },
    tool_response: okResponse()
  });

  assert.equal(events[0].metadata.gitAction, "revert");
  assert.equal(events[0].metadata.activity, "rework_reversion");
});

test("PostToolUseFailure: a failed push is neither a boundary nor rework", () => {
  // A push that did not land moved nothing. Emitting the boundary anyway
  // would credit work that never left the machine. In the real event model
  // this arrives on PostToolUseFailure — a failed push never reaches
  // PostToolUse at all.
  const events = mapClaudeEvent("PostToolUseFailure", failurePayload({
    tool_input: { command: "git push origin main" },
    error: "Exit code 1\nfatal: unable to access remote"
  }));

  assert.equal(events[0].eventType, "ai_tool_call_failed");
  assert.equal(events[0].metadata.gitAction, undefined);
});

test("interrupted push: cancelled is not a boundary either", () => {
  // An interrupted push proved nothing either way — same rule as failure,
  // different outcome label.
  const events = mapClaudeEvent("PostToolUseFailure", failurePayload({
    tool_input: { command: "git push origin main" },
    is_interrupt: true
  }));

  assert.equal(events[0].metadata.outcome, "cancelled");
  assert.equal(events[0].metadata.gitAction, undefined);
});

test("PostToolUse: an ordinary command carries no gitAction key at all", () => {
  const events = mapClaudeEvent("PostToolUse", {
    tool_name: "Bash",
    tool_input: { command: "git status" },
    tool_response: okResponse()
  });

  // Absent, not null: the field is omitted when there is nothing to say,
  // matching every other optional metadata key.
  assert.ok(!("gitAction" in events[0].metadata));
});
