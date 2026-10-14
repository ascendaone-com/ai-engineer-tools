/**
 * `participate <code>` end to end, against the local dev server.
 *
 * The adapters' own `setup` runs for real, from this checkout's built
 * bundles, and so does `import --ship`. Every run gets its own HOME and
 * ASCENDA_HOME, so nothing here can touch the machine's own ~/.ascenda,
 * ~/.claude/settings.json or ~/.claude/projects.
 *
 * Pairing confirms itself (the dev server auto-confirms). The join is left
 * pending where a test needs to refuse it, and the history-import consent
 * starts off, as it does on the real backend, so the only thing that can
 * turn it on is the join.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createDevServer } from "../../ascenda-dev-server/dist/server.js";
import { runParticipate } from "../dist/participate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const IMPORTER = path.resolve(HERE, "..", "dist", "cli.js");
const LINEAGE = path.join(HERE, "fixtures", "claude-store-lineage", "projects");
const CODE = "NORTHVIEW-2026";

async function startServer(options) {
  const dev = createDevServer({ historicalImportLease: false, log: () => {}, ...options });
  await new Promise((resolve) => dev.server.listen(0, "127.0.0.1", resolve));
  const { port } = dev.server.address();
  return { dev, base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => dev.server.close(resolve)) };
}

/** A machine with Claude Code (and its history) and Codex on it, and nothing of ours. */
function scratchMachine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-participate-home-"));
  fs.cpSync(LINEAGE, path.join(home, ".claude", "projects"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  return home;
}

/** Points this process and its children at the scratch machine. */
function useMachine(home) {
  process.env.HOME = home;
  process.env.ASCENDA_HOME = path.join(home, ".ascenda");
  return {
    ...process.env,
    HOME: home,
    ASCENDA_HOME: path.join(home, ".ascenda"),
    // Only Node's own folder: an agent installed on the machine running the
    // suite must not be found on PATH.
    PATH: path.dirname(process.execPath)
  };
}

/**
 * A terminal that answers the join with `join` and the retention question
 * with `retention`, each only once its question has been printed.
 */
function terminal({ join = "1", retention = "y" } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  let out = "";
  let answeredJoin = false;
  let answeredRetention = false;
  stdout.on("data", (chunk) => {
    out += chunk.toString();
    if (!answeredJoin && out.includes("Choice [Not now]:")) {
      answeredJoin = true;
      stdin.write(`${join}\n`);
    }
    if (!answeredRetention && out.includes("[y/N]")) {
      answeredRetention = true;
      stdin.write(`${retention}\n`);
    }
  });
  return { stdin, stdout, stderr: stdout, output: () => out.replace(/\u001b\[[0-9;]*m/g, "") };
}

function participate(env, term, argv, overrides = {}) {
  return runParticipate({
    argv,
    env,
    ...term,
    joinPollIntervalMs: 20,
    adapterCommand: (agent, args) => ({ command: process.execPath, args: [path.join(REPO, agent.workspaceDir, "dist", "cli.js"), ...args] }),
    importerCommand: (args) => ({ command: process.execPath, args: [IMPORTER, ...args] }),
    ...overrides
  });
}

/** Refuses the first join session that appears, as the confirming person or the backend would. */
function refuseJoinWhenStarted(dev, reason, grantedCodes = []) {
  const timer = setInterval(() => {
    for (const session of dev.state.studyJoins.values()) {
      if (session.status !== "pending") continue;
      session.status = "refused";
      session.refusedReason = reason;
      const landed = session.grants.filter((grant) => grantedCodes.includes(grant.code));
      session.granted = landed.length ? landed : null;
      if (landed.some((grant) => grant.code === 507)) dev.state.historicalImportLease = true;
    }
  }, 10);
  return () => clearInterval(timer);
}

const historical = (dev) => dev.state.events.filter((event) => String(event.provenance).startsWith("historical_"));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("happy path: both agents paired, study joined, retention extended, history sent", async () => {
  const server = await startServer();
  const home = scratchMachine();
  const env = useMachine(home);
  try {
    const term = terminal();
    const code = await participate(env, term, [CODE, "--api-base-url", server.base, "--agents", "claude_code,codex"]);
    const out = term.output();

    assert.equal(code, 0, out);
    assert.match(out, /This needs 3 confirms in your browser: 2 to pair Claude Code, Codex CLI, then one to join the study/);
    assert.match(out, /Confirm 1 of 3:.*Claude Code/);
    assert.match(out, /Confirm 2 of 3:.*Codex CLI/);
    assert.match(out, /Confirm 3 of 3:.*join the study/);

    // Both agents paired as their own installations, hooks for every project.
    assert.equal(server.dev.state.tools.size, 2);
    const credentials = readJson(path.join(home, ".ascenda", "credentials.json"));
    assert.ok(credentials.toolInstallationId.startsWith("claude_code:"));
    assert.ok(credentials.tools.codex.toolInstallationId.startsWith("cli_agent:"));
    assert.ok(readJson(path.join(home, ".claude", "settings.json")).hooks.SessionStart, "Claude Code hooks at user scope");
    assert.ok(fs.existsSync(path.join(home, ".codex", "hooks.json")), "Codex hooks at user scope");

    // Joined, and remembered.
    const record = readJson(path.join(home, ".ascenda", "participation.json"));
    assert.equal(record.organisationName, "Northview Health");
    assert.deepEqual(record.granted.map((grant) => grant.code), [501, 507]);

    // Retention merged into Claude Code's settings, hooks kept.
    assert.equal(readJson(path.join(home, ".claude", "settings.json")).cleanupPeriodDays, 3650);

    // History sent as Claude Code's pairing, and all of it accepted.
    const sent = historical(server.dev);
    assert.ok(sent.length > 0, "the backfill reached the server");
    assert.ok(sent.every((event) => event.toolInstallationId === credentials.toolInstallationId));

    assert.match(out, /Agents\s+✓ Claude Code\s+collecting/);
    assert.match(out, /✓ Codex CLI\s+collecting/);
    assert.match(out, /Study\s+✓ Northview Health, a 30-day report/);
    assert.match(out, /window 13 Oct – 10 Nov 2026/);
    assert.match(out, /Retention\s+✓ 30 days \(default\) → 3650 days/);
    assert.match(out, new RegExp(`Backfill\\s+✓ ${sent.length} events sent: ${sent.length} accepted, 0 already there, 0 rejected`));
  } finally {
    await server.close();
  }
});

test("re-run: no new confirms, nothing joined twice, the backfill dedups", async () => {
  const server = await startServer();
  const home = scratchMachine();
  const env = useMachine(home);
  try {
    const argv = [CODE, "--api-base-url", server.base, "--agents", "claude_code,codex"];
    assert.equal(await participate(env, terminal(), argv), 0);
    const sessions = server.dev.state.sessions.size;
    const firstSend = historical(server.dev).length;

    const term = terminal();
    const code = await participate(env, term, argv);
    const out = term.output();

    assert.equal(code, 0, out);
    assert.match(out, /nothing needs confirming/);
    assert.equal(server.dev.state.sessions.size, sessions, "no second pairing");
    assert.equal(server.dev.state.studyJoins.size, 1, "no second join");
    assert.equal(historical(server.dev).length, firstSend, "nothing stored twice");
    assert.match(out, /Study\s+✓ Northview Health, a 30-day report \(joined earlier\)/);
    assert.match(out, /Retention\s+✓ 3650 days, unchanged/);
    assert.match(out, new RegExp(`${firstSend} events sent: 0 accepted, ${firstSend} already there, 0 rejected`));
  } finally {
    await server.close();
  }
});

test("refused join: agents still collect, nothing is sent, and the summary says why", async () => {
  const server = await startServer({ autoConfirmJoins: false });
  const home = scratchMachine();
  const env = useMachine(home);
  const stop = refuseJoinWhenStarted(server.dev, "declined");
  try {
    const term = terminal({ retention: "n" });
    const code = await participate(env, term, [CODE, "--api-base-url", server.base, "--agents", "claude_code"]);
    const out = term.output();

    assert.equal(code, 1, out);
    assert.match(out, /✓ Claude Code\s+collecting/);
    assert.match(out, /Study\s+✗ not joined: You declined the join\. Nothing was granted\./);
    assert.match(out, /Backfill\s+· skipped: the study didn't grant importing your history/);
    assert.match(out, /Retention\s+! 30 days \(default\), unchanged/);
    assert.equal(historical(server.dev).length, 0);
    assert.equal(fs.existsSync(path.join(home, ".ascenda", "participation.json")), false, "a refusal isn't remembered as a join");
    assert.equal(readJson(path.join(home, ".claude", "settings.json")).cleanupPeriodDays, undefined, "no means no");
    assert.match(out, /Run the same command again to finish/);
  } finally {
    stop();
    await server.close();
  }
});

test("missing 507: a join that only granted 501 skips the backfill", async () => {
  const server = await startServer({ autoConfirmJoins: false });
  const home = scratchMachine();
  const env = useMachine(home);
  const stop = refuseJoinWhenStarted(server.dev, "grant_failed", [501]);
  try {
    const term = terminal();
    const code = await participate(env, term, [CODE, "--api-base-url", server.base, "--agents", "claude_code"]);
    const out = term.output();

    assert.equal(code, 1, out);
    assert.match(out, /granted before it stopped: AI assistant data processing consent/);
    assert.match(out, /Backfill\s+· skipped: the study didn't grant importing your history/);
    assert.equal(server.dev.state.historicalImportLease, false);
    assert.equal(historical(server.dev).length, 0);
  } finally {
    stop();
    await server.close();
  }
});

test("missing 507 at the server: a remembered join can't buy a backfill in, and the send stops at the first batch", async () => {
  const server = await startServer();
  const home = scratchMachine();
  const env = useMachine(home);
  try {
    // Joined earlier, by this record; the server has no lease for it.
    fs.mkdirSync(path.join(home, ".ascenda"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ascenda", "participation.json"), JSON.stringify({
      joinCode: CODE,
      apiBaseUrl: server.base,
      organisationName: "Northview Health",
      studyKind: "Report30",
      windowStartUtc: "2026-10-13T00:00:00.000Z",
      windowEndUtc: "2099-11-10T00:00:00.000Z",
      granted: [{ code: 501, name: "AiDataProcessing" }, { code: 507, name: "HistoricalImport" }],
      joinedAt: "2026-10-13T09:00:00.000Z"
    }));
    const term = terminal({ retention: "y" });
    const code = await participate(env, term, [CODE, "--api-base-url", server.base, "--agents", "claude_code"]);
    const out = term.output();

    assert.equal(code, 1, out);
    assert.match(out, /rejected: no history-import consent on the account/);
    assert.match(out, /stopped early: the account has no consent for a history import/);
    assert.equal(historical(server.dev).length, 0);
  } finally {
    await server.close();
  }
});

test("one agent's setup failing doesn't stop the others", async () => {
  const server = await startServer();
  const home = scratchMachine();
  const env = useMachine(home);
  try {
    const term = terminal();
    const code = await participate(env, term, [CODE, "--api-base-url", server.base, "--agents", "codex,claude_code", "--no-backfill"], {
      adapterCommand: (agent, args) => agent.id === "codex"
        ? { command: process.execPath, args: ["-e", "console.log('codex setup broke'); process.exit(3)"] }
        : { command: process.execPath, args: [path.join(REPO, agent.workspaceDir, "dist", "cli.js"), ...args] }
    });
    const out = term.output();

    assert.equal(code, 1, out);
    assert.match(out, /│ codex setup broke/);
    assert.match(out, /✗ Codex CLI\s+not collecting: setup exited 3/);
    assert.match(out, /✓ Claude Code\s+collecting/);
    assert.match(out, /Study\s+✓ Northview Health/, "the join went ahead on the agent that paired");
    assert.match(out, /Backfill\s+· skipped: --no-backfill/);
  } finally {
    await server.close();
  }
});

test("no terminal: retention is not changed without a flag, and the join is not attempted silently", async () => {
  const server = await startServer();
  const home = scratchMachine();
  const env = useMachine(home);
  try {
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (chunk) => (out += chunk.toString()));
    const code = await participate(env, { stdin: new PassThrough(), stdout, stderr: stdout }, [CODE, "--api-base-url", server.base, "--agents", "claude_code"]);

    assert.equal(code, 1, out);
    assert.match(out, /join needs an interactive terminal/);
    assert.match(out, /Not changed: no terminal to ask in\. Run with --fix-retention/);
    assert.equal(server.dev.state.studyJoins.size, 0);
    assert.equal(readJson(path.join(home, ".claude", "settings.json")).cleanupPeriodDays, undefined);
  } finally {
    await server.close();
  }
});

test("no agent on the machine: says so and stops", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-participate-empty-"));
  const env = useMachine(home);
  const term = terminal();
  const code = await participate(env, term, [CODE, "--api-base-url", "http://127.0.0.1:9"]);
  assert.equal(code, 1);
  assert.match(term.output(), /No AI agent found on this machine/);
});

test("the code is required, and only one", async () => {
  const term = terminal();
  assert.equal(await runParticipate({ argv: [], ...term }), 1);
  assert.match(term.output(), /needs the code your organisation gave you/);
  const again = terminal();
  assert.equal(await runParticipate({ argv: ["A", "B"], ...again }), 1);
  assert.match(again.output(), /one code only/);
});
