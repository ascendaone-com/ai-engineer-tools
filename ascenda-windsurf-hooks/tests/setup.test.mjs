import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeHookSettings } from "@ascenda-one/tool-kit";
import { HOOK_EVENTS, SETUP } from "../dist/setup.js";
import { mapWindsurfEvent } from "../dist/mapWindsurfEvent.js";

// The generic setup command is tested in tool-kit. What is this adapter's to
// prove: its spec lands hooks in the shape Cascade actually reads, registers
// only hooks that map to a catalog event, and the management commands run
// without waiting on a hook payload that will never arrive.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const BINARY = "/home/dev/.ascenda/bin/ascenda-windsurf-hook";
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("registers every hook that maps to a catalog event, in Cascade's own file shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-windsurf-setup-"));
  const file = SETUP.settings.settingsPath("project", dir);
  assert.equal(writeHookSettings(file, BINARY, SETUP, false), true);
  const settings = read(file);
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
  assert.match(settings.hooks.pre_user_prompt[0].command, /ascenda-windsurf-hook"$/, "Cascade names the hook on stdin, so one command serves every event");
  assert.equal(settings.hooks.post_cascade_response_with_transcript, undefined, "the transcript hook repeats the turn end and points at raw content");
  const input = { tool_info: { user_prompt: "x", command_line: "npm test", mcp_tool_name: "s", file_path: "/a" } };
  for (const event of HOOK_EVENTS) {
    assert.ok(mapWindsurfEvent(event, { agent_action_name: event, ...input }, 90 * 60000).length > 0, `${event} is registered but maps to nothing`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("settings live where Cascade looks for them", () => {
  assert.equal(SETUP.settings.settingsPath("project", "/p"), path.join("/p", ".windsurf", "hooks.json"));
  assert.equal(SETUP.settings.settingsPath("user", "/p"), path.join(os.homedir(), ".codeium", "windsurf", "hooks.json"));
  assert.equal(SETUP.host, "windsurf");
  assert.equal(SETUP.toolType, "cli_agent");
});

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-windsurf-cli-"));
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
  assert.match(result.stdout, /npx @ascenda-one\/windsurf-hooks setup/);
});

test("status on a fresh machine names what is missing and exits non-zero, so it can gate a CI step", () => {
  const result = run(["status", "--project-dir", os.tmpdir()]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /pairing\s+— not paired/);
  assert.match(result.stdout, new RegExp(`hooks\\s+0/${HOOK_EVENTS.length} registered`));
});

test("setup --dry-run writes nothing and exits 0 with no backend", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-windsurf-dry-"));
  const result = run(["setup", "--dry-run", "--project-dir", dir, "--api-base-url", "http://127.0.0.1:9"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run — nothing was written/);
  assert.equal(fs.existsSync(SETUP.settings.settingsPath("project", dir)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
