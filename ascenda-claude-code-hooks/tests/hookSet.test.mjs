import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Installs from before StopFailure keep their old hook list until setup runs
// again, and until then the app hears no `halted` from them. These run the
// built CLI against real files: the upgrade an old install gets from setup,
// what status says about one, and the set each live signal carries so the
// app can tell.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

/** The nine events a v0.1.31 install registered, unflagged. */
const BEFORE = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact", "Stop", "SessionEnd"];

function machine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hookset-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return {
    root,
    home,
    project,
    env: { HOME: home, ASCENDA_HOME: path.join(home, ".ascenda"), ASCENDA_TOOL_INSTALLATION_ID: "", ASCENDA_EVENT_WRITE_TOKEN: "", CLAUDE_PROJECT_DIR: "" },
    projectSettings: path.join(project, ".claude", "settings.local.json"),
    userSettings: path.join(home, ".claude", "settings.json"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function run(m, args) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    input: "",
    cwd: m.root,
    env: { ...process.env, ...m.env, ASCENDA_API_BASE_URL: "http://127.0.0.1:1" }
  });
}

/** A settings file as an older setup wrote it: our nine hooks, no flag, and one hook of the person's own. */
function seedOldInstall(file) {
  const hooks = Object.fromEntries(BEFORE.map((event) => [event, [{ hooks: [{ type: "command", command: `"/usr/bin/node" "/old/.ascenda/bin/ascenda-claude-hook" ${event}`, timeout: 5 }] }]]));
  hooks.Stop.unshift({ hooks: [{ type: "command", command: "say done" }] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: "opus", hooks }, null, 2));
}

test("setup upgrades an older install in place and says what it added", () => {
  const m = machine();
  try {
    seedOldInstall(m.projectSettings);
    const first = run(m, ["setup", "--no-pair", "--project-dir", m.project]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /upgraded: added StopFailure, Notification, SubagentStart, SubagentStop; hook set 1 → 3/);

    const settings = JSON.parse(fs.readFileSync(m.projectSettings, "utf8"));
    assert.equal(settings.model, "opus", "the rest of the file is the person's");
    assert.equal(Object.keys(settings.hooks).length, 13);
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const ours = groups.filter((g) => g.hooks.some((h) => h.command.includes("ascenda-claude-hook")));
      assert.equal(ours.length, 1, `${event} has exactly one of our hooks`);
      assert.match(ours[0].hooks[0].command, new RegExp(` ${event} --hook-set 3$`));
    }
    assert.equal(settings.hooks.Stop[0].hooks[0].command, "say done", "a hook the person wrote stays where it was");

    const again = run(m, ["setup", "--no-pair", "--project-dir", m.project]);
    assert.match(again.stdout, /13 events, already current/);
    assert.doesNotMatch(again.stdout, /upgraded:/, "a re-run that changed nothing claims nothing");
  } finally {
    m.cleanup();
  }
});

test("a first install lists nothing as added: everything is", () => {
  const m = machine();
  try {
    const result = run(m, ["setup", "--no-pair", "--project-dir", m.project]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /upgraded:/);
  } finally {
    m.cleanup();
  }
});

test("status names an older hook set and the command that upgrades it", () => {
  const m = machine();
  try {
    seedOldInstall(m.userSettings);
    const result = run(m, ["status", "--scope", "user"]);
    assert.match(result.stdout, /hook set {7}1, this version registers 3\. Upgrade: npx @ascenda-one\/claude-code-hooks setup --scope user/);

    run(m, ["setup", "--no-pair", "--scope", "user"]);
    assert.match(run(m, ["status", "--scope", "user"]).stdout, /hook set {7}3 \(current\)/);
  } finally {
    m.cleanup();
  }
});

test("setup says so when the other scope registers the same hooks", () => {
  const m = machine();
  try {
    run(m, ["setup", "--no-pair", "--scope", "user"]);
    const result = run(m, ["setup", "--no-pair", "--project-dir", m.project]);
    assert.match(result.stdout, /registers these hooks too, so each event runs twice/);
    assert.ok(result.stdout.includes(m.userSettings));
  } finally {
    m.cleanup();
  }
});

/** Runs one hook with `args` and returns what reached the live socket. */
async function signalsFrom(args, payload, env = {}) {
  const root = fs.mkdtempSync("/tmp/asc-hs-");
  const socket = path.join(root, "l.sock");
  const lines = [];
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => lines.push(...chunk.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  try {
    const child = spawn("node", [CLI, ...args], {
      env: { ...process.env, HOME: root, ASCENDA_HOME: root, ASCENDA_LIVE_BUS_SOCKET: socket, ASCENDA_LOCAL_ONLY: "1", CLAUDE_PLUGIN_ROOT: "", ...env },
      stdio: ["pipe", "ignore", "ignore"]
    });
    child.stdin.end(JSON.stringify(payload));
    await new Promise((resolve) => child.on("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return lines;
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the live signal carries the set its registration names", async () => {
  const lines = await signalsFrom(["StopFailure", "--hook-set", "2"], { session_id: "s1", hook_event_name: "StopFailure", error: "rate_limit" });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "halted");
  assert.equal(lines[0].hookSet, 2);
});

test("an unflagged registration sends no set, which the app reads as set 1", async () => {
  const lines = await signalsFrom(["PreToolUse"], { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(lines.length, 1);
  assert.equal("hookSet" in lines[0], false);
});

test("a plugin hook says so, and a setup hook doesn't", async () => {
  const payload = { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } };
  const plugin = await signalsFrom(["PreToolUse"], payload, { CLAUDE_PLUGIN_ROOT: "/p/ascenda" });
  assert.equal(plugin[0].viaPlugin, true, "the app names a plugin update for this one, not setup");
  const installed = await signalsFrom(["PreToolUse", "--hook-set", "2"], payload);
  assert.equal("viaPlugin" in installed[0], false);
});

// hookSet is a positive integer or absent, viaPlugin is true or
// absent, and both come from the hook's own argv and environment.
test("a malformed set or an empty plugin root sends nothing, never a wrong value", async () => {
  const payload = { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } };
  for (const raw of ["0", "-1", "1.5", "0x2"]) {
    const [line] = await signalsFrom(["PreToolUse", "--hook-set", raw], payload);
    assert.equal("hookSet" in line, false, `--hook-set ${raw} must not reach the bus`);
  }
  const [line] = await signalsFrom(["PreToolUse", "--hook-set", "2"], payload, { CLAUDE_PLUGIN_ROOT: "" });
  assert.equal("viaPlugin" in line, false, "never viaPlugin: false");
});
