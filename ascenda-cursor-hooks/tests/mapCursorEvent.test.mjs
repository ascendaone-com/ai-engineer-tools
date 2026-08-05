import { test } from "node:test";
import assert from "node:assert/strict";

const { mapCursorEvent } = await import("../dist/mapCursorEvent.js");

const one = (hook, input, turnMs) => {
  const events = mapCursorEvent(hook, input, turnMs);
  assert.equal(events.length, 1, `expected exactly one event from ${hook}`);
  return events[0];
};

test("every mapped event carries host=cursor", () => {
  for (const hook of ["sessionStart", "sessionEnd", "beforeSubmitPrompt", "preToolUse", "postToolUse", "postToolUseFailure", "preCompact"]) {
    for (const event of mapCursorEvent(hook, { prompt: "x", tool_name: "Shell" })) {
      assert.equal(event.metadata.host, "cursor", `${hook} lost its host tag`);
    }
  }
});

test("beforeSubmitPrompt: prompt and correction inference, no raw text leaves", () => {
  const plain = mapCursorEvent("beforeSubmitPrompt", { prompt: "add a retry" });
  assert.deepEqual(plain.map((e) => e.eventType), ["ai_prompt_submitted"]);

  const correction = mapCursorEvent("beforeSubmitPrompt", { prompt: "that is wrong, try again" });
  assert.deepEqual(correction.map((e) => e.eventType), ["ai_prompt_submitted", "ai_correction_prompt"]);

  const serialised = JSON.stringify(correction);
  assert.ok(!serialised.includes("try again"), "prompt text must never reach the payload");
});

test("postToolUse: exit code lives inside tool_output as a JSON string", () => {
  const ok = one("postToolUse", { tool_name: "Shell", tool_input: { command: "npm test" }, tool_output: '{"exitCode":0}', duration: 42000 });
  assert.equal(ok.eventType, "editor_verification_activity");
  assert.equal(ok.metadata.outcome, "success");
  assert.equal(ok.metadata.commandClass, "test");
  assert.equal(ok.metadata.durationBucket, "0-1m");

  const failed = one("postToolUse", { tool_name: "Shell", tool_input: { command: "npm test" }, tool_output: '{"exitCode":1}' });
  assert.equal(failed.eventType, "compile_error");
  assert.equal(failed.metadata.reason, "test_failure");
});

test("postToolUse: unparseable tool_output degrades to unknown, never crashes", () => {
  const event = one("postToolUse", { tool_name: "Shell", tool_input: { command: "ls" }, tool_output: "not json at all" });
  assert.equal(event.eventType, "ai_tool_call_completed");
  assert.equal(event.metadata.outcome, "unknown");
});

test("postToolUse: file tools become write/edit events", () => {
  assert.equal(one("postToolUse", { tool_name: "Write", tool_output: '{"exitCode":0}' }).eventType, "ai_file_write");
  assert.equal(one("postToolUse", { tool_name: "Edit", tool_output: '{"exitCode":0}' }).eventType, "ai_file_edit");
  assert.equal(one("postToolUse", { tool_name: "search_replace", tool_output: '{"exitCode":0}' }).eventType, "ai_file_edit");
});

test("postToolUseFailure: a user interrupt is not a tool failure", () => {
  const interrupted = one("postToolUseFailure", { tool_name: "Shell", tool_input: { command: "npm run dev" }, is_interrupt: true });
  assert.equal(interrupted.eventType, "ai_tool_call_failed");
  assert.equal(interrupted.metadata.outcome, "cancelled");
  assert.equal(interrupted.metadata.reason, "manual_interrupt");
  assert.equal(interrupted.severity, "low", "cancelling your own agent is not a risk signal");

  const genuine = one("postToolUseFailure", { tool_name: "Shell", tool_input: { command: "npm run build" }, is_interrupt: false });
  assert.equal(genuine.eventType, "compile_error");
  assert.equal(genuine.severity, "medium");
});

test("preCompact: manual and auto are different signals", () => {
  assert.equal(one("preCompact", { trigger: "auto" }).eventType, "context_compression_auto");
  assert.equal(one("preCompact", { trigger: "manual" }).eventType, "context_compression_manual");
});

test("stop: agent_loop_long only for long turns", () => {
  assert.deepEqual(mapCursorEvent("stop", { status: "completed" }, 120000), []);
  assert.equal(one("stop", { status: "completed" }, 45 * 60000).metadata.durationBucket, "30-60m");
  assert.equal(one("stop", { status: "completed" }, 90 * 60000).severity, "high");
});

test("specialised shell/MCP/file hooks map to nothing, so nothing double-counts", () => {
  // preToolUse/postToolUse already report these; mapping both would emit twice.
  for (const hook of ["beforeShellExecution", "afterShellExecution", "beforeMCPExecution", "afterMCPExecution", "afterFileEdit", "beforeReadFile"]) {
    assert.deepEqual(mapCursorEvent(hook, { command: "npm test", file_path: "/a.ts" }), [], `${hook} must not double-count`);
  }
});

test("hooks without catalog counterparts map to nothing", () => {
  for (const hook of ["subagentStart", "subagentStop", "afterAgentResponse", "afterAgentThought", "workspaceOpen", "beforeTabFileRead", "afterTabFileEdit"]) {
    assert.deepEqual(mapCursorEvent(hook, {}), []);
  }
});
