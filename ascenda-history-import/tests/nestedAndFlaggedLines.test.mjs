/**
 * Nested subagents, the `workflows/<runId>/` layout, and the two flagged-line
 * counts (`isApiErrorMessage`, `isCompactSummary`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";

const S = "33333333-0000-4000-8000-000000000000";
const day = (hms) => `2026-10-21T${hms}.000Z`;
const base = (type, hms, extra = {}) => ({ type, timestamp: day(hms), sessionId: S, version: "2.1.227", cwd: "/Users/example/Dev/r", ...extra });
const line = (o) => JSON.stringify(o);
const asst = (hms, uses = [], extra = {}) =>
  line(base("assistant", hms, { ...extra, message: { role: "assistant", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "x" }, ...uses.map(([id, name, input]) => ({ type: "tool_use", id, name, input }))] } }));
const user = (hms, extra = {}) => line(base("user", hms, { ...extra, message: { role: "user", content: "redacted" } }));
const result = (hms, id, agentId, extra = {}) =>
  line(base("user", hms, { ...extra, toolUseResult: { agentId }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }));
const side = { isSidechain: true };

const FILES = {
  [`${S}.jsonl`]: [
    user("09:00:00"),
    asst("09:00:10", [["tA", "Agent", { prompt: "p", subagent_type: "Explore" }]]),
    result("09:10:00", "tA", "A"),
    asst("09:11:00", [], { isApiErrorMessage: true }),
    user("09:12:00", { isCompactSummary: true }),
    asst("09:13:00")
  ],
  [`${S}/subagents/agent-A.jsonl`]: [
    user("09:00:12", side),
    asst("09:01:00", [["tB", "Agent", { prompt: "p" }]], side),
    result("09:05:00", "tB", "B", side)
  ],
  [`${S}/subagents/agent-A.meta.json`]: [JSON.stringify({ agentType: "Explore", toolUseId: "tA" })],
  [`${S}/subagents/workflows/run1/agent-B.jsonl`]: [user("09:01:05", side), asst("09:02:00", [], side)],
  [`${S}/subagents/workflows/run1/agent-B.meta.json`]: [JSON.stringify({ agentType: "Plan" })]
};

async function run(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-nested-"));
  const pd = path.join(dir, "projects", "-Users-example-Dev-r");
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(pd, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body.join("\n") + "\n", "utf8");
  }
  const out = [];
  for await (const e of extractClaudeCode(dir, "e1")) out.push(e);
  await fs.rm(dir, { recursive: true, force: true });
  return out.find((e) => e.eventKind === "create_focus_session");
}

test("a subagent another subagent launched is nested; the one the main thread launched is not", async () => {
  const s = await run(FILES);
  const [a, b] = s.subagentReceipts;
  assert.equal(a.class, "explore");
  assert.equal(a.nested, false);
  assert.equal(a.spawnedCount, 1);
  assert.equal(b.class, "plan");
  assert.equal(b.nested, true);
  assert.equal(b.spawnedCount, 0);
  assert.equal(s.metrics.nestedSubagentCount, 1);
});

test("flagged lines are counted once each, and absent when there are none", async () => {
  const s = await run(FILES);
  assert.equal(s.metrics.apiErrorMessageCount, 1);
  assert.equal(s.metrics.compactSummaryCount, 1);
  const plain = await run({ [`${S}.jsonl`]: [user("09:00:00"), asst("09:00:10")] });
  assert.equal("apiErrorMessageCount" in plain.metrics, false);
  assert.equal("compactSummaryCount" in plain.metrics, false);
  assert.equal("nestedSubagentCount" in plain.metrics, false);
});
