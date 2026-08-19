import { test } from "node:test";
import assert from "node:assert/strict";

const { mapGeminiEvent } = await import("../dist/mapGeminiEvent.js");

const one = (hook, input, turnMs) => {
  const events = mapGeminiEvent(hook, input, turnMs);
  assert.equal(events.length, 1, `expected exactly one event from ${hook}`);
  return events[0];
};

test("every mapped event carries host=gemini_cli", () => {
  for (const hook of ["SessionStart", "SessionEnd", "BeforeAgent", "BeforeTool", "AfterTool", "PreCompress"]) {
    for (const event of mapGeminiEvent(hook, { prompt: "x", tool_name: "run_shell_command" })) {
      assert.equal(event.metadata.host, "gemini_cli", `${hook} lost its host tag`);
    }
  }
});

test("BeforeAgent: prompt and correction inference, no raw text leaves", () => {
  assert.deepEqual(mapGeminiEvent("BeforeAgent", { prompt: "add a retry" }).map((e) => e.eventType), ["ai_prompt_submitted"]);

  const correction = mapGeminiEvent("BeforeAgent", { prompt: "that is wrong, try again" });
  assert.deepEqual(correction.map((e) => e.eventType), ["ai_prompt_submitted", "ai_correction_prompt"]);
  assert.ok(!JSON.stringify(correction).includes("try again"));
});

test("AfterTool: shell verification success and failure", () => {
  const ok = one("AfterTool", { tool_name: "run_shell_command", tool_input: { command: "pytest -q" }, tool_response: { exitCode: 0 } });
  assert.equal(ok.eventType, "editor_verification_activity");
  assert.equal(ok.metadata.commandClass, "test");

  const failed = one("AfterTool", { tool_name: "run_shell_command", tool_input: { command: "npm run lint" }, tool_response: { exitCode: 1 } });
  assert.equal(failed.eventType, "compile_error");
  assert.equal(failed.metadata.commandClass, "lint");
});

test("AfterTool: Gemini's own file tool names", () => {
  // write_file creates or overwrites; replace is the in-place edit tool.
  assert.equal(one("AfterTool", { tool_name: "write_file", tool_response: { exitCode: 0 } }).eventType, "ai_file_write");
  assert.equal(one("AfterTool", { tool_name: "replace", tool_response: { exitCode: 0 } }).eventType, "ai_file_edit");
});

test("AfterTool: non-verification failure is a tool failure, not a compile error", () => {
  const event = one("AfterTool", { tool_name: "web_fetch", tool_response: { error: "timeout" } });
  assert.equal(event.eventType, "ai_tool_call_failed");
  assert.equal(event.metadata.reason, "tool_failure");
});

test("session boundaries and compaction", () => {
  assert.equal(one("SessionStart", {}).eventType, "create_focus_session");
  assert.equal(one("SessionEnd", {}).eventType, "recovery_offline_period");
  assert.equal(one("PreCompress", {}).eventType, "context_compression_auto");
});

test("AfterAgent ends the turn; only long ones are a signal", () => {
  assert.deepEqual(mapGeminiEvent("AfterAgent", { prompt: "x" }, 120000), []);
  assert.equal(one("AfterAgent", { prompt: "x" }, 90 * 60000).severity, "high");
});

test("per-inference hooks map to nothing", () => {
  // BeforeModel/AfterModel fire on every LLM round trip. Mapping them would
  // multiply volume for signal the tool hooks already carry.
  for (const hook of ["BeforeModel", "AfterModel", "BeforeToolSelection", "Notification"]) {
    assert.deepEqual(mapGeminiEvent(hook, { llm_request: {}, llm_response: {} }), []);
  }
});
