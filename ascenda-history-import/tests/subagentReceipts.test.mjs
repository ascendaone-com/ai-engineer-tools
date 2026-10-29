/**
 * Per-subagent receipts. The Dart writer has a twin of this file
 * (`claude_code_subagent_receipts_test.dart`) built on the same scenario, so
 * a change to the rules has to land in both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { buildHandoff } from "../dist/localHandoff.js";
import { classifySubagentType } from "../dist/subagentReceipts.js";

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const S0 = "00000000-0000-4000-8000-000000000000";
const S1 = "11111111-0000-4000-8000-000000000000";
const S2 = "22222222-0000-4000-8000-000000000000";
const day = (hms) => `2026-10-20T${hms}.000Z`;

function base(session, type, hms, extra = {}) {
  return { type, timestamp: day(hms), sessionId: session, version: "2.1.227", cwd: "/Users/example/Dev/r", ...extra };
}
const asst = (session, hms, uses, extra = {}) =>
  JSON.stringify(
    base(session, "assistant", hms, {
      ...extra,
      message: {
        role: "assistant",
        model: "claude-opus-5",
        usage: { input_tokens: 10, output_tokens: 20 },
        content: [{ type: "text", text: "x" }, ...uses.map(([id, name, input]) => ({ type: "tool_use", id, name, input }))]
      }
    })
  );
const user = (session, hms, extra = {}) =>
  JSON.stringify(base(session, "user", hms, { ...extra, message: { role: "user", content: "redacted" } }));
const result = (session, hms, id, content, { error = false, toolUseResult } = {}) =>
  JSON.stringify(
    base(session, "user", hms, {
      toolUseResult,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(error ? { is_error: true } : {}) }] }
    })
  );
const side = { isSidechain: true };

async function store(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-receipts-"));
  const projectDir = path.join(dir, "projects", "-Users-example-Dev-r");
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(projectDir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body.join("\n") + "\n", "utf8");
  }
  return dir;
}

async function sessions(files) {
  const dir = await store(files);
  const events = await collect(extractClaudeCode(dir, "e1"));
  await fs.rm(dir, { recursive: true, force: true });
  return new Map(events.filter((e) => e.eventKind === "create_focus_session").map((e) => [e.sessionRef, e]));
}

const spawn = (s, hms, id, type) =>
  asst(s, hms, [[id, "Agent", { description: "d", prompt: "secret", ...(type ? { subagent_type: type } : {}) }]]);
const edit = (id, file) => [id, "Edit", { file_path: file, old_string: "a", new_string: "b" }];

const FILES = {
  [`${S0}.jsonl`]: [user(S0, "09:00:00"), asst(S0, "09:00:05", [["t0", "Read", { file_path: "/r/a.ts" }]])],
  // One subagent, returned at 10:22:30, main thread re-edits its file 7.5 min later.
  [`${S1}.jsonl`]: [
    user(S1, "10:00:00"),
    spawn(S1, "10:00:10", "toolu_A", "Explore"),
    result(S1, "10:22:30", "toolu_A", [{ type: "text", text: "a".repeat(1000) }, { type: "text", text: "b".repeat(234) }], {
      toolUseResult: { agentId: "A" }
    }),
    asst(S1, "10:30:00", [edit("m1", "/r/a.ts")])
  ],
  [`${S1}/subagents/agent-A.jsonl`]: [
    user(S1, "10:00:12", side),
    asst(S1, "10:03:00", [edit("s1", "/r/a.ts")], side),
    result(S1, "10:06:00", "s1", "boom", { error: true }),
    asst(S1, "10:20:00", [["s2", "Read", { file_path: "/r/z.ts" }]], side),
    asst(S1, "10:22:00", [], side)
  ],
  [`${S1}/subagents/agent-A.meta.json`]: [JSON.stringify({ agentType: "Explore", toolUseId: "toolu_A" })],
  // Several: B re-touched outside the window, C never returned, D in the background.
  [`${S2}.jsonl`]: [
    user(S2, "10:30:00"),
    spawn(S2, "10:31:00", "toolu_B", "my-secret-agent"),
    result(S2, "10:32:30", "toolu_B", "r".repeat(50), { toolUseResult: { agentId: "B" } }),
    asst(S2, "10:45:00", [edit("m2", "/r/b.ts")]),
    spawn(S2, "10:50:00", "toolu_C", "Plan"),
    spawn(S2, "10:51:00", "toolu_D", "general-purpose"),
    result(S2, "10:51:01", "toolu_D", "launched", { toolUseResult: { agentId: "D", isAsync: true } }),
    asst(S2, "10:55:00", [edit("m3", "/r/d.ts")])
  ],
  [`${S2}/subagents/agent-B.jsonl`]: [
    user(S2, "10:31:05", side),
    asst(S2, "10:31:30", [edit("s3", "/r/b.ts")], side),
    asst(S2, "10:32:00", [], side)
  ],
  [`${S2}/subagents/agent-B.meta.json`]: [JSON.stringify({ agentType: "my-secret-agent", toolUseId: "toolu_B" })],
  [`${S2}/subagents/agent-C.jsonl`]: [user(S2, "10:50:10", side), asst(S2, "10:50:20", [edit("s4", "/r/c.ts")], side)],
  [`${S2}/subagents/agent-C.meta.json`]: [JSON.stringify({ agentType: "Plan", toolUseId: "toolu_C" })],
  [`${S2}/subagents/agent-D.jsonl`]: [user(S2, "10:51:05", side), asst(S2, "10:51:30", [edit("s5", "/r/d.ts")], side)]
};

test("a session with no subagents carries an empty receipt list, not an absent one", async () => {
  const s = await sessions(FILES);
  assert.deepEqual(s.get(S0).subagentReceipts, []);
});

test("one subagent: class, own window, active minutes, calls, failures, result size, re-touch inside the window", async () => {
  const s = await sessions(FILES);
  assert.deepEqual(s.get(S1).subagentReceipts, [
    {
      class: "explore",
      firstAt: day("10:00:12"),
      lastAt: day("10:22:00"),
      // 168s + 180s + 120s: the 14-minute silence is not active time.
      activeMinutes: 8,
      toolCalls: 2,
      toolFailures: 1,
      resultChars: 1234,
      background: false,
      retouchedAfterReturn: true
    }
  ]);
});

test("several subagents: custom names never surface, re-touch outside the window is false, no tool_result is null, background is flagged", async () => {
  const s = await sessions(FILES);
  const r = s.get(S2).subagentReceipts;
  assert.equal(r.length, 3);
  const [b, c, d] = r;
  assert.equal(b.class, "custom");
  assert.equal(b.resultChars, 50);
  assert.equal(b.retouchedAfterReturn, false); // 12.5 minutes after it returned
  assert.equal(c.class, "plan"); // the parent never got a tool_result for it
  assert.equal(c.resultChars, null);
  assert.equal(c.retouchedAfterReturn, null);
  assert.equal(d.background, true);
  assert.equal(d.resultChars, null);
  assert.equal(d.retouchedAfterReturn, null);
  const text = JSON.stringify([...s.values()].map((e) => e.subagentReceipts));
  for (const leak of ["my-secret-agent", "secret", "/r/", "a.ts"]) assert.ok(!text.includes(leak), leak);
});

test("the handoff carries the receipts and the schema does not move", async () => {
  const dir = await store(FILES);
  const events = await collect(extractClaudeCode(dir, "e1"));
  await fs.rm(dir, { recursive: true, force: true });
  const handoff = buildHandoff(events, "e1", "2026-10-29T00:00:00.000Z");
  const bySession = new Map(handoff.sessions.map((x) => [x.sessionRef, x]));
  const withReceipts = handoff.sessions.filter((x) => (x.subagentReceipts ?? []).length > 0);
  assert.equal(withReceipts.length, 2);
  assert.equal(bySession.size, 3);
});

test("classification matches the live hooks' vocabulary", () => {
  assert.equal(classifySubagentType("general-purpose"), "general_purpose");
  assert.equal(classifySubagentType("Explore"), "explore");
  assert.equal(classifySubagentType("statusline-setup"), "statusline_setup");
  assert.equal(classifySubagentType("claude-code-guide"), "claude_code_guide");
  assert.equal(classifySubagentType("acme:reviewer"), "plugin");
  assert.equal(classifySubagentType("anything"), "custom");
  assert.equal(classifySubagentType(" "), "none");
  assert.equal(classifySubagentType(undefined), "unknown");
});
