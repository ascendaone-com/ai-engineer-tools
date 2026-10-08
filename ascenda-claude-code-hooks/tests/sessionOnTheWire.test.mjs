import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_HOOK_EVENT_NAMES } from "../dist/types.js";

// Every hook that sends anything puts the payload's session on the wire, as
// received by an ingest endpoint over HTTP, on the paired path.
//
// sessionIdentity.test.mjs covers the resolution order through the unpaired
// log. This covers the other half: each hook name, the real send, the real
// outbox replay for SessionEnd. A per-person count of agents running at once
// is built by grouping on `sessionId`, so one hook shipping a null would
// quietly drop its events out of that count.

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const SESSION = "4f7c1a2e-0b9d-4e55-9a51-2c6f3d8e7b10";
const CWD = os.tmpdir();

// One payload per registered hook, shaped like what Claude Code sends. A hook
// added to CLAUDE_HOOK_EVENT_NAMES without a row here fails the first test.
const PAYLOADS = {
  SessionStart: { source: "startup", model: "claude-opus-5-5" },
  UserPromptSubmit: { prompt: "run the tests", permission_mode: "default" },
  PreToolUse: { tool_name: "Bash", tool_input: { command: "npm test" }, permission_mode: "default" },
  PostToolUse: { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "", stderr: "", interrupted: false }, duration_ms: 1200 },
  PostToolUseFailure: { tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1\n", is_interrupt: false },
  PreCompact: { trigger: "auto" },
  PostCompact: { trigger: "auto" },
  Stop: { stop_hook_active: false, permission_mode: "default" },
  StopFailure: { error: "rate_limit" },
  Notification: { message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" },
  SessionEnd: { reason: "prompt_input_exit" },
  SubagentStart: { agent_id: "agent-a1b2c3", agent_type: "Explore" },
  SubagentStop: { agent_id: "agent-a1b2c3", agent_type: "Explore", stop_hook_active: false, agent_transcript_path: "/x/subagents/agent-a1b2c3.jsonl", last_assistant_message: "done" }
};

// Hooks that deliberately send nothing to Ascenda.
const SENDS_NOTHING = new Set(["StopFailure"]);

async function withIngest(run) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.url.endsWith("/batch")) {
        received.push(...parsed.events);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: parsed.events.map((_, index) => ({ index, status: "accepted" })) }));
        return;
      }
      received.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "accepted" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, received);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function runHook(hook, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, hook], { env });
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${hook} timed out`)); }, 20_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stderr }); });
    child.stdin.end(JSON.stringify({ session_id: SESSION, cwd: CWD, hook_event_name: hook, ...input }));
  });
}

function pairedEnv(apiBaseUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-wire-"));
  return {
    ...process.env,
    ASCENDA_API_BASE_URL: apiBaseUrl,
    ASCENDA_TOOL_INSTALLATION_ID: "claude_code:wire-0000",
    ASCENDA_EVENT_WRITE_TOKEN: "tok_test",
    ASCENDA_EVENT_WRITE_TOKEN_FILE: path.join(dir, "token"),
    ASCENDA_STATE_FILE: path.join(dir, "state.json"),
    ASCENDA_OUTBOX_FILE: path.join(dir, "outbox.jsonl"),
    ASCENDA_OUTBOX_DRAIN: "on",
    ASCENDA_SESSION_ID: "",
    ASCENDA_EVENT_LOG_FILE: "",
    ASCENDA_DISABLE_FAILURE_NOTICE: "true",
    // Keep the live bus off this machine's real socket.
    ASCENDA_LIVE_BUS_SOCKET: path.join(dir, "no-such.sock")
  };
}

test("every registered hook has a payload in this test", () => {
  assert.deepEqual([...CLAUDE_HOOK_EVENT_NAMES].sort(), Object.keys(PAYLOADS).sort());
});

for (const hook of CLAUDE_HOOK_EVENT_NAMES) {
  if (SENDS_NOTHING.has(hook)) continue;

  test(`${hook}: every event it sends reaches ingest carrying the payload's session_id`, async () => {
    await withIngest(async (apiBaseUrl, received) => {
      const env = pairedEnv(apiBaseUrl);
      const result = await runHook(hook, PAYLOADS[hook], env);
      assert.equal(result.status, 0, result.stderr);

      // SessionEnd only queues. The next hook of the same install delivers it.
      if (hook === "SessionEnd") {
        assert.equal(received.length, 0, "SessionEnd must not wait on the network");
        const next = await runHook("PreToolUse", PAYLOADS.PreToolUse, env);
        assert.equal(next.status, 0, next.stderr);
      }

      assert.ok(received.length > 0, `${hook} sent nothing`);
      for (const payload of received) {
        assert.equal(payload.sessionId, SESSION, `${payload.eventType} from ${hook} carried sessionId=${JSON.stringify(payload.sessionId)}`);
      }
    });
  });
}

test("a subagent's start and stop carry the parent session, its id and its class, and nothing it said", async () => {
  await withIngest(async (apiBaseUrl, received) => {
    const env = pairedEnv(apiBaseUrl);
    await runHook("SubagentStart", PAYLOADS.SubagentStart, env);
    await runHook("PreToolUse", { ...PAYLOADS.PreToolUse, agent_id: "agent-a1b2c3", agent_type: "Explore" }, env);
    await runHook("SubagentStop", PAYLOADS.SubagentStop, env);

    assert.deepEqual(received.map((p) => p.eventType), ["subagent_started", "ai_tool_call_started", "subagent_stopped"]);
    for (const payload of received) {
      assert.equal(payload.sessionId, SESSION);
      assert.equal(payload.metadata.subagentId, "agent-a1b2c3");
    }
    assert.equal(received[0].metadata.subagentClass, "explore");
    assert.equal(received[2].metadata.subagentClass, "explore");

    const wire = JSON.stringify(received);
    assert.ok(!wire.includes("subagents/agent-a1b2c3.jsonl"), "the transcript path never leaves");
    assert.ok(!wire.includes("\"done\""), "the subagent's last message never leaves");
    assert.ok(!wire.includes("Explore"), "the raw agent_type never leaves");
  });
});
