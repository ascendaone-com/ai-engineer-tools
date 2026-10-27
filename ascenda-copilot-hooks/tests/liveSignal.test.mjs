import { test } from "node:test";
import assert from "node:assert/strict";

const { liveSignalFor } = await import("../dist/liveSignal.js");

test("the turn opens on the prompt and closes on agentStop; quitting is halted", () => {
  assert.equal(liveSignalFor("userPromptSubmitted", { prompt: "add a retry" }).event, "prompt_submitted");
  assert.ok(liveSignalFor("userPromptSubmitted", { prompt: "add a retry" }).sizeBucket, "a size bucket, never the text");
  assert.deepEqual(liveSignalFor("userPromptSubmitted", {}), { event: "prompt_submitted" });
  assert.deepEqual(liveSignalFor("agentStop", {}), { event: "stop" });
  assert.deepEqual(liveSignalFor("sessionEnd", {}), { event: "halted" });
});

test("tools: one beat per batch, and only a failure speaks after the call", () => {
  assert.deepEqual(liveSignalFor("preToolUse", { toolCalls: [{ name: "view" }, { name: "rg" }] }), { event: "tool_call" });
  assert.equal(liveSignalFor("postToolUse", { toolName: "view", toolResult: { resultType: "success" } }), undefined);
  assert.deepEqual(liveSignalFor("postToolUse", { toolName: "view", toolResult: { resultType: "failure" } }), { event: "tool_failure" });
  assert.deepEqual(liveSignalFor("postToolUseFailure", { toolName: "bash" }), { event: "tool_failure" });
  assert.deepEqual(liveSignalFor("preCompact", {}), { event: "compaction" });
});

test("sessionStart and the subagent hooks are silent", () => {
  for (const hook of ["sessionStart", "subagentStart", "subagentStop", "notification"]) assert.equal(liveSignalFor(hook, {}), undefined, hook);
});
