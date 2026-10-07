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

test("the live signal carries the claude process's pid", { skip: process.platform !== "darwin" }, async () => {
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
    require("child_process").spawnSync("/bin/sh", ["-c", ${JSON.stringify(`"${process.execPath}" "${CLI}" PreToolUse`)}], {
      input: JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }),
      stdio: ["pipe", "ignore", "ignore"]
    });`;
  try {
    const child = spawn(claude, ["-e", script], {
      env: { ...process.env, ASCENDA_LIVE_BUS_SOCKET: socket, ASCENDA_LOCAL_ONLY: "1" },
      stdio: "ignore"
    });
    await new Promise((resolve) => child.on("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "tool_call");
    assert.equal(lines[0].session, "s1", "the session still rides along for an app that doesn't read pid");
    assert.equal(lines[0].pid, child.pid);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
