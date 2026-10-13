import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHook, withIngest } from "../../scripts/test-support/hookSessionWire.mjs";

// Codex puts a `session_id` and, on turn-scoped hooks, a `turn_id` in every
// hook payload. The collector reads `session_id` only, so a session that runs
// several turns stays one session on the wire. If it ever read the turn id
// instead, each turn would look like a session of its own.

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const SESSION = "0199c2a4-5e1f-7d30-8a6b-3c4d5e6f7a81";
const TURNS = ["turn-a-1111", "turn-b-2222"];

test("two turns of one Codex session reach ingest under the one session_id", async () => {
  await withIngest(async (apiBaseUrl, received) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-codex-turns-"));
    const env = {
      ...process.env,
      HOME: home,
      ASCENDA_API_BASE_URL: apiBaseUrl,
      ASCENDA_TOOL_INSTALLATION_ID: "cli_agent:turns-0000",
      ASCENDA_EVENT_WRITE_TOKEN: "tok_test",
      ASCENDA_EVENT_WRITE_TOKEN_FILE: path.join(home, "token"),
      ASCENDA_SESSION_ID: "",
      ASCENDA_EVENT_LOG_FILE: "",
      ASCENDA_LIVE_BUS_SOCKET: path.join(home, "no-such.sock")
    };

    for (const turn_id of TURNS) {
      const base = { session_id: SESSION, turn_id, cwd: "/tmp" };
      for (const [hook, extra] of [
        ["UserPromptSubmit", { prompt: "run the tests" }],
        ["PostToolUse", { tool_name: "shell", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } }],
        ["Stop", {}]
      ]) {
        const result = await runHook(cli, hook, { ...base, ...extra }, env);
        assert.equal(result.status, 0, result.stderr);
      }
    }

    assert.ok(received.length > 0, "nothing reached ingest");
    for (const payload of received) {
      assert.equal(payload.sessionId, SESSION, `${payload.eventType} carried sessionId=${JSON.stringify(payload.sessionId)}`);
    }
    const turnsCompleted = received.filter((payload) => payload.eventType === "ai_turn_completed");
    assert.equal(turnsCompleted.length, TURNS.length, "each turn ends with one ai_turn_completed");
  });
});
