/**
 * Git history in `participate`, `import --git` and `schedule install`.
 *
 * The confirm page offers git as an unticked box, and the CLI never sends
 * the choice. It reads the result, `importStores`, and passes `--git` to the
 * backfill only when that contains `git`. These run against the local dev
 * server, whose `tickGit` stands for the person ticking the box and whose
 * `gitGranted` for a grant made somewhere else.
 *
 * The machine has a real git repository with two commits, named as the cwd
 * of one Claude Code session, which is how the extractor finds it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createDevServer } from "../../ascenda-dev-server/dist/server.js";
import { readImportStores, runParticipate } from "../dist/participate.js";
import { scheduledCommand, scheduleStatus, installSchedule } from "../dist/schedule.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const IMPORTER = path.resolve(HERE, "..", "dist", "cli.js");
const CODE = "NORTHVIEW-2026";
const ME = "me@example.test";
const GIT_DIR = path.dirname(execFileSync("which", ["git"], { encoding: "utf8" }).trim());

async function startServer(options) {
  const dev = createDevServer({ historicalImportLease: false, log: () => {}, ...options });
  await new Promise((resolve) => dev.server.listen(0, "127.0.0.1", resolve));
  const { port } = dev.server.address();
  return { dev, base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => dev.server.close(resolve)) };
}

function git(repo, args, env = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env },
    encoding: "utf8"
  });
}

/** A machine with Claude Code on it, one session whose cwd is a repository with two commits of mine. */
function gitMachine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-participate-git-"));
  const repo = path.join(home, "work", "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", ME]);
  git(repo, ["config", "user.name", "Me"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  for (const [file, when] of [["a.txt", day(3)], ["b.txt", day(2)]]) {
    fs.writeFileSync(path.join(repo, file), "one\ntwo\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "SECRET subject"], {
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
      GIT_AUTHOR_NAME: "Me",
      GIT_AUTHOR_EMAIL: ME,
      GIT_COMMITTER_NAME: "Me",
      GIT_COMMITTER_EMAIL: ME
    });
  }

  const project = path.join(home, ".claude", "projects", repo.replace(/[/.]/g, "-"));
  fs.mkdirSync(project, { recursive: true });
  const at = (n) => new Date(Date.now() - 2 * 86_400_000 + n * 1000).toISOString();
  const lines = [
    { parentUuid: null, isSidechain: false, userType: "external", cwd: repo, sessionId: "s-git", version: "2.1.240", gitBranch: "main", type: "user", message: { role: "user", content: "Tidy the readme." }, uuid: "00000000-0000-4000-8000-0000000000a1", timestamp: at(0), origin: { kind: "human" } },
    { parentUuid: "00000000-0000-4000-8000-0000000000a1", isSidechain: false, cwd: repo, sessionId: "s-git", version: "2.1.240", type: "assistant", message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: { input_tokens: 1, output_tokens: 1 } }, uuid: "00000000-0000-4000-8000-0000000000a2", timestamp: at(10) }
  ];
  fs.writeFileSync(path.join(project, "s-git.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return home;
}

function useMachine(home) {
  process.env.HOME = home;
  process.env.ASCENDA_HOME = path.join(home, ".ascenda");
  // No pairing from the shell running the suite: the importer would ship as it.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ASCENDA_")));
  // Node and git only: an agent installed on the machine running the suite must not be found.
  return { ...inherited, HOME: home, ASCENDA_HOME: path.join(home, ".ascenda"), PATH: [path.dirname(process.execPath), GIT_DIR].join(path.delimiter) };
}

function terminal() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  let out = "";
  let answered = false;
  stdout.on("data", (chunk) => {
    out += chunk.toString();
    if (!answered && out.includes("[y/N]")) {
      answered = true;
      stdin.write("n\n");
    }
    if (out.endsWith("Choice [Not now]: ")) stdin.write("1\n");
  });
  return { stdin, stdout, stderr: stdout, output: () => out.replace(/\u001b\[[0-9;]*m/g, "") };
}

/** Runs participate for Claude Code alone, and keeps the importer's arguments. */
async function participate(env, argv) {
  const term = terminal();
  const importerArgs = [];
  const code = await runParticipate({
    argv: [...argv, "--agents", "claude_code"],
    env,
    ...term,
    joinPollIntervalMs: 20,
    adapterCommand: (agent, args) => ({ command: process.execPath, args: [path.join(REPO, agent.workspaceDir, "dist", "cli.js"), ...args] }),
    importerCommand: (args) => {
      importerArgs.push(args);
      return { command: process.execPath, args: [IMPORTER, ...args] };
    }
  });
  return { code, out: term.output(), importerArgs };
}

const forge = (dev) => dev.state.events.filter((event) => event.source === "code_forge");
const record = (home) => JSON.parse(fs.readFileSync(path.join(home, ".ascenda", "participation.json"), "utf8"));

test("git ticked on the page: the offer is announced, --git is passed, and the commits ship", async () => {
  const server = await startServer({ tickGit: true });
  const home = gitMachine();
  const env = useMachine(home);
  try {
    const { code, out, importerArgs } = await participate(env, [CODE, "--api-base-url", server.base]);

    assert.equal(code, 0, out);
    assert.match(out, /This also joins Northview Health/);
    assert.match(out, /unticked box for git history: commit times, size buckets, files changed and whether each is a merge\. No messages, paths, names or emails\./);
    assert.ok(out.indexOf("unticked box for git history") < out.indexOf("Open this link to confirm"), "the offer comes before the link");
    assert.ok(importerArgs[0].includes("--git"), JSON.stringify(importerArgs));
    assert.equal(forge(server.dev).length, 2, "both commits shipped");
    assert.ok(forge(server.dev).every((event) => !JSON.stringify(event).includes("SECRET")), "no commit message on the wire");
    assert.ok(record(home).importStores.includes("git"));
    assert.match(out, /Git history: included\. Your history-import grant covers git\./);
    assert.match(out, /Git\s+✓ included: your history-import grant covers git/);
  } finally {
    await server.close();
  }
});

test("git left unticked: no --git, nothing from git is sent, and the summary says why", async () => {
  const server = await startServer();
  const home = gitMachine();
  const env = useMachine(home);
  try {
    const { code, out, importerArgs } = await participate(env, [CODE, "--api-base-url", server.base]);

    assert.equal(code, 0, out);
    assert.match(out, /unticked box for git history/);
    assert.ok(!importerArgs[0].includes("--git"), JSON.stringify(importerArgs));
    assert.equal(forge(server.dev).length, 0);
    assert.ok(server.dev.state.events.length > 0, "the other stores still shipped");
    assert.deepEqual(record(home).importStores, ["claude_code", "codex", "cursor", "vscode"]);
    assert.match(out, /Git\s+· not included: your history-import grant doesn't cover git\. To add it, run this again with --rejoin and tick the git box on the page/);
  } finally {
    await server.close();
  }
});

test("git granted before this join: the status says so, and git ships though the box was left unticked", async () => {
  const server = await startServer({ gitGranted: true });
  const home = gitMachine();
  const env = useMachine(home);
  try {
    const { code, out, importerArgs } = await participate(env, [CODE, "--api-base-url", server.base]);

    assert.equal(code, 0, out);
    assert.ok(importerArgs[0].includes("--git"));
    assert.equal(forge(server.dev).length, 2);
    assert.match(out, /Git\s+✓ included/);
  } finally {
    await server.close();
  }
});

test("re-run: the grant is read fresh from the server, so a change since the join is followed", async () => {
  const server = await startServer();
  const home = gitMachine();
  const env = useMachine(home);
  try {
    const argv = [CODE, "--api-base-url", server.base];
    const first = await participate(env, argv);
    assert.equal(first.code, 0, first.out);
    assert.ok(!first.importerArgs[0].includes("--git"));
    assert.ok(record(home).joinSessionId, "the join session is kept for the re-run");

    // Granted from the web after the join. The record still says no git.
    await fetch(`${server.base}/_dev/import-stores`, { method: "POST", body: JSON.stringify({ git: true }) });
    const second = await participate(env, argv);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /nothing needs confirming/);
    assert.ok(second.importerArgs[0].includes("--git"), "the fresh read wins over the record");
    assert.equal(forge(server.dev).length, 2);
    assert.ok(record(home).importStores.includes("git"), "the record is updated");

    // Narrowed again: the next run leaves git out.
    await fetch(`${server.base}/_dev/import-stores`, { method: "POST", body: JSON.stringify({ git: false }) });
    const third = await participate(env, argv);
    assert.ok(!third.importerArgs[0].includes("--git"));
    assert.match(third.out, /Git\s+· not included: your history-import grant doesn't cover git/);
  } finally {
    await server.close();
  }
});

test("readImportStores: the record when the server can't answer, unknown when neither can", async () => {
  const server = await startServer({ gitGranted: true, historicalImportLease: true });
  const home = gitMachine();
  useMachine(home);
  try {
    const base = { joinCode: CODE, apiBaseUrl: server.base, organisationName: "Northview Health", studyKind: "Report30", windowStartUtc: "2026-10-13T00:00:00.000Z", windowEndUtc: "2026-11-10T00:00:00.000Z", granted: [], joinedAt: "2026-10-14T00:00:00.000Z" };
    // A session the server doesn't know: the read fails, so the record's copy is used.
    assert.deepEqual(await readImportStores({ ...base, joinSessionId: "gone", importStores: ["claude_code"] }, ""), { from: "record", stores: ["claude_code"] });
    // A record written before stores were kept, with no session to ask about.
    assert.deepEqual(await readImportStores(base, ""), { from: "unknown", stores: null });
    assert.deepEqual(await readImportStores(undefined, ""), { from: "unknown", stores: null });
  } finally {
    await server.close();
  }
});

/** Runs the importer itself, as a person would after participate. */
function runImporter(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [IMPORTER, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("import --git --ship without the grant: git is refused, the message says how to grant it, the rest still ships", async () => {
  const server = await startServer();
  const home = gitMachine();
  const env = useMachine(home);
  try {
    // Joined with the box unticked, then a fresh session's history to send.
    assert.equal((await participate(env, [CODE, "--api-base-url", server.base, "--no-backfill"])).code, 0);
    const before = server.dev.state.events.length;

    const { out } = await runImporter(env, ["import", "--ship", "--git"]);

    assert.equal(forge(server.dev).length, 0);
    assert.ok(server.dev.state.events.length > before, out);
    assert.match(out, /git wasn't granted, so no commits were sent\. The other stores carried on\./);
    assert.match(out, /tick the git box on the page:\n\s+npx -y @ascenda-one\/history-import participate <code> --rejoin/);
    assert.doesNotMatch(out, /not granted: git/, "git isn't listed again under the generic sentence");
  } finally {
    await server.close();
  }
});

test("schedule: --git rides along only when asked, and status reads it back", async () => {
  assert.deepEqual(scheduledCommand("/x/cli.js", "/n/node", {}, { git: true }).argv, ["/n/node", "/x/cli.js", "import", "--ship", "--git"]);
  assert.deepEqual(scheduledCommand("/x/cli.js", "/n/node", {}).argv, ["/n/node", "/x/cli.js", "import", "--ship"]);
  assert.deepEqual(
    scheduledCommand("/u/.npm/_npx/a/node_modules/.bin/ascenda-history-import", "/n/node", {}, { git: true }).argv,
    ["/n/npx", "-y", "@ascenda-one/history-import", "import", "--ship", "--git"]
  );

  for (const platform of ["darwin", "linux"]) {
    for (const withGit of [true, false]) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-sched-git-"));
      const env = { platform, home, uid: 501, run: async () => ({ code: 0, stdout: "" }) };
      await installSchedule(env, { everyDays: 14, command: scheduledCommand("/x/cli.js", "/n/node", {}, { git: withGit }), pathEnv: "/usr/bin" });
      assert.equal((await scheduleStatus(env)).git, withGit, `${platform} ${withGit}`);
    }
  }
});
