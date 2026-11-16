/**
 * Lines a transcript repeats. A resumed session can write lines its own file
 * already holds, same `uuid`s and timestamps, and a forked subagent opens with
 * a copy of its parent's conversation. Either way the repeat is read for turn
 * state and adds nothing; `repeatedLines` says how many there were.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLUG = "-Users-example-Dev-replay-repo";

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function storeOf(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-replay-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, "projects", SLUG, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body, "utf8");
  }
  return dir;
}

async function sessionOf(files) {
  const dir = await storeOf(files);
  try {
    const events = await collect(extractClaudeCode(dir, "replay"));
    const sessions = events.filter((e) => e.eventKind === "create_focus_session");
    assert.equal(sessions.length, 1);
    return { metrics: sessions[0].metrics, events };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------ *
 * Part 1: a resume that repeats lines inside one file
 * ------------------------------------------------------------------------ */

const SESSION = "5e5e5e5e-0000-4000-8000-000000000001";
const replayed = await fs.readFile(path.join(HERE, "fixtures", "claude-resume-replay.jsonl"), "utf8");
const replayedLines = replayed.trimEnd().split("\n");

/** The fixture with every repeated `uuid` after its first appearance taken out. */
function withoutRepeats(lines) {
  const seen = new Set();
  return lines.filter((line) => {
    const { uuid } = JSON.parse(line);
    if (seen.has(uuid)) return false;
    seen.add(uuid);
    return true;
  });
}

test("a resume's repeated lines add no tool calls, failures or API errors", async () => {
  const { metrics, events } = await sessionOf({ [`${SESSION}.jsonl`]: replayed });
  assert.equal(metrics.toolCallCount, 3, "two before the resume, one after");
  assert.equal(metrics.toolResultCount, 3);
  assert.equal(metrics.apiErrorCount, 1);
  assert.equal(metrics.toolFailureCount, 2, "one failed tool result plus one API error");
  assert.equal(metrics.repeatedLines, 7);
  assert.equal(events.filter((e) => e.eventKind === "ai_tool_call_started").length, 3);
});

test("tokens, prompts, turns and minutes match the same file without its repeats", async () => {
  const { metrics: withRepeats } = await sessionOf({ [`${SESSION}.jsonl`]: replayed });
  const { metrics: clean } = await sessionOf({
    [`${SESSION}.jsonl`]: withoutRepeats(replayedLines).join("\n") + "\n"
  });
  assert.equal("repeatedLines" in clean, false, "shipped only when above 0");
  const { repeatedLines: _dropped, ...rest } = withRepeats;
  assert.deepEqual(rest, clean);
});

/* ------------------------------------------------------------------------ *
 * Part 2: a forked subagent that opens with its parent's lines
 * ------------------------------------------------------------------------ */

const PARENT = "6f6f6f6f-0000-4000-8000-000000000002";
const at = (s) => `2026-11-03T10:00:${String(s).padStart(2, "0")}.000Z`;
const common = { sessionId: PARENT, version: "2.1.227", cwd: "/Users/example/Dev/replay-repo", gitBranch: "main" };
const asst = (uuid, s, msgId, toolId, name, extra = {}) =>
  JSON.stringify({
    ...common,
    ...extra,
    type: "assistant",
    uuid,
    timestamp: at(s),
    requestId: `req_${msgId}`,
    message: {
      id: msgId,
      role: "assistant",
      model: "claude-opus-5",
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [{ type: "tool_use", id: toolId, name, input: { pattern: "x" } }]
    }
  });
const parentLines = [
  JSON.stringify({ ...common, type: "user", uuid: "p-0001", timestamp: at(0), isSidechain: false, message: { role: "user", content: "look into it" } }),
  asst("p-0002", 1, "msg_p1", "toolu_p1", "Grep", { isSidechain: false }),
  JSON.stringify({
    ...common,
    type: "user",
    uuid: "p-0003",
    timestamp: at(2),
    isSidechain: false,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_p1", content: "ok" }] }
  }),
  asst("p-0004", 3, "msg_p2", "toolu_spawn", "Agent", { isSidechain: false })
];
const own = { isSidechain: true, agentId: "x" };
const forkLines = [
  ...parentLines.slice(0, 3),
  asst("x-0001", 4, "msg_x1", "toolu_x1", "Read", own),
  asst("x-0002", 5, "msg_x2", "toolu_x2", "Grep", own)
];

