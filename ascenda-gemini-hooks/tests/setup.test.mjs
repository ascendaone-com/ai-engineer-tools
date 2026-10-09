import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeHookSettings } from "@ascenda-one/tool-kit";
import { HOOK_EVENTS, HOOK_SET, SETUP } from "../dist/setup.js";
import { liveSignalFor } from "../dist/liveSignal.js";
import { mapGeminiEvent } from "../dist/mapGeminiEvent.js";

// The generic setup command is tested in tool-kit. What is this adapter's to
// prove: its spec lands hooks in the shape Gemini CLI actually reads,
// registers only hooks that map to a catalog event, and the management
// commands run without waiting on a hook payload that will never arrive.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const BINARY = "/home/dev/.ascenda/bin/ascenda-gemini-hook";
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("registers every hook that maps to a catalog event, in Gemini's own nested shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-gemini-setup-"));
  const file = SETUP.settings.settingsPath("project", dir);
  assert.equal(writeHookSettings(file, BINARY, SETUP, false), true);
  const settings = read(file);
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
  const group = settings.hooks.AfterTool[0];
  assert.equal(group.hooks[0].type, "command");
  assert.equal(group.hooks[0].timeout, 5, "must not inherit the default timeout");
  assert.match(group.hooks[0].command, /ascenda-gemini-hook" --hook-set 2$/, "Gemini names the hook on stdin, so one command serves every event");
  // Per-inference hooks would multiply volume for signal the tool hooks already carry.
  assert.equal(settings.hooks.AfterModel, undefined);
  // Every registered hook must earn its process: a catalog event, or — for
  // `Notification` alone today — a live-bus beat the desktop app renders.
  for (const event of HOOK_EVENTS) {
    const input = { hook_event_name: event, prompt: "x", tool_name: "run_shell_command", notification_type: "ToolPermission" };
    const cloud = mapGeminiEvent(event, input, 90 * 60000).length > 0;
    const live = liveSignalFor(event, input) !== undefined;
    assert.ok(cloud || live, `${event} is registered but maps to nothing`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the hook set moves with the list it versions", () => {
  // Set 2 is the eight events with Notification. Change the list, bump the
  // set, and the app's kCurrentHookSets with it.
  assert.equal(HOOK_SET, 2);
  assert.equal(SETUP.hookSet, HOOK_SET);
  assert.equal(HOOK_EVENTS.length, 8);
  assert.ok(HOOK_EVENTS.includes("Notification"));
});

test("settings live where Gemini CLI looks for them", () => {
  assert.equal(SETUP.settings.settingsPath("project", "/p"), path.join("/p", ".gemini", "settings.json"));
  assert.equal(SETUP.settings.settingsPath("user", "/p"), path.join(os.homedir(), ".gemini", "settings.json"));
  assert.equal(SETUP.host, "gemini_cli");
  assert.equal(SETUP.toolType, "cli_agent");
});

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-gemini-cli-"));
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
  assert.match(result.stdout, /npx @ascenda-one\/gemini-hooks setup/);
});

test("status on a fresh machine names what is missing and exits non-zero, so it can gate a CI step", () => {
  const result = run(["status", "--project-dir", os.tmpdir()]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^version {8}(unreleased \(built from a checkout, not a release\)|\d+\.\d+\.\d+)$/m, "status names the running build");
  assert.match(result.stdout, /pairing\s+— not paired/);
  assert.match(result.stdout, new RegExp(`hooks\\s+0/${HOOK_EVENTS.length} registered`));
});

test("setup --dry-run writes nothing and exits 0 with no backend", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-gemini-dry-"));
  const result = run(["setup", "--dry-run", "--project-dir", dir, "--api-base-url", "http://127.0.0.1:9"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run\. Nothing was written/);
  assert.equal(fs.existsSync(SETUP.settings.settingsPath("project", dir)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
