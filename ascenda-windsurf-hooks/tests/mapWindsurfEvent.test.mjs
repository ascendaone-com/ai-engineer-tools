import { test } from "node:test";
import assert from "node:assert/strict";

const { mapWindsurfEvent } = await import("../dist/mapWindsurfEvent.js");

const one = (hook, input, turnMs) => {
  const events = mapWindsurfEvent(hook, input, turnMs);
  assert.equal(events.length, 1, `expected exactly one event from ${hook}`);
  return events[0];
};

test("every mapped event carries host=windsurf", () => {
  const hooks = ["pre_user_prompt", "pre_read_code", "post_read_code", "pre_write_code", "post_write_code", "pre_run_command", "post_run_command", "pre_mcp_tool_use", "post_mcp_tool_use"];
  for (const hook of hooks) {
    for (const event of mapWindsurfEvent(hook, { tool_info: { user_prompt: "x", command_line: "npm test", mcp_tool_name: "s" } })) {
      assert.equal(event.metadata.host, "windsurf", `${hook} lost its host tag`);
    }
  }
});

test("pre_user_prompt: payload is nested under tool_info, and text never leaves", () => {
  const plain = mapWindsurfEvent("pre_user_prompt", { tool_info: { user_prompt: "add a retry" } });
  assert.deepEqual(plain.map((e) => e.eventType), ["ai_prompt_submitted"]);

  const correction = mapWindsurfEvent("pre_user_prompt", { tool_info: { user_prompt: "that is wrong, try again" } });
  assert.deepEqual(correction.map((e) => e.eventType), ["ai_prompt_submitted", "ai_correction_prompt"]);
  assert.ok(!JSON.stringify(correction).includes("try again"));
});

test("commands classify from tool_info.command_line", () => {
  assert.equal(one("post_run_command", { tool_info: { command_line: "npm test" } }).eventType, "editor_verification_activity");
  assert.equal(one("post_run_command", { tool_info: { command_line: "git status" } }).eventType, "ai_tool_call_completed");
  assert.equal(one("pre_run_command", { tool_info: { command_line: "npm test" } }).metadata.commandClass, "test");
});

test("post_* hooks carry no exit status, so outcome is honestly unknown", () => {
  // Cascade does not report command results; inventing success would be a lie,
  // and compile_error is therefore unreachable for shell commands.
  assert.equal(one("post_run_command", { tool_info: { command_line: "npm test" } }).metadata.outcome, "unknown");
  assert.equal(one("post_write_code", { tool_info: { file_path: "/a.ts" } }).metadata.outcome, "unknown");
});

test("post_write_code is a file edit", () => {
  assert.equal(one("post_write_code", { tool_info: { file_path: "/a.ts" } }).eventType, "ai_file_edit");
});

test("MCP results are the only failure Cascade exposes", () => {
  const failed = one("post_mcp_tool_use", { tool_info: { mcp_tool_name: "search", mcp_result: { isError: true } } });
  assert.equal(failed.eventType, "ai_tool_call_failed");
  assert.equal(failed.metadata.outcome, "failure");

  const ok = one("post_mcp_tool_use", { tool_info: { mcp_tool_name: "search", mcp_result: { content: "hits" } } });
  assert.equal(ok.eventType, "ai_tool_call_completed");

  // Free-form results must not be guessed at.
  assert.equal(one("post_mcp_tool_use", { tool_info: { mcp_tool_name: "s", mcp_result: { error: "" } } }).eventType, "ai_tool_call_completed");
});

test("mcp tool names are prefixed and sanitised", () => {
  assert.equal(one("pre_mcp_tool_use", { tool_info: { mcp_tool_name: "we!!ird/name" } }).metadata.toolName, "mcp_weirdname");
  assert.equal(one("pre_mcp_tool_use", { tool_info: {} }).metadata.toolName, "mcp_tool");
});

test("post_cascade_response ends the turn; only long ones are a signal", () => {
  assert.deepEqual(mapWindsurfEvent("post_cascade_response", {}, 120000), []);
  assert.equal(one("post_cascade_response", {}, 45 * 60000).eventType, "agent_loop_long");
});

test("transcript and worktree hooks map to nothing", () => {
  // post_cascade_response_with_transcript repeats the turn end and points at
  // raw conversation content, which this tool never reads.
  assert.deepEqual(mapWindsurfEvent("post_cascade_response_with_transcript", { tool_info: { transcript_path: "/t.jsonl" } }, 45 * 60000), []);
  assert.deepEqual(mapWindsurfEvent("post_setup_worktree", { tool_info: { worktree_path: "/w" } }), []);
});
