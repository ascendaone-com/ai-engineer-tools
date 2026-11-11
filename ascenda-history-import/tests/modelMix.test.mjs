/**
 * The model mix, the route and the main-thread call counts, folded per
 * session out of Claude Code and Codex stores.
 *
 *  - `modelTurns`: the bounded per-model map beside `primaryModel`.
 *  - `modelRoute`: who served the model, one word, never a name or host.
 *  - `mainThreadToolCallCount` / `mainThreadToolFailureCount`: the pair a
 *    failure rate divides. `toolFailureCount` adds subagent failures and API
 *    errors and keeps that meaning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { extractCodex } from "../dist/extractors/codex.js";
import { buildCodexHandoff, buildHandoff } from "../dist/localHandoff.js";
import { toWirePayload } from "../dist/ship.js";
import { MODEL_TURNS_CAP, modelTurnsMetrics, parseModelTurns } from "../dist/modelTurns.js";

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const SESSION = "0f0e0d0c-1111-2222-3333-444455556677";
const base = { sessionId: SESSION, version: "2.1.280", cwd: "/Users/example/Dev/testproj" };

const user = (timestamp, content = "redacted", extra = {}) =>
  JSON.stringify({ type: "user", timestamp, ...base, ...extra, message: { role: "user", content } });
const assistant = (timestamp, model, content = [], extra = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp,
    ...base,
    ...extra,
    message: { id: `msg-${timestamp}`, role: "assistant", model, content, usage: { input_tokens: 1, output_tokens: 1 } }
  });
const toolUse = (id) => ({ type: "tool_use", id, name: "Bash", input: { command: "redacted" } });
const toolResult = (id, isError) => ({ type: "tool_result", tool_use_id: id, content: "redacted", ...(isError ? { is_error: true } : {}) });

async function claudeSession(lines, subagentLines = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "modelmix-claude-"));
  try {
    const projectDir = path.join(dir, "projects", "testproj");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, `${SESSION}.jsonl`), lines.join("\n") + "\n", "utf8");
    if (subagentLines.length > 0) {
      const subDir = path.join(projectDir, SESSION, "subagents");
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(subDir, "agent-a1.jsonl"), subagentLines.join("\n") + "\n", "utf8");
    }
    const events = await collect(extractClaudeCode(dir, "x-modelmix"));
    return { events, session: events.find((e) => e.eventKind === "create_focus_session") };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("claude code: the mix, and main-thread calls and failures on one basis", async () => {
  const { events, session } = await claudeSession(
    [
      user("2026-11-10T10:00:00.000Z"),
      assistant("2026-11-10T10:00:01.000Z", "claude-opus-5", [toolUse("t1"), toolUse("t2")]),
      user("2026-11-10T10:00:02.000Z", [toolResult("t1", false), toolResult("t2", true)]),
      assistant("2026-11-10T10:00:03.000Z", "claude-opus-5"),
      user("2026-11-10T10:01:00.000Z"),
      assistant("2026-11-10T10:01:01.000Z", "claude-haiku-4-5"),
      assistant("2026-11-10T10:01:02.000Z", "claude-opus-5"),
      // A runtime notice: not a model, not in the mix.
      assistant("2026-11-10T10:01:03.000Z", "<synthetic>"),
      JSON.stringify({ type: "system", subtype: "api_error", timestamp: "2026-11-10T10:01:04.000Z", ...base })
    ],
    [
      assistant("2026-11-10T10:00:10.000Z", "claude-haiku-4-5", [toolUse("s1")], { isSidechain: true, agentId: "a1" }),
      user("2026-11-10T10:00:11.000Z", [toolResult("s1", true)], { isSidechain: true, agentId: "a1" })
    ]
  );
  const m = session.metrics;
  assert.equal(m.primaryModel, "claude-opus-5");
  assert.deepEqual(JSON.parse(m.modelTurns), { "claude-opus-5": 3, "claude-haiku-4-5": 1 });
  assert.equal("modelTurnsOmitted" in m, false);
  // A plain slug names no route, and a transcript records no endpoint.
  assert.equal("modelRoute" in m, false);
  assert.equal(m.mainThreadToolCallCount, 2);
  assert.equal(m.mainThreadToolFailureCount, 1);
  // The existing key keeps its meaning: main line + subagent line + API error.
  assert.equal(m.toolFailureCount, 3);

  const handoff = buildHandoff(events, "x-modelmix", "2026-11-11T00:00:00.000Z").sessions[0];
  assert.deepEqual(handoff.modelTurns, { "claude-opus-5": 3, "claude-haiku-4-5": 1 });
  assert.equal(handoff.modelRoute, null);
  assert.equal(handoff.mainThreadToolCallCount, 2);
  assert.equal(handoff.mainThreadToolFailureCount, 1);

  const wire = toWirePayload(session, 0, "claude_code:test-install").metadata;
  assert.equal(typeof wire.modelTurns, "string");
  assert.equal(wire.mainThreadToolFailureCount, 1);
});

test("claude code: a Bedrock-form slug carries its route to the wire", async () => {
  const { session } = await claudeSession([
    user("2026-11-10T10:00:00.000Z"),
    assistant("2026-11-10T10:00:01.000Z", "us.anthropic.claude-opus-4-5-20251101-v1:0")
  ]);
  assert.equal(session.metrics.modelRoute, "bedrock");
  const wire = toWirePayload(session, 0, "claude_code:test-install").metadata;
  assert.equal(wire.modelRoute, "bedrock");
  assert.equal(wire.modelClass, "anthropic:opus");
});

const codexLine = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
const PARENT = "11111111-1111-4111-8111-111111111112";
const CHILD = "33333333-3333-4333-8333-333333333334";
const cwd = "/work/repo-a";

async function codexStore(rollouts) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "modelmix-codex-"));
  try {
    const dir = path.join(root, "sessions", "2026", "11", "10");
    await fs.mkdir(dir, { recursive: true });
    for (const [id, lines] of rollouts) {
      await fs.writeFile(path.join(dir, `rollout-2026-11-10T10-00-00-${id}.jsonl`), lines.join("\n") + "\n");
    }
    return await collect(extractCodex(root, "x-codex"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("codex: model_provider becomes a route word, and subagent calls stay out of the main-thread pair", async () => {
  const events = await codexStore([
    [
      PARENT,
      [
        codexLine("2026-11-10T10:00:00.000Z", "session_meta", { id: PARENT, timestamp: "2026-11-10T10:00:00.000Z", cwd, cli_version: "0.153.4", model_provider: "my-team-proxy" }),
        codexLine("2026-11-10T10:00:01.000Z", "event_msg", { type: "user_message", message: "redacted", images: [] }),
        codexLine("2026-11-10T10:00:01.000Z", "turn_context", { turn_id: "t1", cwd, model: "glm-4.6" }),
        codexLine("2026-11-10T10:00:02.000Z", "response_item", { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" }),
        codexLine("2026-11-10T10:00:03.000Z", "response_item", { type: "function_call_output", call_id: "c1", output: "Exit code: 1\nredacted" }),
        codexLine("2026-11-10T10:00:04.000Z", "response_item", { type: "function_call", name: "shell", arguments: "{}", call_id: "c2" }),
        codexLine("2026-11-10T10:00:05.000Z", "response_item", { type: "function_call_output", call_id: "c2", output: "Exit code: 0\nredacted" }),
        codexLine("2026-11-10T10:05:00.000Z", "event_msg", { type: "user_message", message: "redacted", images: [] }),
        codexLine("2026-11-10T10:05:00.000Z", "turn_context", { turn_id: "t2", cwd, model: "glm-4.6" })
      ]
    ],
    [
      CHILD,
      [
        codexLine("2026-11-10T10:01:00.000Z", "session_meta", { id: CHILD, timestamp: "2026-11-10T10:01:00.000Z", cwd, cli_version: "0.153.4", thread_source: "subagent", parent_thread_id: PARENT, model_provider: "openai" }),
        codexLine("2026-11-10T10:01:01.000Z", "turn_context", { turn_id: "s1", cwd, model: "gpt-5-mini" }),
        codexLine("2026-11-10T10:01:02.000Z", "response_item", { type: "function_call", name: "shell", arguments: "{}", call_id: "c3" }),
        codexLine("2026-11-10T10:01:03.000Z", "response_item", { type: "function_call_output", call_id: "c3", output: { success: false, content: "redacted" } })
      ]
    ]
  ]);
  const session = events.find((e) => e.eventKind === "create_focus_session");
  const m = session.metrics;
  assert.equal(m.modelRoute, "custom_endpoint", "the session's own provider, never the subagent's and never its name");
  assert.ok(!JSON.stringify(events).includes("my-team-proxy"), "a provider name must never reach an event");
  assert.deepEqual(JSON.parse(m.modelTurns), { "glm-4.6": 2, "gpt-5-mini": 1 });
  assert.equal(m.toolCallCount, 3, "unchanged: includes the subagent's call");
  assert.equal(m.mainThreadToolCallCount, 2);
  assert.equal(m.mainThreadToolFailureCount, 1);
  const handoff = buildCodexHandoff(events, "x-codex", "2026-11-11T00:00:00.000Z").sessions[0];
  assert.equal(handoff.modelRoute, "custom_endpoint");
  assert.equal(handoff.mainThreadToolCallCount, 2);
  const wire = toWirePayload(session, 0, "codex:test-install").metadata;
  assert.equal(wire.modelClass, "zhipu:unknown");
  assert.equal(wire.modelRoute, "custom_endpoint");
});

test("codex: the built-in openai provider is direct", async () => {
  const events = await codexStore([
    [
      PARENT,
      [
        codexLine("2026-11-10T10:00:00.000Z", "session_meta", { id: PARENT, timestamp: "2026-11-10T10:00:00.000Z", cwd, cli_version: "0.153.4", model_provider: "openai" }),
        codexLine("2026-11-10T10:00:01.000Z", "event_msg", { type: "user_message", message: "redacted", images: [] }),
        codexLine("2026-11-10T10:00:01.000Z", "turn_context", { turn_id: "t1", cwd, model: "gpt-5-codex" })
      ]
    ]
  ]);
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.equal(session.metrics.modelRoute, "direct");
});

test("the turn map is bounded, largest first, with the rest counted", () => {
  const models = new Map();
  for (let i = 0; i < MODEL_TURNS_CAP + 3; i++) models.set(`model-${String(i).padStart(2, "0")}`, 100 - i);
  models.set("x".repeat(201), 500);
  const { modelTurns, modelTurnsOmitted } = modelTurnsMetrics(models);
  const parsed = parseModelTurns(modelTurns);
  assert.equal(Object.keys(parsed).length, MODEL_TURNS_CAP);
  assert.equal(Object.keys(parsed)[0], "model-00");
  // Three past the cap (92, 91, 90) and the over-long slug.
  assert.equal(modelTurnsOmitted, 92 + 91 + 90 + 500);
  assert.deepEqual(modelTurnsMetrics(new Map()), {});
  assert.equal(parseModelTurns("not json"), null);
  assert.equal(parseModelTurns(undefined), null);
});