function forkStore(meta) {
  const files = {
    [`${PARENT}.jsonl`]: parentLines.join("\n") + "\n",
    [`${PARENT}/subagents/agent-x.jsonl`]: forkLines.join("\n") + "\n"
  };
  if (meta) files[`${PARENT}/subagents/agent-x.meta.json`] = JSON.stringify(meta);
  return files;
}

test("a forked subagent counts its own lines only", async () => {
  const { metrics } = await sessionOf(forkStore({ agentType: "general-purpose", toolUseId: "toolu_spawn", isFork: true }));
  assert.equal(metrics.subagentToolCallCount, 2);
  assert.equal(metrics.subagentAssistantTurns, 2);
  assert.equal(metrics.toolCallCount, 2, "the parent's own Grep and Agent calls");
  assert.equal(metrics.repeatedLines, 3);
});

test("the same subagent without isFork keeps today's figures", async () => {
  for (const meta of [{ agentType: "general-purpose", toolUseId: "toolu_spawn" }, null]) {
    const { metrics } = await sessionOf(forkStore(meta));
    assert.equal(metrics.subagentToolCallCount, 3, "the copied Grep counts again");
    assert.equal(metrics.subagentAssistantTurns, 2, "turns already count once per API message");
    assert.equal(metrics.toolCallCount, 2);
    assert.equal("repeatedLines" in metrics, false);
  }
});

/* ------------------------------------------------------------------------ *
 * A repeat with its sessionId rewritten to the file holding it
 * ------------------------------------------------------------------------ */

test("a repeat rewritten to this file's sessionId is still counted once in the store", async () => {
  const SB = "1b1b1b1b-0000-4000-8000-000000000003";
  const SA = "2a2a2a2a-0000-4000-8000-000000000004";
  const t = (s) => `2026-11-04T11:00:${String(s).padStart(2, "0")}.000Z`;
  const line = (sessionId, type, uuid, s, message) =>
    JSON.stringify({ sessionId, version: "2.1.227", cwd: "/Users/example/Dev/replay-repo", type, uuid, timestamp: t(s), message });
  const prompt = (sessionId, uuid, s) => line(sessionId, "user", uuid, s, { role: "user", content: "go" });
  const call = (sessionId) =>
    line(sessionId, "assistant", "shared-0001", 1, {
      id: "msg_shared",
      role: "assistant",
      model: "claude-opus-5",
      usage: { input_tokens: 10, output_tokens: 820 },
      content: [{ type: "tool_use", id: "toolu_shared", name: "Bash", input: { command: "ls" } }]
    });
  // A wrote the call. B was resumed from A: it opens with A's lines, then its
  // own prompt, then the call again with B's sessionId. The contested-owner
  // rule gives the call to B, the first file in walk order whose own history
  // holds it, so A leaves it alone and B has to count it.
  const dir = await storeOf({
    [`${SA}.jsonl`]: [prompt(SA, "a-0001", 0), call(SA)].join("\n") + "\n",
    [`${SB}.jsonl`]: [prompt(SA, "a-0001", 0), call(SA), prompt(SB, "b-0001", 10), call(SB)].join("\n") + "\n"
  });
  try {
    const sessions = (await collect(extractClaudeCode(dir, "replay"))).filter((e) => e.eventKind === "create_focus_session");
    const sum = (key) => sessions.reduce((n, e) => n + (e.metrics[key] ?? 0), 0);
    assert.equal(sum("toolCallCount"), 1);
    assert.equal(sum("outputTokens"), 820);
    assert.equal(sum("repeatedLines"), 0, "the rewritten copy is counted, so it isn't a skipped repeat");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
