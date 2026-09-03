import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeHookSettings } from "@ascenda-one/tool-kit";
import { HOOK_EVENTS, SETUP } from "../dist/setup.js";
import { mapCursorEvent } from "../dist/mapCursorEvent.js";

// The generic setup command is tested in tool-kit. What is this adapter's to
// prove: its spec lands hooks in the shape Cursor actually reads, registers
// only hooks that map to a catalog event, and the management commands run
// without waiting on a hook payload that will never arrive.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const BINARY = "/home/dev/.ascenda/bin/ascenda-cursor-hook";
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("registers every hook that maps to a catalog event, in Cursor's own file shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-cursor-setup-"));
  const file = SETUP.settings.settingsPath("project", dir);
  assert.equal(writeHookSettings(file, BINARY, SETUP, false), true);
  const settings = read(file);
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
  assert.equal(settings.version, 1, "a Cursor hooks.json is versioned");
  assert.match(settings.hooks.stop[0].command, /ascenda-cursor-hook" stop$/, "Cursor reads the event from argv");
  // The specialised shell/MCP/file hooks would double-count; they must not be registered.
  assert.equal(settings.hooks.afterShellExecution, undefined);
  for (const event of HOOK_EVENTS) {
    assert.ok(mapCursorEvent(event, { prompt: "x", tool_name: "Shell" }, 90 * 60000).length > 0, `${event} is registered but maps to nothing`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("settings live where Cursor looks for them", () => {
  assert.equal(SETUP.settings.settingsPath("project", "/p"), path.join("/p", ".cursor", "hooks.json"));
  assert.equal(SETUP.settings.settingsPath("user", "/p"), path.join(os.homedir(), ".cursor", "hooks.json"));
  assert.equal(SETUP.host, "cursor");
  assert.equal(SETUP.toolType, "cli_agent");
});

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-cursor-cli-"));
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
  assert.match(result.stdout, /npx @ascenda-one\/cursor-hooks setup/);
});

test("status on a fresh machine names what is missing and exits non-zero, so it can gate a CI step", () => {
  const result = run(["status", "--project-dir", os.tmpdir()]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /pairing\s+— not paired/);
  assert.match(result.stdout, new RegExp(`hooks\\s+0/${HOOK_EVENTS.length} registered`));
});

test("setup --dry-run writes nothing and exits 0 with no backend", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-cursor-dry-"));
  const result = run(["setup", "--dry-run", "--project-dir", dir, "--api-base-url", "http://127.0.0.1:9"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run — nothing was written/);
  assert.equal(fs.existsSync(SETUP.settings.settingsPath("project", dir)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
