/**
 * A Codex question or approval gate is the agent waiting on the person. The
 * span from the call to whatever comes next must not count as active time.
 * Shapes follow real rollouts (`function_call` with a `name`), content removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractCodex, CODEX_BLOCKING_TOOLS } from "../dist/extractors/codex.js";

const META_ID = "019bd8bb-16b9-7431-a616-88eee7b38dfe";
const FILE_ID = "00000000-0000-0000-0000-000000000000";
const line = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });

async function activeMinutesWith(toolName) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-wait-"));
  const dir = path.join(root, "sessions", "2026", "07", "21");
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    line("2026-07-21T08:00:00.000Z", "session_meta", { id: META_ID, session_id: META_ID, timestamp: "2026-07-21T08:00:00.000Z", cwd: "/Users/example/Dev/repo-a", originator: "codex_vscode", cli_version: "0.144.0-alpha.4", source: "vscode", model_provider: "openai" }),
    line("2026-07-21T08:00:30.000Z", "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] }),
    line("2026-07-21T08:01:00.000Z", "response_item", { type: "function_call", name: toolName, arguments: "{}", call_id: "c1" }),
    // Four minutes parked, under the five-minute gap that would otherwise bridge it.
    line("2026-07-21T08:05:00.000Z", "response_item", { type: "function_call_output", call_id: "c1", output: "ok" })
  ];
  await fs.writeFile(path.join(dir, `rollout-2026-07-21T08-00-00-${FILE_ID}.jsonl`), lines.join("\n") + "\n");
  const events = [];
  for await (const e of extractCodex(root, "x-wait")) events.push(e);
  await fs.rm(root, { recursive: true, force: true });
  const session = events.find((e) => e.eventKind === "create_focus_session");
  return session.metrics.activeMinutes;
}

test("the blocking tool names include the one seen in real rollouts", () => {
  for (const n of ["request_user_input_async", "request_user_input", "request_permissions", "exec_approval_request", "apply_patch_approval_request", "elicitation_request"]) {
    assert.ok(CODEX_BLOCKING_TOOLS.has(n), n);
  }
  assert.ok(!CODEX_BLOCKING_TOOLS.has("exec_command"));
});

test("time parked on a question is not active time; the same gap on a normal call is", async () => {
  const waiting = await activeMinutesWith("request_user_input_async");
  const working = await activeMinutesWith("exec_command");
  assert.equal(working, 5, "the four-minute gap after a normal call is bridged");
  assert.equal(waiting, 1, "the four minutes parked on the person are not");
});
