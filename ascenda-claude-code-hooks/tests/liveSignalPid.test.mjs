import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The live signal names the `claude` process the hook ran under, found by
// walking up through the shell Claude Code spawns hooks with. Run for real:
// a `claude` (node under that name) runs `sh -c "node cli.js PreToolUse"`,
// and the signal on the socket has to carry that process's PID.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

/**
 * Runs the built CLI for `hook` with `payload` the way Claude Code does: a
 * process named `claude` spawns `sh -c "node cli.js <hook>"`. Resolves with
 * the lines that reached the socket and the `claude` process's pid.
 */
async function underClaude(hook, payload) {
  // Short root: a Unix socket path caps out near 104 bytes.
  const root = fs.mkdtempSync("/tmp/asc-pid-");
  const claude = path.join(root, "claude");
  fs.symlinkSync(process.execPath, claude);
  const socket = path.join(root, "l.sock");

  const lines = [];
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => lines.push(...chunk.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
  });
  await new Promise((resolve) => server.listen(socket, resolve));

  const script = `
    require("child_process").spawnSync("/bin/sh", ["-c", ${JSON.stringify(`"${process.execPath}" "${CLI}" ${hook}`)}], {
      input: ${JSON.stringify(JSON.stringify(payload))},
      stdio: ["pipe", "ignore", "ignore"]
    });`;
  try {
    const child = spawn(claude, ["-e", script], {
      env: { ...process.env, ASCENDA_LIVE_BUS_SOCKET: socket, ASCENDA_LOCAL_ONLY: "1" },
      stdio: "ignore"
    });
    await new Promise((resolve) => child.on("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { lines, pid: child.pid };
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const onMac = { skip: process.platform !== "darwin" };

test("the live signal carries the claude process's pid", onMac, async () => {
  const { lines, pid } = await underClaude("PreToolUse", { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "tool_call");
  assert.equal(lines[0].session, "s1", "the session still rides along for an app that doesn't read pid");
  assert.equal(lines[0].pid, pid);
});

// The app keys an `awaiting` state by the same stream as the work it parks.
// Without the pid it would park a different stream from the one working.
test("a permission prompt's awaiting carries the claude process's pid", onMac, async () => {
  const { lines, pid } = await underClaude("Notification", {
    session_id: "s1",
    hook_event_name: "Notification",
    notification_type: "permission_prompt",
    message: "Claude needs your permission to use Bash"
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "awaiting");
  assert.equal(lines[0].pid, pid);
});

test("AskUserQuestion's awaiting carries the claude process's pid", onMac, async () => {
  const { lines, pid } = await underClaude("PreToolUse", { session_id: "s1", tool_name: "AskUserQuestion", tool_input: { questions: [] } });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "awaiting");
  assert.equal(lines[0].pid, pid);
});

test("a StopFailure halted carries the claude process's pid", onMac, async () => {
  const { lines, pid } = await underClaude("StopFailure", { session_id: "s1", hook_event_name: "StopFailure", error: "rate_limit" });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "halted");
  assert.equal("errorKind" in lines[0], false, "halted carries no reason");
  assert.equal(lines[0].pid, pid);
});

test("a stop carries the claude process's pid alongside its backgroundTasks", onMac, async () => {
  const { lines, pid } = await underClaude("Stop", { session_id: "s1", background_tasks: [{ id: "t1", status: "running" }] });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "stop");
  assert.equal(lines[0].backgroundTasks, 1);
  assert.equal(lines[0].pid, pid);
});
