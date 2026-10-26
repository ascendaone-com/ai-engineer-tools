import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHook, withIngest } from "../../scripts/test-support/hookSessionWire.mjs";
import { HOOK_EVENTS } from "../dist/setup.js";
import { copilotRuntimeLines } from "../dist/runtimeCheck.js";

// Inside a subagent, Copilot CLI sends the subagent's id (the parent's
// tool-call id, `call_…`) as `sessionId`. This replays the exact hook
// sequence seen in a VS Code agent-host session with one subagent, ids only.

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const S = "8f15a44f-0000-4000-8000-00000000000a";
const X = "call_PsZfAYl0000000000000000";
const plain = { bold: (t) => t, dim: (t) => t, green: (t) => t, yellow: (t) => t, red: (t) => t, cyan: (t) => t, mark: (tone) => ({ ok: "✓", warn: "!", bad: "✗", info: "·" })[tone], tone: (_, t) => t, enabled: false };

const SEQUENCE = [
  ["userPromptSubmitted", { sessionId: S, prompt: "run the tests" }],
  ["sessionStart", { sessionId: S, source: "new" }],
  ["preToolUse", { sessionId: S, toolCalls: [{ id: "call_a", name: "view", args: {} }] }],
  ["postToolUse", { sessionId: S, toolName: "view", toolArgs: {}, toolResult: { resultType: "success" } }],
  ["subagentStart", { sessionId: S, agentId: X, agentType: "execution-subagent", agentName: "execution-subagent", parentAgentId: S }],
  // The task text the parent gave the subagent. Worded as a correction, so a
  // regression that ships it would also ship an ai_correction_prompt.
  ["userPromptSubmitted", { sessionId: X, agentId: X, agentType: "execution-subagent", parentAgentId: S, prompt: "that is wrong, try again" }],
  ["preToolUse", { sessionId: X, toolCalls: [{ id: "call_b", name: "bash", args: { command: "npm test" } }] }],
  ["postToolUse", { sessionId: X, toolName: "bash", toolArgs: { command: "npm test" }, toolResult: { resultType: "success" } }],
  ["agentStop", { sessionId: X, agentId: X, parentAgentId: S, stopReason: "end_turn" }],
  ["subagentStop", { sessionId: S, agentId: X, parentAgentId: S }],
  ["postToolUse", { sessionId: S, toolName: "task", toolArgs: {}, toolResult: { resultType: "success" } }],
  ["agentStop", { sessionId: S, stopReason: "end_turn" }],
  ["sessionEnd", { sessionId: S, reason: "complete" }]
];

function machine(apiBaseUrl) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-sub-"));
  return {
    home,
    stateDir: path.join(home, "state"),
    env: {
      ...process.env,
      HOME: home,
      ASCENDA_HOME: home,
      ASCENDA_STATE_DIR: path.join(home, "state"),
      ASCENDA_API_BASE_URL: apiBaseUrl,
      ASCENDA_TOOL_INSTALLATION_ID: "cli_agent:sub-0000",
      ASCENDA_EVENT_WRITE_TOKEN: "tok_test",
      ASCENDA_EVENT_WRITE_TOKEN_FILE: path.join(home, "token"),
      ASCENDA_SESSION_ID: "",
      ASCENDA_EVENT_LOG_FILE: "",
      ASCENDA_LIVE_BUS_SOCKET: path.join(home, "no-such.sock")
    }
  };
}

async function replay(sequence, m, received, expected) {
  for (const [hook, input] of sequence) {
    const result = await runHook(cli, hook, { cwd: "/tmp", timestamp: Date.now(), ...input }, m.env);
    assert.equal(result.status, 0, result.stderr);
  }
  const deadline = Date.now() + 10_000;
  while (received.length < expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setTimeout(resolve, 300));
}

