import { test } from "node:test";
import assert from "node:assert/strict";

const { mapCopilotEvent } = await import("../dist/mapCopilotEvent.js");

// Payloads in the shape Copilot CLI was seen to send (hook.start inputs in a
// session's events.jsonl), not the shape its reference describes.

const one = (hook, input, turnMs) => {
  const events = mapCopilotEvent(hook, input, turnMs);
  assert.equal(events.length, 1, `expected exactly one event from ${hook}`);
  return events[0];
};

const post = (toolName, toolArgs, resultType = "success") => ({
  sessionId: "s1", timestamp: 1761000000000, cwd: "/p", toolName, toolArgs,
  toolResult: { resultType, textResultForLlm: "ignored", toolTelemetry: {} }
});

test("every mapped event carries host=copilot_cli", () => {
  for (const hook of ["sessionStart", "sessionEnd", "userPromptSubmitted", "preToolUse", "postToolUse", "postToolUseFailure", "preCompact", "subagentStart", "subagentStop", "agentStop"]) {
    const events = mapCopilotEvent(hook, { prompt: "x", toolName: "bash", toolCalls: [{ id: "c1", name: "view", args: {} }] });
    assert.ok(events.length > 0, `${hook} mapped to nothing`);
    for (const event of events) assert.equal(event.metadata.host, "copilot_cli", `${hook} lost its host tag`);
  }
});

test("preToolUse is batched: one ai_tool_call_started per element of toolCalls", () => {
  const events = mapCopilotEvent("preToolUse", {
    sessionId: "s1", cwd: "/p",
    toolCalls: [{ id: "a", name: "view", args: { path: "/p/a.ts" } }, { id: "b", name: "rg", args: { pattern: "x" } }, { id: "c", name: "glob", args: { pattern: "*.ts" } }]
  });
  assert.deepEqual(events.map((e) => e.eventType), ["ai_tool_call_started", "ai_tool_call_started", "ai_tool_call_started"]);
  assert.deepEqual(events.map((e) => e.metadata.toolName), ["view", "rg", "glob"]);
  assert.ok(!JSON.stringify(events).includes("/p/a.ts"), "arguments never leave");

  assert.deepEqual(mapCopilotEvent("preToolUse", { toolCalls: [] }), [], "an empty batch starts nothing");
  assert.equal(one("preToolUse", { toolName: "bash", toolArgs: {} }).metadata.toolName, "bash", "the reference's single-call shape still maps");
});

test("postToolUse: create is a write, edit is an edit", () => {
  assert.equal(one("postToolUse", post("create", { path: "/p/new.ts", file_text: "x" })).eventType, "ai_file_write");
  assert.equal(one("postToolUse", post("edit", { path: "/p/a.ts", old_str: "a", new_str: "b" })).eventType, "ai_file_edit");
});

test("postToolUse: bash verification, success and failure", () => {
  const ok = one("postToolUse", post("bash", { command: "npm test", description: "run tests" }));
  assert.equal(ok.eventType, "editor_verification_activity");
  assert.equal(ok.metadata.outcome, "success");
  assert.ok(!JSON.stringify(ok).includes("npm test"), "command text never leaves");

  const failed = one("postToolUse", post("bash", { command: "npm test" }, "failure"));
  assert.equal(failed.eventType, "compile_error");
  assert.equal(one("postToolUseFailure", { toolName: "bash", toolArgs: { command: "pytest -q" } }).eventType, "compile_error");
});

test("postToolUse: a committed change carries the git action, only on success", () => {
  const commit = one("postToolUse", post("bash", { command: "git commit -m x" }));
  assert.equal(commit.eventType, "ai_tool_call_completed");
  assert.equal(commit.metadata.gitAction, "commit");
  assert.equal(one("postToolUse", post("bash", { command: "git commit -m x" }, "failure")).metadata.gitAction, undefined);
});

