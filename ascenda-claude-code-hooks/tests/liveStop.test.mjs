import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// What a turn's end says on the live bus, against the built CLI and a real
// socket. The app decides "done" from these lines, so each case below is one
// way a stop can be something other than done.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

function runHook(hook, payload, env) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, hook], {
      env: { ...process.env, ASCENDA_TOOL_INSTALLATION_ID: "", ASCENDA_EVENT_WRITE_TOKEN: "", ...env }
    });
    child.on("close", (status) => resolve(status));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function linesFor(runs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-livestop-"));
  const socket = path.join(root, "live.sock");
  const received = [];
  const listener = net.createServer((connection) => {
    connection.on("data", (chunk) => received.push(...String(chunk).trim().split("\n")));
  });
  await new Promise((resolve) => listener.listen(socket, resolve));
  const env = { HOME: root, ASCENDA_HOME: path.join(root, ".ascenda"), ASCENDA_LIVE_BUS_SOCKET: socket };
  for (const [hook, payload] of runs) assert.equal(await runHook(hook, payload, env), 0);
  await new Promise((resolve) => listener.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  // `pid` depends on where the suite runs (present under a `claude`, absent
  // elsewhere) and is liveSignalPid.test.mjs's to check, so it is set aside
  // here after confirming it's a pid when present.
  return received.map((line) => {
    const { pid, ...signal } = JSON.parse(line);
    assert.ok(pid === undefined || Number.isInteger(pid), `pid must be absent or a pid, got ${pid}`);
    return signal;
  });
}

test("Stop counts the background tasks still running", async () => {
  const [signal] = await linesFor([["Stop", {
    session_id: "s1",
    background_tasks: [
      { id: "task-001", type: "shell", status: "running", description: "tail logs" },
      { id: "task-002", type: "subagent", status: "running" },
      { id: "task-003", type: "shell", status: "completed" }
    ]
  }]]);
  assert.deepEqual(signal, { tool: "claude_code", session: "s1", event: "stop", backgroundTasks: 2 });
});

test("Stop with an empty list says zero, and an older payload says nothing", async () => {
  const [empty, older] = await linesFor([
    ["Stop", { session_id: "s1", background_tasks: [] }],
    ["Stop", { session_id: "s2" }]
  ]);
  assert.equal(empty.backgroundTasks, 0);
  assert.equal("backgroundTasks" in older, false, "a count nobody measured is not a zero");
});

test("StopFailure is halted, with no reason riding along (P-D64)", async () => {
  const signals = await linesFor([
    ["StopFailure", { session_id: "s1", hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: "API Error: Rate limit reached" }],
    ["StopFailure", { session_id: "s2", hook_event_name: "StopFailure", error: "overloaded" }],
    ["StopFailure", { session_id: "s3", hook_event_name: "StopFailure" }]
  ]);
  assert.deepEqual(signals, [
    { tool: "claude_code", session: "s1", event: "halted" },
    { tool: "claude_code", session: "s2", event: "halted" },
    { tool: "claude_code", session: "s3", event: "halted" }
  ]);
});
