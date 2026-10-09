// Shared by the CLI hook adapters' sessionOnTheWire tests.
//
// Runs a built hook CLI once per registered hook, paired against a stub
// ingest endpoint, and asserts every event that arrives carries the session
// the hook payload named. The adapters each pick their session id out of a
// different field (`session_id`, `conversation_id`, `trajectory_id`), so the
// fixture names the field and this checks the result on the wire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function withIngest(run) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.endsWith("/batch")) {
        received.push(...parsed.events);
        res.end(JSON.stringify({ results: parsed.events.map((_, index) => ({ index, status: "accepted" })) }));
        return;
      }
      received.push(parsed);
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

function runHook(cli, hook, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cli, hook], { env });
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${hook} timed out`)); }, 20_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stderr }); });
    child.stdin.end(JSON.stringify(input));
  });
}

/**
 * @param {object} spec
 * @param {string} spec.cli            Path to the adapter's built cli.js.
 * @param {string} spec.toolType       The adapter's pairing tool type.
 * @param {readonly string[]} spec.hooks  Every hook `setup` registers.
 * @param {Record<string, object>} spec.payloads  One payload per hook, without the session field.
 * @param {string} spec.sessionField   The payload field the adapter reads the session from.
 * @param {readonly string[]} [spec.silent]  Hooks registered for the local live bus alone, which send nothing.
 */
export function sessionOnTheWire({ cli, toolType, hooks, payloads, sessionField, silent = [] }) {
  const SESSION = "7d2e9c41-3a5b-4f80-b6c2-91e0a4d7f358";

  test("every registered hook has a payload in this test", () => {
    assert.deepEqual([...hooks].sort(), Object.keys(payloads).sort());
  });

  for (const hook of hooks) {
    const quiet = silent.includes(hook);
    test(quiet ? `${hook}: sends nothing to ingest` : `${hook}: every event it sends reaches ingest carrying the payload's ${sessionField}`, async () => {
      await withIngest(async (apiBaseUrl, received) => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-wire-"));
        const env = {
          ...process.env,
          HOME: home,
          ASCENDA_API_BASE_URL: apiBaseUrl,
          ASCENDA_TOOL_INSTALLATION_ID: `${toolType}:wire-0000`,
          ASCENDA_EVENT_WRITE_TOKEN: "tok_test",
          ASCENDA_EVENT_WRITE_TOKEN_FILE: path.join(home, "token"),
          ASCENDA_SESSION_ID: "",
          ASCENDA_EVENT_LOG_FILE: "",
          ASCENDA_LIVE_BUS_SOCKET: path.join(home, "no-such.sock")
        };
        const result = await runHook(cli, hook, { ...payloads[hook], [sessionField]: SESSION }, env);
        assert.equal(result.status, 0, result.stderr);
        if (quiet) {
          assert.equal(received.length, 0, `${hook} is registered for the live bus alone and sent ${received.length} events`);
          return;
        }
        assert.ok(received.length > 0, `${hook} sent nothing`);
        for (const payload of received) {
          assert.equal(payload.sessionId, SESSION, `${payload.eventType} from ${hook} carried sessionId=${JSON.stringify(payload.sessionId)}`);
        }
      });
    });
  }
}
