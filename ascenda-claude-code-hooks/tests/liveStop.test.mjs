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

async function linesFor(runs, settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-livestop-"));
  const socket = path.join(root, "live.sock");
  const received = [];
  const listener = net.createServer((connection) => {
    connection.on("data", (chunk) => received.push(...String(chunk).trim().split("\n")));
  });
  await new Promise((resolve) => listener.listen(socket, resolve));
  // Claude Code settings come only from this temporary home: no managed
  // file, and no project, so the developer's own auto-continue can't leak in.
  const env = {
    HOME: root,
    ASCENDA_HOME: path.join(root, ".ascenda"),
    ASCENDA_LIVE_BUS_SOCKET: socket,
    ASCENDA_CLAUDE_MANAGED_SETTINGS: path.join(root, "no-managed-settings.json"),
    CLAUDE_PROJECT_DIR: root
  };
  if (settings) {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify(settings));
  }
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

test("StopFailure is halted, with a usage limit told apart from the rest", async () => {
  const signals = await linesFor([
    ["StopFailure", { session_id: "s1", hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: "API Error: Rate limit reached" }],
    ["StopFailure", { session_id: "s2", hook_event_name: "StopFailure", error: "overloaded" }],
    ["StopFailure", { session_id: "s3", hook_event_name: "StopFailure" }]
  ]);
  assert.deepEqual(signals, [
    { tool: "claude_code", session: "s1", event: "halted", errorKind: "rate_limit" },
    { tool: "claude_code", session: "s2", event: "halted", errorKind: "error" },
    { tool: "claude_code", session: "s3", event: "halted", errorKind: "error" }
  ]);
});

test("errorKind comes from the payload's error field, never from the message", async () => {
  const [signal] = await linesFor([["StopFailure", {
    session_id: "s1",
    hook_event_name: "StopFailure",
    error: "server_error",
    last_assistant_message: "API Error: rate limit reached, usage limit hit",
    error_details: { type: "rate_limit", message: "rate_limit" }
  }]]);
  assert.deepEqual(signal, { tool: "claude_code", session: "s1", event: "halted", errorKind: "error" });
});

test("an idle-prompt halted carries no errorKind", async () => {
  const signals = await linesFor([
    ["Notification", { session_id: "s1", hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input", error: "rate_limit" }],
    ["Notification", { session_id: "s2", hook_event_name: "Notification", message: "Claude is waiting for your input" }]
  ]);
  assert.deepEqual(signals, [
    { tool: "claude_code", session: "s1", event: "halted" },
    { tool: "claude_code", session: "s2", event: "halted" }
  ]);
});

test("errorKind is always rate_limit or error, whatever the error field holds", async () => {
  const errors = ["rate_limit", "RATE_LIMIT", "rate limit", "server_error", "authentication_failed", "", 429, null, { kind: "rate_limit" }, ["rate_limit"]];
  const signals = await linesFor(errors.map((error, i) => ["StopFailure", { session_id: `s${i}`, hook_event_name: "StopFailure", error }]));
  assert.equal(signals.length, errors.length);
  for (const signal of signals) {
    assert.equal(signal.event, "halted");
    assert.ok(["rate_limit", "error"].includes(signal.errorKind), `unexpected errorKind ${JSON.stringify(signal.errorKind)}`);
  }
  assert.deepEqual(signals.map((s) => s.errorKind), ["rate_limit", ...Array(errors.length - 1).fill("error")]);
});

test("error \"unknown\" is an error, not a usage limit (P-D64.1)", async () => {
  const [signal] = await linesFor([["StopFailure", { session_id: "s1", hook_event_name: "StopFailure", error: "unknown" }]]);
  assert.deepEqual(signal, { tool: "claude_code", session: "s1", event: "halted", errorKind: "error" });
});

// A reset two hours from now, written the way Claude Code writes it, in UTC.
function resetInTwoHours() {
  const at = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const hour = at.getUTCHours();
  const minute = String(at.getUTCMinutes()).padStart(2, "0");
  const clock = `${hour % 12 === 0 ? 12 : hour % 12}:${minute}${hour < 12 ? "am" : "pm"}`;
  const expected = Math.round(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), hour, at.getUTCMinutes()) / 60_000) * 60;
  return { text: `You've hit your limit · resets ${clock} (UTC)`, expected };
}

test("a usage limit says when it resets, when Claude Code will carry on by itself (P-D64.2)", async () => {
  const { text, expected } = resetInTwoHours();
  const signals = await linesFor([
    ["StopFailure", { session_id: "s1", hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: text }],
    ["StopFailure", { session_id: "s2", hook_event_name: "StopFailure", error: "rate_limit", error_details: { type: "rate_limit", message: text } }],
    // Not a usage limit: the reset text is never read.
    ["StopFailure", { session_id: "s3", hook_event_name: "StopFailure", error: "server_error", last_assistant_message: text }]
  ], { autoContinueAtUsageLimit: true });
  assert.deepEqual(signals, [
    { tool: "claude_code", session: "s1", event: "halted", errorKind: "rate_limit", resumesAt: expected },
    { tool: "claude_code", session: "s2", event: "halted", errorKind: "rate_limit", resumesAt: expected },
    { tool: "claude_code", session: "s3", event: "halted", errorKind: "error" }
  ]);
  assert.ok(!JSON.stringify(signals).includes("hit your limit"), "the message itself never reaches the bus");
});

test("without auto-continue a usage limit has no reset to wait for", async () => {
  const { text } = resetInTwoHours();
  const [off, unset] = await Promise.all([
    linesFor([["StopFailure", { session_id: "s1", error: "rate_limit", last_assistant_message: text }]], { autoContinueAtUsageLimit: false }),
    linesFor([["StopFailure", { session_id: "s2", error: "rate_limit", last_assistant_message: text }]])
  ]);
  assert.deepEqual(off, [{ tool: "claude_code", session: "s1", event: "halted", errorKind: "rate_limit" }]);
  assert.deepEqual(unset, [{ tool: "claude_code", session: "s2", event: "halted", errorKind: "rate_limit" }]);
});
