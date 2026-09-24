import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// An install with no pairing, end to end against the built CLI. The whole
// point of this mode is what reaches disk and what does not — the hook binary
// and nine registered events on one side, no token and no journal on the
// other — so every assertion here is about real files written by a real run.
//
// The reason the mode exists at all is one layer down, in cli.ts: the session
// prompts and the live socket signal are decided above `loadConfigFromEnv()`
// and never needed a pairing. Refusing to install left exactly the people
// still setting Ascenda up unable to reach them.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

function machine(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ascenda-${name}-`));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return {
    root,
    home,
    project,
    env: { HOME: home, ASCENDA_HOME: path.join(home, ".ascenda"), ASCENDA_TOOL_INSTALLATION_ID: "", ASCENDA_EVENT_WRITE_TOKEN: "" },
    credentials: () => JSON.parse(fs.readFileSync(path.join(home, ".ascenda", "credentials.json"), "utf8")),
    binary: () => path.join(home, ".ascenda", "bin", "ascenda-claude-hook"),
    userSettings: () => path.join(home, ".claude", "settings.json"),
    projectSettings: () => path.join(project, ".claude", "settings.local.json"),
    stateDir: () => path.join(home, ".ascenda", "state"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function run(machine, args, { env = {}, input = "", cwd } = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    input,
    cwd: cwd ?? machine.root,
    env: { ...process.env, ...machine.env, ...env }
  });
}

/**
 * The same run, without blocking this process. `spawnSync` would hold the
 * event loop, and the live-bus listener below runs here — it could never
 * accept the connection the child makes within the emit's 50 ms budget.
 */
function runAsync(machine, args, { env = {}, input = "" } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      cwd: machine.root,
      env: { ...process.env, ...machine.env, ...env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** A port nothing is listening on, for the interrupted-pairing case. */
async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function registeredEvents(settingsFile) {
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  return Object.keys(settings.hooks ?? {});
}

test("--no-pair installs the hooks and records an installation with no pairing", () => {
  const m = machine("nopair");
  const result = run(m, ["setup", "--no-pair", "--scope", "user", "--project-dir", m.project]);

  assert.equal(result.status, 0, result.stderr);
  // Which half is live has to be on the screen. A degrade that reads like a
  // success is how someone comes to believe they paired.
  assert.match(result.stdout, /Installed, not paired\./);
  assert.match(result.stdout, /inactive\s+delivery to/);
  assert.match(result.stdout, /active\s+the session prompts/);

  assert.ok(fs.existsSync(m.binary()), "the hook binary is installed");
  assert.equal(registeredEvents(m.userSettings()).length, 9);

  const credentials = m.credentials();
  assert.match(credentials.toolInstallationId, /^claude_code:/);
  assert.equal(credentials.localOnly, true);
  assert.ok(credentials.installedAt);
  // No invented pairing timestamp, and no token file anywhere: an unpaired
  // install must not look paired to anything that reads either.
  assert.equal(credentials.pairedAt, undefined);
  assert.equal(fs.existsSync(path.join(m.home, ".ascenda", "tokens")), false);
  m.cleanup();
});

test("--no-pairing is accepted too, and the disclosure says it applies once paired", () => {
  // `--no-pairing` is the spelling the shared CLI setup landed under first and
  // showed in a README. Both parse, so whichever page someone read, they get
  // the install.
  const m = machine("alias");
  const result = run(m, ["setup", "--no-pairing", "--scope", "user", "--project-dir", m.project]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(m.credentials().localOnly, true);
  assert.equal(registeredEvents(m.userSettings()).length, 9);

  // The pairing disclosure still prints — someone choosing to stay local is
  // entitled to know what pairing would cost — but it is framed as what
  // pairing would start, because right now it describes nothing.
  assert.match(result.stdout, /Nothing is sent from an install with no pairing\. What pairing would start sending:/);
  assert.match(result.stdout, /What this sends from Claude Code, once paired:/);
  m.cleanup();
});

test("a pairing that cannot reach the backend still finishes the install", async () => {
  const m = machine("unreachable");
  const port = await closedPort();
  const result = run(m, ["setup", "--api-base-url", `http://127.0.0.1:${port}`, "--project-dir", m.project]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pairing\s+none — could not reach/);
  assert.match(result.stdout, /Installed, not paired\./);
  assert.equal(registeredEvents(m.projectSettings()).length, 9);
  assert.equal(m.credentials().localOnly, true);
  m.cleanup();
});