test("postToolUse: toolArgs sent as a JSON string still reads its command", () => {
  assert.equal(one("postToolUse", post("bash", JSON.stringify({ command: "npm test" }))).eventType, "editor_verification_activity");
});

test("postToolUse: the outcome comes from toolResult.resultType", () => {
  assert.equal(one("postToolUse", post("view", { path: "/p" })).metadata.outcome, "success");
  assert.equal(one("postToolUse", post("view", { path: "/p" }, "failure")).eventType, "ai_tool_call_failed");
  assert.equal(one("postToolUse", post("view", { path: "/p" }, "rejected")).metadata.outcome, "cancelled");
  assert.equal(one("postToolUse", { toolName: "view" }).metadata.outcome, "unknown");
  // A refused edit changed nothing.
  assert.equal(one("postToolUse", post("edit", { path: "/p/a.ts" }, "denied")).eventType, "ai_tool_call_completed");
});

test("postToolUseFailure: anything other than a verification command is a tool failure", () => {
  const event = one("postToolUseFailure", { toolName: "view", toolArgs: { path: "/missing" } });
  assert.equal(event.eventType, "ai_tool_call_failed");
  assert.equal(event.metadata.reason, "tool_failure");
});

test("userPromptSubmitted: prompt and correction inference, no raw text leaves", () => {
  assert.deepEqual(mapCopilotEvent("userPromptSubmitted", { prompt: "add a retry" }).map((e) => e.eventType), ["ai_prompt_submitted"]);
  const correction = mapCopilotEvent("userPromptSubmitted", { prompt: "that is wrong, try again" });
  assert.deepEqual(correction.map((e) => e.eventType), ["ai_prompt_submitted", "ai_correction_prompt"]);
  assert.ok(!JSON.stringify(correction).includes("try again"));
});

test("agentStop: every turn completes, and a long one is flagged first", () => {
  assert.deepEqual(mapCopilotEvent("agentStop", { stopReason: "end_turn" }, 120000).map((e) => e.eventType), ["ai_turn_completed"]);
  assert.deepEqual(mapCopilotEvent("agentStop", {}, 45 * 60000).map((e) => e.eventType), ["agent_loop_long", "ai_turn_completed"]);
  assert.equal(mapCopilotEvent("agentStop", {}, 90 * 60000)[0].severity, "high");
  assert.equal(one("agentStop", {}).metadata.durationBucket, undefined, "no recorded turn start, no bucket");
});

test("preCompact: auto unless the trigger says manual", () => {
  assert.equal(one("preCompact", {}).eventType, "context_compression_auto");
  assert.equal(one("preCompact", { trigger: "manual" }).eventType, "context_compression_manual");
});

test("unregistered hooks map to nothing", () => {
  for (const hook of ["userPromptTransformed", "permissionRequest", "notification", "errorOccurred", "PostToolUse"]) {
    assert.deepEqual(mapCopilotEvent(hook, { prompt: "x", toolName: "bash" }), [], hook);
  }
});

test("inside a subagent: prompt and stop map to nothing, everything else carries subagentId", () => {
  assert.deepEqual(mapCopilotEvent("userPromptSubmitted", { prompt: "that is wrong" }, undefined, "call_x"), []);
  assert.deepEqual(mapCopilotEvent("agentStop", {}, 90 * 60000, "call_x"), []);
  const [started] = mapCopilotEvent("preToolUse", { toolCalls: [{ name: "bash" }] }, undefined, "call_x");
  assert.equal(started.metadata.subagentId, "call_x");
  assert.equal(started.metadata.host, "copilot_cli");
});

test("subagentStart and subagentStop name the subagent by its agentId, never its name", () => {
  const event = one("subagentStart", { sessionId: "s", agentId: "call_x", agentName: "execution-subagent", parentAgentId: "s" });
  assert.equal(event.metadata.subagentId, "call_x");
  assert.ok(!JSON.stringify(event).includes("execution"));
  assert.equal(one("subagentStop", { agentId: "not an id!" }).metadata.subagentId, undefined);
});
