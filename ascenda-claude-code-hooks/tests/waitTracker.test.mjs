import "./isolateHome.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceWait, emptyWaitState, IDLE_COOLDOWN_MS, SETTLE_MS, STALE_MS } from "../dist/waitTracker.js";

const S = { session_id: "s1" };
const run = (steps) => {
  let state = emptyWaitState();
  const out = [];
  for (const [at, hook, input = {}] of steps) {
    const r = advanceWait(state, hook, { ...S, ...input }, at);
    state = r.state;
    out.push(r);
  }
  return out;
};
const ended = (rs) => rs.flatMap((r) => r.events).map((e) => e.metadata);

test("a permission prompt ends at the PreToolUse of its tool", () => {
  const rs = run([[0, "PermissionRequest", { tool_name: "Bash" }], [4000, "PreToolUse", { tool_name: "Bash" }]]);
  assert.deepEqual(ended(rs), [{ interruptionKind: "permission_request", waitMs: 4000, waitEndedBy: "tool_started", waitConfidence: "inferred" }]);
});

test("the Notification and PermissionRequest for one prompt are one wait", () => {
  const rs = run([[0, "Notification", { notification_type: "permission_prompt" }], [50, "PermissionRequest", { tool_name: "Edit" }], [3000, "PreToolUse", { tool_name: "Edit" }]]);
  assert.equal(ended(rs).length, 1);
  assert.equal(ended(rs)[0].waitMs, 3000);
});

test("a sibling tool starting alongside the prompt is not the answer", () => {
  const rs = run([[0, "PermissionRequest", { tool_name: "Bash" }], [300, "PreToolUse", { tool_name: "Bash" }], [5000, "PreToolUse", { tool_name: "Bash" }]]);
  assert.equal(ended(rs).length, 1);
  assert.equal(ended(rs)[0].waitMs, 5000);
  assert.ok(300 < SETTLE_MS);
});

test("a different tool starting later doesn't answer a named prompt", () => {
  const rs = run([[0, "PermissionRequest", { tool_name: "Bash" }], [4000, "PreToolUse", { tool_name: "Read" }]]);
  assert.deepEqual(ended(rs), []);
});

test("parallel requests close only when each is answered, and say lower_bound", () => {
  const rs = run([
    [0, "PermissionRequest", { tool_name: "Bash" }], [100, "PermissionRequest", { tool_name: "Bash" }],
    [4000, "PreToolUse", { tool_name: "Bash" }], [6000, "PreToolUse", { tool_name: "Bash" }]
  ]);
  assert.deepEqual(ended(rs), [{ interruptionKind: "permission_request", waitMs: 6000, waitEndedBy: "tool_started", waitConfidence: "lower_bound" }]);
});

test("PermissionDenied answers a prompt", () => {
  const rs = run([[0, "PermissionRequest", { tool_name: "Bash" }], [2500, "PermissionDenied", { tool_name: "Bash" }]]);
  assert.equal(ended(rs)[0].waitEndedBy, "permission_denied");
});

test("a new prompt after an unanswered permission request is an upper bound (interrupt looks the same)", () => {
  const rs = run([[0, "PermissionRequest", { tool_name: "Bash" }], [90000, "UserPromptSubmit"]]);
  assert.deepEqual(ended(rs), [{ interruptionKind: "permission_request", waitMs: 90000, waitEndedBy: "prompt_submitted", waitConfidence: "upper_bound" }]);
});

test("Stop drops a permission wait without reporting a duration", () => {
  const rs = run([[0, "PermissionRequest", { tool_name: "Bash" }], [9000, "Stop"], [20000, "UserPromptSubmit"]]);
  assert.deepEqual(ended(rs), []);
});

test("an idle prompt ends at the next UserPromptSubmit, inferred", () => {
  const rs = run([[0, "Notification", { notification_type: "idle_prompt" }], [120000, "UserPromptSubmit"]]);
  assert.deepEqual(ended(rs), [{ interruptionKind: "idle_prompt", waitMs: 120000, waitEndedBy: "prompt_submitted", waitConfidence: "inferred" }]);
});

test("a burst of idle prompts is one wait, and repeats are flagged for suppression", () => {
  const rs = run([
    [0, "Notification", { notification_type: "idle_prompt" }],
    [30000, "Notification", { notification_type: "idle_prompt" }],
    [60000, "Notification", { notification_type: "idle_prompt" }],
    [200000, "UserPromptSubmit"]
  ]);
  assert.deepEqual(rs.map((r) => r.suppressInterruption), [false, true, true, false]);
  assert.equal(ended(rs).length, 1);
  assert.equal(ended(rs)[0].waitMs, 200000);
});

test("an idle prompt right after the wait closed is inside the cooldown", () => {
  const rs = run([[0, "Notification", { notification_type: "idle_prompt" }], [5000, "UserPromptSubmit"], [10000, "Notification", { notification_type: "idle_prompt" }]]);
  assert.equal(rs[2].suppressInterruption, true);
  assert.ok(10000 < IDLE_COOLDOWN_MS);
});

test("an idle prompt after the cooldown is a new wait", () => {
  const rs = run([[0, "Notification", { notification_type: "idle_prompt" }], [5000, "UserPromptSubmit"], [IDLE_COOLDOWN_MS + 1, "Notification", { notification_type: "idle_prompt" }], [IDLE_COOLDOWN_MS + 9000, "UserPromptSubmit"]]);
  assert.equal(ended(rs).length, 2);
});

test("unknown notifications and a wait older than a day report nothing", () => {
  assert.deepEqual(ended(run([[0, "Notification", { notification_type: "auth_success" }], [5000, "UserPromptSubmit"]])), []);
  assert.deepEqual(ended(run([[0, "PermissionRequest", { tool_name: "Bash" }], [STALE_MS + 1, "UserPromptSubmit"]])), []);
});

test("the event carries no tool name, command or message", () => {
  const rs = run([[0, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "AcmeCorp" } }], [4000, "PreToolUse", { tool_name: "Bash" }]]);
  assert.ok(!JSON.stringify(rs.flatMap((r) => r.events)).includes("Bash"));
});
