import { test } from "node:test";
import assert from "node:assert/strict";
import { mapCodexEvent } from "../dist/mapCodexEvent.js";

test("SessionStart: startup/resume open a focus session, clear/compact do not", () => {
  assert.equal(mapCodexEvent("SessionStart", { source: "startup" })[0].eventType, "create_focus_session");
  assert.equal(mapCodexEvent("SessionStart", { source: "resume" })[0].eventType, "create_focus_session");
  assert.deepEqual(mapCodexEvent("SessionStart", { source: "compact" }), []);
  assert.deepEqual(mapCodexEvent("SessionStart", { source: "clear" }), []);
});

test("UserPromptSubmit: prompt and correction inference, no raw text leaves", () => {
  const plain = mapCodexEvent("UserPromptSubmit", { prompt: "add pagination" });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].eventType, "ai_prompt_submitted");
  const corr = mapCodexEvent("UserPromptSubmit", { prompt: "that is not what I asked, redo it" });
  assert.equal(corr.length, 2);
  assert.equal(corr[1].eventType, "ai_correction_prompt");
  assert.ok(!JSON.stringify(corr).includes("redo it"), "prompt text must never leave the mapper");
});

test("every mapped event carries host=codex metadata", () => {
  const events = mapCodexEvent("PreToolUse", { tool_name: "Bash" });
  assert.equal(events[0].metadata.host, "codex");
});

test("PostToolUse: apply_patch is a file edit", () => {
  const events = mapCodexEvent("PostToolUse", { tool_name: "apply_patch", tool_response: {} });
  assert.equal(events[0].eventType, "ai_file_edit");
});

test("PostToolUse: shell verification success and failure", () => {
  const ok = mapCodexEvent("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exitCode: 0 } });
  assert.equal(ok[0].eventType, "editor_verification_activity");
  const fail = mapCodexEvent("PostToolUse", { tool_name: "shell", tool_input: { command: "cargo test" }, tool_response: { exit_code: 101 } });
  assert.equal(fail[0].eventType, "compile_error");
});

test("PostToolUse: non-verification failure and generic completion", () => {
  const fail = mapCodexEvent("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { exitCode: 1 } });
  assert.equal(fail[0].eventType, "ai_tool_call_failed");
  const done = mapCodexEvent("PostToolUse", { tool_name: "some_mcp_tool", tool_response: {} });
  assert.equal(done[0].eventType, "ai_tool_call_completed");
});

test("compaction: manual vs auto, and post-compact pressure", () => {
  assert.equal(mapCodexEvent("PreCompact", { trigger: "manual" })[0].eventType, "context_compression_manual");
  const auto = mapCodexEvent("PreCompact", { trigger: "auto" });
  assert.equal(auto[0].eventType, "context_compression_auto");
  assert.equal(auto[0].severity, "high");
  assert.equal(mapCodexEvent("PostCompact", {})[0].eventType, "context_pressure_high");
});

test("Stop: agent_loop_long only for long turns", () => {
  assert.deepEqual(mapCodexEvent("Stop", {}, 5 * 60000), []);
  assert.deepEqual(mapCodexEvent("Stop", {}, undefined), []);
  assert.equal(mapCodexEvent("Stop", {}, 45 * 60000)[0].severity, "medium");
  assert.equal(mapCodexEvent("Stop", {}, 90 * 60000)[0].severity, "high");
});

test("hooks without catalog counterparts map to nothing", () => {
  assert.deepEqual(mapCodexEvent("PermissionRequest", { tool_name: "Bash" }), []);
  assert.deepEqual(mapCodexEvent("SubagentStart", { agent_id: "a" }), []);
  assert.deepEqual(mapCodexEvent("SubagentStop", { agent_id: "a" }), []);
});
