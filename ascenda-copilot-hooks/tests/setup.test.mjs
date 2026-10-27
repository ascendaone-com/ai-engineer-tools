import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeHookSettings } from "@ascenda-one/tool-kit";
import { HOOK_EVENTS, SETUP } from "../dist/setup.js";
import { liveSignalFor } from "../dist/liveSignal.js";
import { mapCopilotEvent } from "../dist/mapCopilotEvent.js";

// The generic setup command is tested in tool-kit. What is this adapter's to
// prove: its spec writes the file Copilot CLI reads, in Copilot's shape,
// registers only hooks that map to something, and the management commands
// run without waiting on a hook payload that will never arrive.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const BINARY = "/home/dev/.ascenda/bin/ascenda-copilot-hook";
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("writes Copilot's version 1 file with one flat command per camelCase hook", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-setup-"));
  const file = SETUP.settings.settingsPath("project", dir);
  assert.equal(writeHookSettings(file, BINARY, SETUP, false), true);
  const settings = read(file);
  assert.equal(settings.version, 1);
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
  for (const event of HOOK_EVENTS) {
    assert.equal(settings.hooks[event].length, 1, `${event} registered once`);
    const [entry] = settings.hooks[event];
    assert.deepEqual(Object.keys(entry).sort(), ["bash", "timeoutSec", "type"]);
    assert.equal(entry.type, "command");
    assert.equal(entry.timeoutSec, 5);
    assert.ok(entry.bash.endsWith(`ascenda-copilot-hook" ${event}`) || entry.bash.endsWith(`ascenda-copilot-hook ${event}`), `the hook name rides argv: ${entry.bash}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registers no PascalCase alias and none of the hooks left out", () => {
  for (const event of HOOK_EVENTS) assert.match(event, /^[a-z]/, `${event} is an alias`);
  for (const event of ["userPromptTransformed", "permissionRequest", "notification", "errorOccurred"]) {
    assert.ok(!HOOK_EVENTS.includes(event), `${event} should not be registered`);
  }
  // Every registered hook must earn its process.
  for (const event of HOOK_EVENTS) {
    const input = { prompt: "x", toolName: "bash", toolCalls: [{ name: "view" }] };
    assert.ok(mapCopilotEvent(event, input, 90 * 60000).length > 0 || liveSignalFor(event, input) !== undefined, `${event} is registered but maps to nothing`);
  }
});

test("the file lives where Copilot CLI looks, and follows COPILOT_HOME for the user scope only", () => {
  const previous = process.env.COPILOT_HOME;
  try {
    delete process.env.COPILOT_HOME;
    assert.equal(SETUP.settings.settingsPath("user", "/p"), path.join(os.homedir(), ".copilot", "hooks", "ascenda.json"));
    process.env.COPILOT_HOME = "/opt/copilot-home";
    assert.equal(SETUP.settings.settingsPath("user", "/p"), path.join("/opt/copilot-home", "hooks", "ascenda.json"));
    assert.equal(SETUP.settings.settingsPath("project", "/p"), path.join("/p", ".github", "hooks", "ascenda.json"));
  } finally {
    if (previous === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previous;
  }
  assert.equal(SETUP.host, "copilot_cli");
  assert.equal(SETUP.toolType, "cli_agent");
  assert.equal(SETUP.settings.owned, true);
});

function run(args, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-cli-"));
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    input: "", // stdin closed at once: a management command must not wait on it
    timeout: 15_000,
    env: { ...process.env, HOME: home, ASCENDA_HOME: home, ASCENDA_STATE_DIR: path.join(home, "state"), ASCENDA_TOOL_INSTALLATION_ID: "", ...extraEnv }
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

test("--help prints usage and exits 0 without reading a hook payload", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npx @ascenda-one\/copilot-hooks setup/);
});

test("setup --no-pair writes ascenda.json under COPILOT_HOME, and uninstall deletes it", { skip: process.platform === "win32" }, () => {
  const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-project-"));
  const ascendaHome = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-ascenda-"));
  const env = { COPILOT_HOME: copilotHome, ASCENDA_HOME: ascendaHome };
  const file = path.join(copilotHome, "hooks", "ascenda.json");
  // Someone else's hooks file beside ours is never touched.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(copilotHome, "hooks", "other.json"), '{"version":1,"hooks":{}}');

  const setup = spawnSync("node", [CLI, "setup", "--no-pair", "--project-dir", project, "--api-base-url", "http://127.0.0.1:1"], {
    encoding: "utf8", input: "", timeout: 15_000, env: { ...process.env, ...env, ASCENDA_TOOL_INSTALLATION_ID: "" }
  });
  assert.equal(setup.status, 0, setup.stderr + setup.stdout);
  assert.deepEqual(Object.keys(read(file).hooks).sort(), [...HOOK_EVENTS].sort());
  assert.ok(read(file).hooks.postToolUse[0].bash.includes(path.join(ascendaHome, "bin", "ascenda-copilot-hook")), "runs the installed launcher");

  const uninstall = spawnSync("node", [CLI, "uninstall", "--project-dir", project], {
    encoding: "utf8", input: "", timeout: 15_000, env: { ...process.env, ...env }
  });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(fs.existsSync(file), false, "ascenda.json is gone");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["other.json"], "and nothing of ours is left beside it");

  for (const dir of [copilotHome, project, ascendaHome]) fs.rmSync(dir, { recursive: true, force: true });
});

test("status on a fresh machine names what is missing and exits non-zero", () => {
  const result = run(["status", "--project-dir", os.tmpdir()], { COPILOT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-empty-")) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /pairing\s+— not paired/);
  assert.match(result.stdout, new RegExp(`hooks\\s+0/${HOOK_EVENTS.length} registered`));
});

test("setup --dry-run writes nothing and exits 0 with no backend", () => {
  const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-dry-"));
  const result = run(["setup", "--dry-run", "--api-base-url", "http://127.0.0.1:9"], { COPILOT_HOME: copilotHome });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run\. Nothing was written/);
  assert.equal(fs.existsSync(path.join(copilotHome, "hooks", "ascenda.json")), false);
  fs.rmSync(copilotHome, { recursive: true, force: true });
});
