import { test } from "node:test";
import assert from "node:assert/strict";
import { mapClaudeEvent } from "../dist/mapClaudeEvent.js";

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
  assert.equal(mapClaudeEvent("PostToolUse", { tool_name: "Write", tool_response: { exitCode: 0 } })[0].eventType, "ai_file_write");
  assert.equal(mapClaudeEvent("PostToolUse", { tool_name: "Edit", tool_response: { exitCode: 0 } })[0].eventType, "ai_file_edit");
  assert.equal(mapClaudeEvent("PostToolUse", { tool_name: "MultiEdit", tool_response: { exitCode: 0 } })[0].eventType, "ai_file_edit");
});

test("PostToolUse: successful verification bash -> editor_verification_activity", () => {
  const events = mapClaudeEvent("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exitCode: 0 } });
  assert.equal(events[0].eventType, "editor_verification_activity");
  assert.equal(events[0].metadata.commandClass, "test");
});

test("PostToolUse: failed verification bash -> compile_error (risk)", () => {
  const events = mapClaudeEvent("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exitCode: 1 } });
  assert.equal(events[0].eventType, "compile_error");
  assert.equal(events[0].severity, "medium");
});

test("PostToolUse: failed non-verification tool -> ai_tool_call_failed", () => {
  const events = mapClaudeEvent("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls -la" }, tool_response: { exitCode: 2 } });
  assert.equal(events[0].eventType, "ai_tool_call_failed");
});

test("PostToolUse: generic successful tool -> ai_tool_call_completed", () => {
  const events = mapClaudeEvent("PostToolUse", { tool_name: "Grep", tool_response: { exitCode: 0 } });
  assert.equal(events[0].eventType, "ai_tool_call_completed");
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