test("a hook on an unpaired install emits on the live bus and journals nothing", async () => {
  const m = machine("hookrun");
  run(m, ["setup", "--no-pair", "--scope", "user", "--project-dir", m.project]);

  const socket = path.join(m.root, "live.sock");
  const received = [];
  const listener = net.createServer((connection) => {
    connection.on("data", (chunk) => received.push(...String(chunk).trim().split("\n")));
  });
  await new Promise((resolve) => listener.listen(socket, resolve));

  const env = { ASCENDA_LIVE_BUS_SOCKET: socket };
  const payload = { session_id: "s-local", cwd: m.project, tool_name: "Bash", tool_input: { command: "npm test" } };
  const tool = await runAsync(m, ["PreToolUse"], { env, input: JSON.stringify(payload) });
  const prompt = await runAsync(m, ["UserPromptSubmit"], { env, input: JSON.stringify({ session_id: "s-local", cwd: m.project, prompt: "hello" }) });

  await new Promise((resolve) => listener.close(resolve));

  assert.equal(tool.status, 0);
  assert.equal(prompt.status, 0);
  // The gauges are the reason this mode exists. They must be fed.
  assert.deepEqual(received.map((line) => JSON.parse(line).event), ["tool_call", "prompt_submitted"]);

  // Quiet, and deliberately so: no thrown error per event, and no journal
  // recording an outage that is not happening.
  assert.equal(tool.stderr, "");
  assert.equal(prompt.stderr, "");
  assert.equal(fs.existsSync(m.stateDir()), false, "an unpaired install has nothing to journal");

  // The session prompt is unaffected — it never depended on a pairing.
  const session = await runAsync(m, ["SessionStart"], { env, input: JSON.stringify({ session_id: "s-local", source: "startup", cwd: m.project }) });
  assert.match(session.stdout, /what would make this session count/);
  m.cleanup();
});

