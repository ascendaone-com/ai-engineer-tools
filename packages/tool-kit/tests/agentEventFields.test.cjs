const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toAgentEvent } = require("../out");

function wire(eventType, metadata, extra = {}) {
  return { source: "claude_code", eventType, occurredAt: "2026-10-14T01:02:03.000Z", idempotencyKey: `k-${eventType}`, sessionId: "s1", metadata: { host: "claude_code", ...metadata }, ...extra };
}

test("the keys and the prompt id ride onto the public event", () => {
  const event = toAgentEvent(wire("ai_tool_call_started", { toolName: "Bash", repoKey: "a1b2c3d4", branchKey: "a1b2c3d4e5f60718", promptId: "p-1" }));
  assert.equal(event.repoKey, "a1b2c3d4");
  assert.equal(event.branchKey, "a1b2c3d4e5f60718");
  assert.equal(event.promptId, "p-1");
});

test("a commit or push on a completed tool call is a vcsAction", () => {
  assert.equal(toAgentEvent(wire("ai_tool_call_completed", { gitAction: "commit" })).vcsAction, "commit");
  assert.equal(toAgentEvent(wire("ai_tool_call_completed", { gitAction: "push" })).vcsAction, "push");
});

test("an opened or merged pull request is a vcsAction, and the milestone wins over the push that carried it", () => {
  assert.equal(toAgentEvent(wire("ai_tool_call_completed", { milestoneKind: "pr_opened" })).vcsAction, "pr_created");
  assert.equal(toAgentEvent(wire("ai_tool_call_completed", { milestoneKind: "pr_merged" })).vcsAction, "pr_merged");
  assert.equal(toAgentEvent(wire("ai_tool_call_completed", { gitAction: "push", milestoneKind: "pr_opened" })).vcsAction, "pr_created");
});

test("reversions, resets and closed issues are not vcsActions, and neither is anything off tool.completed", () => {
  for (const gitAction of ["amend", "revert", "reset_hard", "restore"]) {
    assert.equal("vcsAction" in toAgentEvent(wire("ai_tool_call_completed", { gitAction })), false, gitAction);
  }
  assert.equal("vcsAction" in toAgentEvent(wire("ai_tool_call_completed", { milestoneKind: "issue_closed" })), false);
  assert.equal("vcsAction" in toAgentEvent(wire("ai_tool_call_started", { gitAction: "commit" })), false);
});

test("a wait says why", () => {
  const reasonOf = (interruptionKind) => toAgentEvent(wire("supervision_interruption", { interruptionKind })).reason;
  assert.equal(reasonOf("permission_request"), "permission");
  assert.equal(reasonOf("idle_prompt"), "idle");
  assert.equal(reasonOf("other"), "other");
  assert.equal(reasonOf("something_new"), "other");
  assert.equal("reason" in toAgentEvent(wire("supervision_interruption", {})), false);
});

test("the wire's own reason is not the public reason", () => {
  // A failed tool call carries reason: "tool_failure" for the backend. That
  // is not why an agent waited, and must not be shown as if it were.
  assert.equal("reason" in toAgentEvent(wire("ai_tool_call_failed", { reason: "tool_failure" })), false);
});

test("a session start carries the model slug", () => {
  assert.equal(toAgentEvent(wire("create_focus_session", { modelId: "claude-opus-5-5", modelClass: "anthropic:opus" })).model, "claude-opus-5-5");
  assert.equal("model" in toAgentEvent(wire("ai_prompt_submitted", { modelId: "claude-opus-5-5" })), false);
  assert.equal("model" in toAgentEvent(wire("create_focus_session", {})), false);
});