test("a subagent's hooks file under the parent session: one human prompt, one turn, its tool calls marked", async () => {
  await withIngest(async (apiBaseUrl, received) => {
    const m = machine(apiBaseUrl);
    await replay(SEQUENCE, m, received, 11);
    const count = (type) => received.filter((payload) => payload.eventType === type).length;

    assert.equal(count("ai_prompt_submitted"), 1, "the subagent's task text isn't a prompt");
    assert.equal(count("ai_correction_prompt"), 0);
    assert.equal(count("ai_turn_completed"), 1, "the subagent's stop isn't a turn");
    assert.equal(count("agent_loop_long"), 0);
    assert.equal(count("ai_tool_call_started"), 2);
    assert.equal(count("ai_tool_call_completed") + count("editor_verification_activity"), 3);

    for (const payload of received) assert.equal(payload.sessionId, S, `${payload.eventType} filed under ${payload.sessionId}`);
    const inside = received.filter((payload) => payload.metadata.subagentId === X).map((payload) => payload.eventType).sort();
    assert.deepEqual(inside, ["ai_tool_call_started", "editor_verification_activity", "subagent_started", "subagent_stopped"]);

    const turn = received.find((payload) => payload.eventType === "ai_turn_completed");
    assert.ok(turn.metadata.durationBucket, "the parent's turn start survived the subagent's prompt and stop");
    // sessionEnd comes after agentStop has closed the turn, so it carries none.
    const promptIds = new Set(received.filter((payload) => payload.eventType !== "recovery_offline_period").map((payload) => payload.metadata.promptId));
    assert.equal(promptIds.size, 1, "the whole turn, subagent included, carries the parent's prompt id");
    assert.ok([...promptIds][0]);

    // Doctor: the record files the subagent under the parent, so a log of the
    // parent session reads as one session with nothing outside the CLI.
    const record = JSON.parse(fs.readFileSync(path.join(m.stateDir, "copilot_cli-sessions.json"), "utf8"));
    assert.deepEqual(Object.keys(record), [S]);
    assert.equal(record[S].events.userPromptSubmitted, 2);

    const root = path.join(m.home, "copilot", "session-state");
    fs.mkdirSync(path.join(root, S), { recursive: true });
    const log = [
      { type: "session.start", data: { sessionId: S } },
      { type: "hook.start", data: { hookType: "postToolUse", input: {} } },
      { type: "hook.end", data: { hookType: "postToolUse", success: true } },
      { type: "subagent.started", data: { toolCallId: X, agentName: "execution-subagent" } }
    ];
    fs.writeFileSync(path.join(root, S, "events.jsonl"), `${log.map((line) => JSON.stringify(line)).join("\n")}\n`);
    fs.writeFileSync(path.join(root, S, "workspace.yaml"), "client_name: vscode-agent-host\n");
    process.env.ASCENDA_STATE_DIR = m.stateDir;
    const out = copilotRuntimeLines({ ui: plain, hookEvents: HOOK_EVENTS, binaryName: "ascenda-copilot-hook", hooksFile: "/x/ascenda.json", root }).join("\n");
    assert.match(out, /vscode-agent-host +1 session, ours ran in 1 \(13 runs, 0 failed\)/);
    assert.doesNotMatch(out, /outside the CLI/);
    fs.rmSync(m.home, { recursive: true, force: true });
  });
});

test("doctor folds an older record that filed a subagent separately, from the parent's log alone", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-fold-"));
  const root = path.join(home, "session-state");
  fs.mkdirSync(path.join(root, S), { recursive: true });
  fs.writeFileSync(path.join(root, S, "events.jsonl"), [
    JSON.stringify({ type: "hook.start", data: { hookType: "subagentStart", input: { agentId: X, prompt: "SENTINEL-not-read" } } }),
    JSON.stringify({ type: "hook.end", data: { hookType: "subagentStart", success: true } })
  ].join("\n"));
  const at = new Date().toISOString();
  const record = { [S]: { firstAt: at, lastAt: at, events: { postToolUse: 10 } }, [X]: { firstAt: at, lastAt: at, events: { postToolUse: 4 } } };
  const out = copilotRuntimeLines({ ui: plain, hookEvents: HOOK_EVENTS, binaryName: "ascenda-copilot-hook", hooksFile: "/x/ascenda.json", root, record, subagentParents: {} }).join("\n");
  assert.match(out, /standalone +1 session, ours ran in 1 \(14 runs, 0 failed\)/);
  assert.doesNotMatch(out, /outside the CLI|SENTINEL/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("an unpaired call_ session is shipped as it arrives, not guessed into a parent", async () => {
  await withIngest(async (apiBaseUrl, received) => {
    const m = machine(apiBaseUrl);
    // The hook was installed mid-session: no subagentStart was seen, and the
    // tool hooks inside the subagent name no parent.
    await replay([
      ["preToolUse", { sessionId: X, toolCalls: [{ id: "call_b", name: "view", args: {} }] }],
      ["postToolUse", { sessionId: X, toolName: "view", toolArgs: {}, toolResult: { resultType: "success" } }]
    ], m, received, 2);
    assert.equal(received.length, 2);
    for (const payload of received) {
      assert.equal(payload.sessionId, X);
      assert.equal(payload.metadata.subagentId, undefined);
    }
    fs.rmSync(m.home, { recursive: true, force: true });
  });
});

test("a hook that names a parentAgentId is a subagent hook even without a pairing", async () => {
  await withIngest(async (apiBaseUrl, received) => {
    const m = machine(apiBaseUrl);
    await replay([
      ["userPromptSubmitted", { sessionId: X, agentId: X, parentAgentId: S, prompt: "do the thing" }],
      ["agentStop", { sessionId: X, agentId: X, parentAgentId: S }]
    ], m, received, 0);
    assert.equal(received.length, 0, "a subagent's prompt and stop send nothing");
    fs.rmSync(m.home, { recursive: true, force: true });
  });
});
