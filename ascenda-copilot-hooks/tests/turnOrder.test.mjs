import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHook, withIngest } from "../../scripts/test-support/hookSessionWire.mjs";

// In a new session Copilot CLI was seen to fire `sessionStart` after the
// first `userPromptSubmitted`. The prompt hook records the turn's start, and
// a late `sessionStart` must not reset it: the turn still completes with its
// duration, and every event of the turn carries the one prompt id.

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const SESSION = "4b1f0c2e-9d8a-4e6f-a1b3-5c7d9e0f1a2b";

test("a sessionStart that arrives after the first prompt keeps the turn whole", async () => {
  await withIngest(async (apiBaseUrl, received) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-order-"));
    const env = {
      ...process.env,
      HOME: home,
      ASCENDA_HOME: home,
      ASCENDA_STATE_DIR: path.join(home, "state"),
      ASCENDA_API_BASE_URL: apiBaseUrl,
      ASCENDA_TOOL_INSTALLATION_ID: "cli_agent:order-0000",
      ASCENDA_EVENT_WRITE_TOKEN: "tok_test",
      ASCENDA_EVENT_WRITE_TOKEN_FILE: path.join(home, "token"),
      ASCENDA_SESSION_ID: "",
      ASCENDA_EVENT_LOG_FILE: "",
      ASCENDA_LIVE_BUS_SOCKET: path.join(home, "no-such.sock")
    };
    const base = { sessionId: SESSION, cwd: "/tmp" };
    for (const [hook, extra] of [
      ["userPromptSubmitted", { prompt: "run the tests", timestamp: Date.now() }],
      ["sessionStart", { source: "new", initialPrompt: "run the tests", timestamp: Date.now() }],
      ["preToolUse", { toolCalls: [{ id: "c1", name: "bash", args: { command: "npm test" } }] }],
      ["agentStop", { stopReason: "end_turn", timestamp: Date.now() }]
    ]) {
      const result = await runHook(cli, hook, { ...base, ...extra }, env);
      assert.equal(result.status, 0, result.stderr);
    }

    const deadline = Date.now() + 10_000;
    while (received.length < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const types = received.map((payload) => payload.eventType).sort();
    assert.deepEqual(types, ["ai_prompt_submitted", "ai_tool_call_started", "ai_turn_completed", "create_focus_session"]);

    const promptIds = new Set(received.map((payload) => payload.metadata.promptId));
    assert.equal(promptIds.size, 1, `one prompt id across the turn, got ${[...promptIds].join(", ")}`);
    assert.ok([...promptIds][0], "the prompt id is present");
    const turn = received.find((payload) => payload.eventType === "ai_turn_completed");
    assert.ok(turn.metadata.durationBucket, "the turn's duration survived the late sessionStart");
    fs.rmSync(home, { recursive: true, force: true });
  });
});