test("a pairing that lost its token is still an outage, not a quiet install", () => {
  const m = machine("brokenpairing");
  run(m, ["setup", "--no-pair", "--scope", "user", "--project-dir", m.project]);

  // Same files, minus the flag that says the absence was chosen. This is what
  // a revoked or deleted token looks like, and it has to keep shouting: the
  // quiet path is keyed to the flag, never to the missing token.
  const file = path.join(m.home, ".ascenda", "credentials.json");
  const credentials = m.credentials();
  delete credentials.localOnly;
  credentials.pairedAt = credentials.installedAt;
  delete credentials.installedAt;
  fs.writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`);

  const result = run(m, ["PreToolUse"], { input: JSON.stringify({ session_id: "s1", cwd: m.project, tool_name: "Bash", tool_input: { command: "npm test" } }) });
  assert.equal(result.status, 0, "and it still never breaks the turn");
  assert.match(result.stderr, /Missing ASCENDA_EVENT_WRITE_TOKEN/);
  m.cleanup();
});

test("status reports an unpaired install as installed, and exits 0", () => {
  const m = machine("status");
  run(m, ["setup", "--no-pair", "--scope", "user", "--project-dir", m.project]);

  const here = run(m, ["status", "--scope", "user"]);
  assert.equal(here.status, 0, "an install with no pairing is not a broken install");
  assert.match(here.stdout, /pairing\s+claude_code:\S+ \(not paired, installed /);
  assert.match(here.stdout, /delivery\s+inactive/);
  assert.match(here.stdout, /local features active/);
  assert.match(here.stdout, /hooks\s+9\/9 registered/);
  assert.match(here.stdout, /^version {8}(unreleased \(built from a checkout, not a release\)|\d+\.\d+\.\d+)$/m, "status names the running build");

  // The scope trap: `status` defaults to --scope project while this machine
  // was set up with --scope user. User settings apply in every project, so the
  // hooks found there answer the question and the install is not broken.
  const fromProject = run(m, ["status"], { cwd: m.project, env: { CLAUDE_PROJECT_DIR: m.project } });
  assert.equal(fromProject.status, 0, "hooks in the user file cover this project too");
  assert.match(fromProject.stdout, /9\/9 found in .*settings\.json \(--scope user\)/);
  m.cleanup();
});

test("doctor names the mode and skips the round trip it has no token for", () => {
  const m = machine("doctor");
  run(m, ["setup", "--no-pair", "--scope", "user", "--project-dir", m.project]);

  const result = run(m, ["doctor"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Mode\s+installed, not paired — local features active, telemetry inactive/);
  assert.match(result.stdout, /Token\s+none — this install has no pairing/);
  assert.match(result.stdout, /Nothing is sent from this install/);
  assert.doesNotMatch(result.stdout, /FAILED/);
  m.cleanup();
});

test("--dry-run --no-pair writes nothing and says so", () => {
  const m = machine("dryrun");
  const result = run(m, ["setup", "--no-pair", "--dry-run", "--scope", "user", "--project-dir", m.project]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run — nothing was written\./);
  assert.match(result.stdout, /pairing\s+none — asked not to pair/);
  assert.equal(fs.existsSync(path.join(m.home, ".ascenda", "credentials.json")), false);
  assert.equal(fs.existsSync(m.userSettings()), false);
  m.cleanup();
});

test("pairing later attaches to the installation setup recorded", async () => {
  const m = machine("attach");
  run(m, ["setup", "--no-pair", "--scope", "user", "--project-dir", m.project]);
  const installed = m.credentials().toolInstallationId;

  const asked = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/tool-pairing-sessions") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        asked.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pairingSessionId: "sess_1", code: "123456", expiresAt: new Date(Date.now() + 600_000).toISOString() }));
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "paired", toolInstallationId: asked.at(-1)?.toolInstallationId, eventWriteToken: "tok_test" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  // Async: the stub server is in this process, so a blocking spawn would
  // deadlock the poll it is waiting to answer.
  const child = spawn("node", [CLI, "pair"], {
    env: { ...process.env, ...m.env, ASCENDA_API_BASE_URL: url }
  });
  child.stdin.end();
  const status = await new Promise((resolve) => child.on("close", resolve));
  await new Promise((resolve) => server.close(resolve));

  assert.equal(status, 0);
  // The id in the settings file is the one that gets paired. Minting a second
  // one here would leave the registered hooks unpaired for good.
  assert.equal(asked.at(-1).toolInstallationId, installed);
  const credentials = m.credentials();
  assert.equal(credentials.toolInstallationId, installed);
  assert.equal(credentials.localOnly, undefined, "the flag is cleared by pairing");
  assert.ok(credentials.pairedAt);
  m.cleanup();
});

test("uninstall clears an unpaired install and leaves other tools' pairings alone", () => {
  const m = machine("uninstall");
  run(m, ["setup", "--no-pair", "--scope", "user", "--project-dir", m.project]);

  const file = path.join(m.home, ".ascenda", "credentials.json");
  const credentials = m.credentials();
  credentials.tools = { codex: { toolInstallationId: "cli_agent:xyz", pairedAt: "2026-09-01T00:00:00.000Z" } };
  fs.writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`);

  const result = run(m, ["uninstall", "--scope", "user"]);
  assert.equal(result.status, 0, result.stderr);
  // Nothing was ever sent from this install, so there is nothing to revoke.
  assert.match(result.stdout, /never paired, so there is no token here/);

  assert.equal(fs.existsSync(m.binary()), false);
  assert.equal(JSON.parse(fs.readFileSync(m.userSettings(), "utf8")).hooks, undefined);
  const left = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(left.toolInstallationId, undefined, "this tool's record is gone");
  assert.equal(left.tools.codex.toolInstallationId, "cli_agent:xyz", "another agent's pairing survives");
  m.cleanup();
});
