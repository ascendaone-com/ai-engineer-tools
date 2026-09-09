import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeHookSettings } from "@ascenda-one/tool-kit";
import { HOOK_EVENTS, SETUP } from "../dist/setup.js";
import { mapCodexEvent } from "../dist/mapCodexEvent.js";

// The generic setup command is tested in tool-kit. What is this adapter's to
// prove: its spec lands hooks in the shape Codex actually reads, registers
// only hooks that map to a catalog event, and the management commands run
// without waiting on a hook payload that will never arrive.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const BINARY = "/home/dev/.ascenda/bin/ascenda-codex-hook";
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("registers every hook that maps to a catalog event, in Codex's own file shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-codex-setup-"));
  const file = SETUP.settings.settingsPath("project", dir);
  assert.equal(writeHookSettings(file, BINARY, SETUP, false), true);
  const settings = read(file);
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
  // Codex nests { hooks: [{ type, command }] } under each event and reads the
  // event from argv, so the name has to survive onto the command line.
  assert.equal(settings.hooks.Stop[0].hooks[0].type, "command");
  assert.match(settings.hooks.Stop[0].hooks[0].command, /ascenda-codex-hook" Stop$/);
  // Approvals and subagent lifecycle map to nothing; registering them would
  // spend a process per approval to send an empty list.
  assert.equal(settings.hooks.PermissionRequest, undefined);
  assert.equal(settings.hooks.SubagentStart, undefined);
  for (const event of HOOK_EVENTS) {
    assert.ok(mapCodexEvent(event, { prompt: "x", tool_name: "shell" }, 90 * 60000).length > 0, `${event} is registered but maps to nothing`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the written file agrees with the hand-merge example it replaces", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-codex-example-"));
  const file = SETUP.settings.settingsPath("project", dir);
  writeHookSettings(file, BINARY, SETUP, false);
  const written = read(file);
  const example = read(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples/hooks.json"));
  assert.deepEqual(Object.keys(written.hooks).sort(), Object.keys(example.hooks).sort(), "setup and the example must register the same events");
  assert.equal(written.hooks.Stop[0].hooks[0].timeout, example.hooks.Stop[0].hooks[0].timeout, "one timeout, not two");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("settings live where Codex looks for them", () => {
  assert.equal(SETUP.settings.settingsPath("project", "/p"), path.join("/p", ".codex", "hooks.json"));
  assert.equal(SETUP.settings.settingsPath("user", "/p"), path.join(os.homedir(), ".codex", "hooks.json"));
  assert.equal(SETUP.host, "codex");
  assert.equal(SETUP.toolType, "cli_agent");
});

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-codex-cli-"));
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    input: "", // stdin closed at once: a management command must not wait on it
    timeout: 15_000,
    env: { ...process.env, HOME: home, ASCENDA_HOME: home, ASCENDA_STATE_DIR: path.join(home, "state"), ASCENDA_TOOL_INSTALLATION_ID: "" }
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

test("--help prints usage and exits 0 without reading a hook payload", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npx @ascenda-one\/codex-hooks setup/);
});

test("status on a fresh machine names what is missing and exits non-zero, so it can gate a CI step", () => {
  const result = run(["status", "--project-dir", os.tmpdir()]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /pairing\s+— not paired/);
  assert.match(result.stdout, new RegExp(`hooks\\s+0/${HOOK_EVENTS.length} registered`));
});

test("setup --dry-run writes nothing and exits 0 with no backend", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-codex-dry-"));
  const result = run(["setup", "--dry-run", "--project-dir", dir, "--api-base-url", "http://127.0.0.1:9"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run — nothing was written/);
  assert.equal(fs.existsSync(SETUP.settings.settingsPath("project", dir)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a hook invocation still exits 0, even unconfigured", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-codex-hook-"));
  const result = spawnSync("node", [CLI, "SessionStart"], {
    encoding: "utf8",
    input: JSON.stringify({ session_id: "s1" }),
    timeout: 15_000,
    env: { ...process.env, HOME: home, ASCENDA_HOME: home, ASCENDA_STATE_DIR: path.join(home, "state"), ASCENDA_TOOL_INSTALLATION_ID: "" }
  });
  assert.equal(result.status, 0, "exit 2 would block the user's turn; any non-zero reads as hook failure");
  fs.rmSync(home, { recursive: true, force: true });
});
