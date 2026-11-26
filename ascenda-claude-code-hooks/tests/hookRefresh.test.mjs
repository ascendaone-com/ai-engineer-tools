import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A `setup` install's registration follows its bundle: the first hook of the
// day, run from ~/.ascenda/bin, adds the events this release registers. These
// run the built CLI from a sandboxed home, never the real one: the bundle is
// copied into the sandbox's ~/.ascenda/bin, which is what marks a run as the
// installed one.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

// The release the bundle was built as: stamped in CI, `unreleased` from a
// checkout, which never refreshes.
const VERSION = process.env.ASCENDA_COLLECTOR_VERSION?.trim().replace(/^v/, "") || "unreleased";

/** What a v0.1.23 install registered: seven events, no hook set, no failures. */
const OLD = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "Stop"];

function machine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-refresh-"));
  const home = path.join(root, "home");
  const bin = path.join(home, ".ascenda", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const launcher = path.join(bin, "ascenda-claude-hook");
  fs.copyFileSync(CLI, `${launcher}.mjs`);
  const userSettings = path.join(home, ".claude", "settings.json");
  const old = {
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: Object.fromEntries(OLD.map((event) => [event, [{ hooks: [{ type: "command", command: `"${launcher}" ${event}`, timeout: 5 }] }]]))
  };
  old.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "/opt/mine/guard.sh" }] });
  fs.writeFileSync(userSettings, `${JSON.stringify(old, null, 2)}\n`);
  return {
    root,
    home,
    bundle: `${launcher}.mjs`,
    userSettings,
    env: { ...process.env, HOME: home, ASCENDA_HOME: path.join(home, ".ascenda"), ASCENDA_TOOL_INSTALLATION_ID: "", ASCENDA_EVENT_WRITE_TOKEN: "", CLAUDE_PROJECT_DIR: "", CLAUDE_PLUGIN_ROOT: "", ASCENDA_API_BASE_URL: "http://127.0.0.1:1", ASCENDA_DISABLE_HOOK_REFRESH: "" },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function hook(m, script, event, extraEnv = {}) {
  return spawnSync("node", [script, event], {
    encoding: "utf8",
    timeout: 30_000,
    input: JSON.stringify({ session_id: "refresh-1", hook_event_name: event, source: "startup", cwd: m.root }),
    cwd: m.root,
    env: { ...m.env, ...extraEnv }
  });
}

const ourEvents = (file) => Object.entries(JSON.parse(fs.readFileSync(file, "utf8")).hooks)
  .filter(([, groups]) => groups.some((group) => group.hooks.some((h) => h.command.includes("ascenda-claude-hook"))))
  .map(([event]) => event);

test("the installed bundle brings an old registration up to this release, keeping the person's own hooks", () => {
  const m = machine();
  try {
    const result = hook(m, m.bundle, "SessionStart");
    assert.equal(result.status, 0, result.stderr);
    const after = JSON.parse(fs.readFileSync(m.userSettings, "utf8"));
    assert.deepEqual(after.permissions, { allow: ["Bash(ls:*)"] }, "settings outside the hooks stay");
    assert.ok(after.hooks.PreToolUse.some((group) => group.hooks.some((h) => h.command === "/opt/mine/guard.sh")), "the person's own hook stays");
    if (VERSION === "unreleased") {
      assert.deepEqual(ourEvents(m.userSettings), OLD, "a checkout build has no release to stamp, so it changes nothing");
      return;
    }
    const events = ourEvents(m.userSettings);
    assert.ok(events.includes("PostToolUseFailure"), "failed tool calls are registered");
    assert.ok(events.includes("Notification"), "waits are registered");
    for (const groups of Object.values(after.hooks)) {
      for (const group of groups) for (const h of group.hooks) if (h.command.includes("ascenda-claude-hook")) assert.match(h.command, /--hook-set \d+$/);
    }
    const record = JSON.parse(fs.readFileSync(path.join(m.home, ".ascenda", "state", "hook-registrations.json"), "utf8")).tools.claude_code.registrations[0];
    assert.equal(record.collectorVersion, VERSION);
    assert.equal(record.by, "refresh");
  } finally {
    m.cleanup();
  }
});

test("a run that isn't the installed bundle (npx, the plugin) never writes a registration", () => {
  const m = machine();
  try {
    const before = fs.readFileSync(m.userSettings, "utf8");
    assert.equal(hook(m, CLI, "SessionStart").status, 0);
    assert.equal(hook(m, CLI, "SessionStart", { CLAUDE_PLUGIN_ROOT: path.join(m.root, "plugin") }).status, 0);
    // The plugin's launcher runs the setup bundle in-process until its own
    // copy lands: same file, but the plugin's registration.
    assert.equal(hook(m, m.bundle, "SessionStart", { CLAUDE_PLUGIN_ROOT: path.join(m.root, "plugin") }).status, 0);
    assert.equal(fs.readFileSync(m.userSettings, "utf8"), before);
    assert.equal(fs.existsSync(path.join(m.home, ".ascenda", "state", "hook-refresh-claude_code.stamp")), false, "the check never started");
  } finally {
    m.cleanup();
  }
});

test("ASCENDA_DISABLE_HOOK_REFRESH keeps the registration as it is", () => {
  const m = machine();
  try {
    const before = fs.readFileSync(m.userSettings, "utf8");
    assert.equal(hook(m, m.bundle, "SessionStart", { ASCENDA_DISABLE_HOOK_REFRESH: "true" }).status, 0);
    assert.equal(fs.readFileSync(m.userSettings, "utf8"), before);
  } finally {
    m.cleanup();
  }
});

test("a hook's stdout stays one JSON document, or nothing, when a refresh runs", () => {
  const m = machine();
  try {
    const result = hook(m, m.bundle, "SessionStart");
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout.trim();
    if (out) assert.doesNotThrow(() => JSON.parse(out), `stdout must parse as JSON: ${out}`);
  } finally {
    m.cleanup();
  }
});

test("setup records the registration with this release, and doctor reports it", () => {
  const m = machine();
  try {
    fs.rmSync(m.userSettings);
    const setup = spawnSync("node", [CLI, "setup", "--no-pair"], { encoding: "utf8", timeout: 30_000, input: "", cwd: m.root, env: m.env });
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    const record = JSON.parse(fs.readFileSync(path.join(m.home, ".ascenda", "state", "hook-registrations.json"), "utf8")).tools.claude_code.registrations[0];
    assert.equal(fs.realpathSync(record.settingsFile), fs.realpathSync(m.userSettings));
    assert.equal(record.collectorVersion, VERSION);
    assert.equal(record.by, "setup");

    const doctor = spawnSync("node", [CLI, "doctor"], { encoding: "utf8", timeout: 30_000, input: "", cwd: m.root, env: { ...m.env, NO_COLOR: "1" } });
    assert.match(doctor.stdout, /Hook versions/);
    assert.match(doctor.stdout, /Installed bundle {4}/);
    assert.match(doctor.stdout, new RegExp(`written by ${VERSION.replace(/\./g, "\\.")} \\(setup`));
    assert.match(doctor.stdout, /Daily refresh {7}/);

    const status = spawnSync("node", [CLI, "status", "--scope", "user"], { encoding: "utf8", timeout: 30_000, input: "", cwd: m.root, env: m.env });
    assert.match(status.stdout, /^hook refresh {3}on, once a day/m);
  } finally {
    m.cleanup();
  }
});
