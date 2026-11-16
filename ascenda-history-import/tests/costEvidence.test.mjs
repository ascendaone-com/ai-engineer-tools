/**
 * The evidence a cost finding rests on: skills and MCP servers in context and
 * used, fast messages, deep messages, premium subagents. Counts ship; the
 * names that produced them never do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { PREMIUM_MODEL_CLASSES, isPremiumModelClass } from "@ascenda-one/tool-kit";

const S = "c0570000-0000-4000-8000-000000000001";
const day = (hms) => `2026-11-10T${hms}.000Z`;
let uuidCounter = 0;
const nextUuid = () => `u-${String(++uuidCounter).padStart(6, "0")}`;

function base(type, hms, extra = {}) {
  return { type, uuid: nextUuid(), timestamp: day(hms), sessionId: S, version: "2.1.300", cwd: "/Users/example/Dev/r", ...extra };
}
const user = (hms, extra = {}) => JSON.stringify(base("user", hms, { ...extra, message: { role: "user", content: "redacted" } }));
const attachment = (hms, body, extra = {}) => JSON.stringify(base("attachment", hms, { ...extra, attachment: body }));
function asst(hms, { id, uses = [], usage = { input_tokens: 10, output_tokens: 20 }, model = "claude-opus-5", extra = {} } = {}) {
  return JSON.stringify(
    base("assistant", hms, {
      ...extra,
      ...(id ? { requestId: `req-${id}` } : {}),
      message: {
        ...(id ? { id } : {}),
        role: "assistant",
        model,
        usage,
        content: [{ type: "text", text: "x" }, ...uses.map(([useId, name, input]) => ({ type: "tool_use", id: useId, name, input }))]
      }
    })
  );
}

async function sessionOf(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-cost-"));
  try {
    for (const [rel, lines] of Object.entries(files)) {
      const p = path.join(dir, "projects", "-Users-example-Dev-r", rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, lines.join("\n") + "\n", "utf8");
    }
    const events = [];
    for await (const e of extractClaudeCode(dir, "cost")) events.push(e);
    const sessions = events.filter((e) => e.eventKind === "create_focus_session");
    assert.equal(sessions.length, 1);
    return sessions[0];
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const SKILLS = ["acme-billing", "client-deploy", "docs", "pdf", "secret-skill"];

test("skills: five listed, one loaded by attachment and one by the Skill tool", async () => {
  const s = await sessionOf({
    [`${S}.jsonl`]: [
      attachment("09:00:00", { type: "skill_listing", content: "redacted", skillCount: 5, isInitial: true, names: SKILLS }),
      user("09:00:01"),
      asst("09:00:05", { uses: [["t1", "Skill", { skill: "pdf" }]] }),
      attachment("09:00:06", { type: "invoked_skills", skills: [{ name: "acme-billing", path: "/x", content: "redacted" }] }),
      // A Skill call for something not in the listing doesn't count as a listed skill used.
      asst("09:00:10", { uses: [["t2", "Skill", { skill: "not-listed" }]] })
    ]
  });
  assert.equal(s.metrics.skillListingSeen, true);
  assert.equal(s.metrics.skillsListed, 5);
  assert.equal(s.metrics.skillsInvoked, 2);
  const text = JSON.stringify(s);
  for (const name of [...SKILLS, "not-listed"]) assert.ok(!text.includes(name), name);
});

test("skills: a later listing adds to the set, a new initial listing replaces it", async () => {
  const s = await sessionOf({
    [`${S}.jsonl`]: [
      attachment("09:00:00", { type: "skill_listing", skillCount: 2, isInitial: true, names: ["a", "b"] }),
      user("09:00:01"),
      attachment("09:00:02", { type: "skill_listing", skillCount: 1, isInitial: false, names: ["c"] }),
      asst("09:00:05"),
      attachment("09:10:00", { type: "skill_listing", skillCount: 4, isInitial: true, names: ["a", "d", "e", "f"] })
    ]
  });
  assert.equal(s.metrics.skillsListed, 4);
});

test("MCP: two added, one removed, calls to the remaining one; a long tool name still maps to its server", async () => {
  const longTool = "mcp__plugin_acme_billing-server__a_tool_name_well_past_forty_characters_long";
  const s = await sessionOf({
    [`${S}.jsonl`]: [
      attachment("09:00:00", { type: "mcp_instructions_delta", addedNames: ["plugin:acme:billing-server", "client-crm"], addedBlocks: ["x", "y"], removedNames: [] }),
      user("09:00:01"),
      attachment("09:00:02", { type: "mcp_instructions_delta", addedNames: [], addedBlocks: [], removedNames: ["client-crm"] }),
      asst("09:00:05", { uses: [["t1", longTool, {}]] }),
      asst("09:00:06", { uses: [["t2", "mcp__plugin_acme_billing-server__other", {}]] })
    ]
  });
  assert.equal(s.metrics.mcpListingSeen, true);
  assert.equal(s.metrics.mcpServersLoaded, 1);
  assert.equal(s.metrics.mcpServersUsed, 1);
  assert.equal(s.metrics.mcpServersFailed, 0);
  const text = JSON.stringify(s.metrics);
  for (const name of ["acme", "billing", "client-crm"]) assert.ok(!text.includes(name), name);
});

test("MCP: deferred tools count their servers, removals unload them, and a failed server that never loads counts", async () => {
  const s = await sessionOf({
    [`${S}.jsonl`]: [
      attachment("09:00:00", {
        type: "deferred_tools_delta",
        addedNames: ["Monitor", "mcp__alpha__one", "mcp__alpha__two", "mcp__beta__one", "mcp__gamma__one"],
        removedNames: [],
        failedMcpServers: [{ name: "delta", error: "redacted" }, { name: "gamma", error: "redacted" }]
      }),
      user("09:00:01"),
      attachment("09:00:02", { type: "deferred_tools_delta", addedNames: [], removedNames: ["mcp__beta__one"] }),
      asst("09:00:05", { uses: [["t1", "mcp__alpha__one", {}]] })
    ]
  });
  // alpha and gamma loaded; beta removed; delta failed and never loaded (gamma loaded, so not failed).
  assert.equal(s.metrics.mcpServersLoaded, 2);
  assert.equal(s.metrics.mcpServersUsed, 1);
  assert.equal(s.metrics.mcpServersFailed, 1);
});

test("a session with no listing attachments ships no skill or MCP keys", async () => {
  const s = await sessionOf({
    [`${S}.jsonl`]: [user("09:00:01"), asst("09:00:05", { uses: [["t1", "Skill", { skill: "pdf" }], ["t2", "mcp__alpha__one", {}]] })]
  });
  for (const key of ["skillListingSeen", "skillsListed", "skillsInvoked", "mcpListingSeen", "mcpServersLoaded", "mcpServersUsed", "mcpServersFailed"]) {
    assert.equal(key in s.metrics, false, key);
  }
});

test("a message split over three fast lines counts one fast turn; a subagent's counts apart", async () => {
  const fast = { input_tokens: 10, output_tokens: 20, speed: "fast" };
  const s = await sessionOf({
    [`${S}.jsonl`]: [
      user("09:00:01"),
      asst("09:00:02", { id: "msg_1", usage: fast }),
      asst("09:00:03", { id: "msg_1", usage: fast, uses: [["t1", "Read", {}]] }),
      asst("09:00:04", { id: "msg_1", usage: fast, uses: [["t2", "Agent", { subagent_type: "Explore" }]] }),
      asst("09:00:05", { id: "msg_2", usage: { input_tokens: 10, output_tokens: 20, speed: "standard" } })
    ],
    [`${S}/subagents/agent-A.jsonl`]: [
      user("09:00:06", { isSidechain: true }),
      asst("09:00:07", { id: "msg_s1", usage: fast, extra: { isSidechain: true } }),
      asst("09:00:08", { id: "msg_s2", usage: fast, extra: { isSidechain: true } })
    ]
  });
  assert.equal(s.metrics.speedSeen, true);
  assert.equal(s.metrics.fastTurns, 1);
  assert.equal(s.metrics.subagentFastTurns, 2);
});

test("a transcript that never recorded speed ships no speed keys", async () => {
  const s = await sessionOf({ [`${S}.jsonl`]: [user("09:00:01"), asst("09:00:02")] });
  for (const key of ["speedSeen", "fastTurns", "subagentFastTurns"]) assert.equal(key in s.metrics, false, key);
});

test("deep turns: main-thread messages over 200k and 400k, once per message, subagents left out", async () => {
  const ctx = (input, read, write) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 5 });
  const s = await sessionOf({
    [`${S}.jsonl`]: [
      user("09:00:01"),
      asst("09:00:02", { id: "m1", usage: ctx(1, 150_000, 10_000) }),
      asst("09:00:03", { id: "m2", usage: ctx(1, 199_000, 2_000) }),
      asst("09:00:04", { id: "m2", usage: ctx(1, 199_000, 2_000) }),
      asst("09:00:05", { id: "m3", usage: ctx(1, 420_000, 0) })
    ],
    [`${S}/subagents/agent-A.jsonl`]: [
      user("09:00:06", { isSidechain: true }),
      asst("09:00:07", { id: "s1", usage: ctx(1, 500_000, 0), extra: { isSidechain: true } })
    ]
  });
  assert.equal(s.metrics.deepTurns200k, 2);
  assert.equal(s.metrics.deepTurns400k, 1);
});

test("a repeated line adds no fast turn, skill use or MCP use", async () => {
  const fast = { input_tokens: 10, output_tokens: 20, speed: "fast" };
  const call = asst("09:00:05", { id: "m9", usage: fast, uses: [["t1", "mcp__alpha__one", {}], ["t2", "Skill", { skill: "a" }]] });
  const s = await sessionOf({
    [`${S}.jsonl`]: [
      attachment("09:00:00", { type: "skill_listing", skillCount: 2, isInitial: true, names: ["a", "b"] }),
      attachment("09:00:00", { type: "mcp_instructions_delta", addedNames: ["alpha", "beta"], removedNames: [] }),
      user("09:00:01"),
      call,
      call
    ]
  });
  assert.equal(s.metrics.repeatedLines, 1);
  assert.equal(s.metrics.fastTurns, 1);
  assert.equal(s.metrics.skillsInvoked, 1);
  assert.equal(s.metrics.mcpServersUsed, 1);
});

test("receipts: an Opus subagent is premium, a Haiku one isn't", async () => {
  const s = await sessionOf({
    [`${S}.jsonl`]: [
      user("09:00:01"),
      asst("09:00:02", { uses: [["toolu_A", "Agent", { subagent_type: "Explore" }], ["toolu_B", "Agent", { subagent_type: "Explore" }]] })
    ],
    [`${S}/subagents/agent-A.jsonl`]: [
      user("09:00:03", { isSidechain: true }),
      asst("09:00:04", { id: "a1", model: "claude-opus-5-5", extra: { isSidechain: true } }),
      asst("09:00:05", { id: "a2", model: "claude-opus-5-5", extra: { isSidechain: true } }),
      asst("09:00:06", { id: "a3", model: "claude-haiku-5-5", extra: { isSidechain: true } })
    ],
    [`${S}/subagents/agent-B.jsonl`]: [
      user("09:00:03", { isSidechain: true }),
      asst("09:00:04", { id: "b1", model: "claude-haiku-5-5", extra: { isSidechain: true } })
    ]
  });
  assert.deepEqual(
    s.subagentReceipts.map((r) => r.modelClass),
    ["anthropic:opus", "anthropic:haiku"]
  );
  assert.equal(s.metrics.premiumSubagents, 1);
});

test("a session with no subagents ships premiumSubagents 0", async () => {
  const s = await sessionOf({ [`${S}.jsonl`]: [user("09:00:01"), asst("09:00:02")] });
  assert.equal(s.metrics.premiumSubagents, 0);
});

test("premium classes are Opus and Fable only", () => {
  assert.deepEqual([...PREMIUM_MODEL_CLASSES].sort(), ["anthropic:fable", "anthropic:opus"]);
  assert.equal(isPremiumModelClass("anthropic:sonnet"), false);
  assert.equal(isPremiumModelClass("openai:gpt"), false);
  assert.equal(isPremiumModelClass(undefined), false);
});
