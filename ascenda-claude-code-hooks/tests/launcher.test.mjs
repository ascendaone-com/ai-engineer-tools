import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The launcher stands between Claude Code and Node (see src/launcher.ts).
// What it must do is all observable from outside: run with no PATH to speak
// of, survive the recorded Node disappearing, and say plainly when there is
// no Node at all.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function installed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-launcher-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, ASCENDA_HOME: path.join(home, ".ascenda"), ASCENDA_TOOL_INSTALLATION_ID: "", ASCENDA_EVENT_WRITE_TOKEN: "", CLAUDE_PROJECT_DIR: "" };
  const setup = spawnSync("node", [CLI, "setup", "--no-pair"], { encoding: "utf8", cwd: root, env: { ...process.env, ...env } });
  assert.equal(setup.status, 0, setup.stderr);
  const bin = path.join(home, ".ascenda", "bin");
  return {
    root,
    home,
    env,
    launcher: path.join(bin, "ascenda-claude-hook"),
    bundle: path.join(bin, "ascenda-claude-hook.mjs"),
    record: path.join(bin, "ascenda-claude-hook.node"),
    missing: path.join(bin, "ascenda-claude-hook.no-node"),
    settings: path.join(home, ".claude", "settings.json"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

/** Runs the launcher the way Claude Code does: through a shell, with whatever environment it has. */
function launch(m, args, { path: searchPath = BARE_PATH, input = "", extra = {} } = {}) {
  return spawnSync("/bin/sh", ["-c", `"${m.launcher}" "$@"`, "sh", ...args], {
    encoding: "utf8",
    input,
    timeout: 30_000,
    env: { HOME: m.home, ASCENDA_HOME: m.env.ASCENDA_HOME, PATH: searchPath, ...extra }
  });
}

test("setup installs a shell launcher, the bundle beside it, and the Node that ran setup", { skip: process.platform === "win32" }, () => {
  const m = installed();
  try {
    assert.match(fs.readFileSync(m.launcher, "utf8"), /^#!\/bin\/sh\n/);
    assert.match(fs.readFileSync(m.bundle, "utf8"), /^#!\/usr\/bin\/env node/);
    assert.equal(fs.readFileSync(m.record, "utf8").trim(), process.execPath);
    assert.ok(fs.statSync(m.launcher).mode & 0o100, "the launcher is executable");

    // The command names the launcher alone, so no Node path is pinned in the
    // settings file for a version manager to pull out from under it.
    const command = JSON.parse(fs.readFileSync(m.settings, "utf8")).hooks.PreToolUse[0].hooks[0].command;
    assert.equal(command, `"${m.launcher}" PreToolUse --hook-set 3`);
  } finally {
    m.cleanup();
  }
});

test("a hook runs with a bare PATH, the way a Dock-launched Claude Code starts it", { skip: process.platform === "win32" }, () => {
  const m = installed();
  try {
    const result = launch(m, ["PreToolUse", "--hook-set", "3"], {
      input: JSON.stringify({ session_id: "s1", cwd: m.root, tool_name: "Bash", tool_input: { command: "ls" } })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const stamp = JSON.parse(fs.readFileSync(path.join(m.home, ".ascenda", "state", "claude_code-last-hook.json"), "utf8"));
    assert.equal(stamp.event, "PreToolUse");
    assert.deepEqual(Object.keys(stamp).sort(), ["at", "event"], "the stamp carries nothing from the payload");
  } finally {
    m.cleanup();
  }
});

test("when the recorded Node is gone, the launcher finds another and records it", { skip: process.platform === "win32" }, () => {
  const m = installed();
  try {
    fs.writeFileSync(m.record, "/nowhere/.nvm/versions/node/v18.0.0/bin/node\n");
    const probe = launch(m, [], { path: `${path.dirname(process.execPath)}:${BARE_PATH}`, extra: { ASCENDA_HOOK_LAUNCHER_PROBE: "1" } });
    assert.equal(probe.status, 0, probe.stderr);
    const [node, how] = probe.stdout.trim().split("\t");
    assert.equal(how, "found");
    assert.ok(fs.existsSync(node));
    assert.equal(fs.readFileSync(m.record, "utf8").trim(), node, "the find is recorded, so the next hook skips the search");

    const again = launch(m, [], { extra: { ASCENDA_HOOK_LAUNCHER_PROBE: "1" } });
    assert.equal(again.stdout.trim().split("\t")[1], "recorded");
  } finally {
    m.cleanup();
  }
});

// Only meaningful on a machine with no Node in the fixed locations the
// launcher checks, so it is skipped where one is installed there.
const fixedNode = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].some((p) => fs.existsSync(p));

test("with no Node anywhere, SessionStart says so and other hooks stay quiet", { skip: process.platform === "win32" || fixedNode }, () => {
  const m = installed();
  try {
    fs.writeFileSync(m.record, "/nowhere/node\n");
    const start = launch(m, ["SessionStart"], { input: "{}" });
    assert.equal(start.status, 1);
    assert.match(start.stderr, /cannot find Node 20 or newer/);
    assert.ok(fs.existsSync(m.missing), "status and doctor read this");

    const tool = launch(m, ["PreToolUse"], { input: "{}" });
    assert.equal(tool.status, 0, "one notice per session, not one per tool call");
    assert.equal(tool.stderr, "");
  } finally {
    m.cleanup();
  }
});

test("status names the Node the hooks will run and the last hook Claude Code ran", { skip: process.platform === "win32" }, () => {
  const m = installed();
  try {
    const before = spawnSync("node", [CLI, "status"], { encoding: "utf8", cwd: m.root, env: { ...process.env, ...m.env } });
    assert.match(before.stdout, /^node {11}\S+ \(v\d+/m);
    assert.match(before.stdout, /^last hook {6}— none has run yet/m);

    launch(m, ["Stop"], { input: JSON.stringify({ session_id: "s1", cwd: m.root }) });
    const after = spawnSync("node", [CLI, "status"], { encoding: "utf8", cwd: m.root, env: { ...process.env, ...m.env } });
    assert.match(after.stdout, /^last hook {6}Stop, \d+ s ago/m);
  } finally {
    m.cleanup();
  }
});

test("uninstall removes the launcher, the bundle and the record", { skip: process.platform === "win32" }, () => {
  const m = installed();
  try {
    const result = spawnSync("node", [CLI, "uninstall"], { encoding: "utf8", cwd: m.root, env: { ...process.env, ...m.env } });
    assert.equal(result.status, 0, result.stderr);
    for (const file of [m.launcher, m.bundle, m.record]) assert.equal(fs.existsSync(file), false, file);
  } finally {
    m.cleanup();
  }
});

test("doctor opens with the local half, which needs no pairing", { skip: process.platform === "win32" }, () => {
  const m = installed();
  try {
    const container = path.join(m.root, "saver");
    const result = spawnSync("node", [CLI, "doctor"], {
      encoding: "utf8",
      cwd: m.root,
      env: { ...process.env, ...m.env, ASCENDA_SAVER_CONTAINER: container, ASCENDA_LIVE_BUS_SOCKET: path.join(m.root, "none.sock") }
    });
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout;
    assert.match(out, /Live signal \(this machine; needs no pairing\)/);
    assert.match(out, /^ {2}✓ Node {17}\S+ \(v\d+/m);
    assert.match(out, /^ {2}✓ Hooks {16}13\/13 in ~\/\.claude\/settings\.json \(every project\)/m);
    assert.match(out, /^ {2}· Last hook {12}none yet/m);
    assert.match(out, /^ {2}· Screen saver {9}not running/m);
    assert.match(out, /^ {2}· Round trip {11}nobody is listening right now/m);
    // Nothing above is a fault on a fresh install, so it says so.
    assert.match(out, /✓ Ready\. The hooks can run/);
    // Piped, so plain: no escape codes in a captured or grepped doctor.
    assert.doesNotMatch(out, /\u001b\[/);
    assert.ok(out.indexOf("Live signal") < out.indexOf("Account sync"), "the local half comes first");
  } finally {
    m.cleanup();
  }
});
