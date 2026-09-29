import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The changes an organisation has published to a person are for that person,
// when they run `status`. They are not for the agent: no hook makes the
// request, and no hook's output, which Claude Code reads back as context,
// carries a word of them. Both halves are checked end to end against the
// built CLI and a local server that would hand the list over if asked.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const MARKER_TITLE = "Zebra-Crossing Reviews";
const MARKER_SUMMARY = "Quokka summary text";

function listOfOne() {
  return [{
    id: "6f1d2f0e-1111-4a3b-9c0e-000000000001",
    organisationName: "Acme Health",
    title: MARKER_TITLE,
    summaryForCohort: MARKER_SUMMARY,
    measureUnit: "hours",
    scoringStartUtc: "2026-10-05T00:00:00.000Z",
    scoringEndUtc: "2026-11-02T00:00:00.000Z",
    withdrawnUtc: null,
    status: "published",
    result: null
  }];
}

async function withServer(handlerBody, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    req.resume();
    req.on("end", () => {
      const [status, body] = handlerBody(req);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const answer = (req) => (req.url.includes("/initiatives") ? [200, listOfOne()] : [200, { status: "accepted" }]);

function machine(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ascenda-${name}-`));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return {
    root,
    project,
    env: { HOME: home, ASCENDA_HOME: path.join(home, ".ascenda"), ASCENDA_TOOL_INSTALLATION_ID: "", ASCENDA_EVENT_WRITE_TOKEN: "" },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function run(m, args, { env = {}, input = "" } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], { cwd: m.root, env: { ...process.env, ...m.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

const pairedEnv = (base) => ({
  ASCENDA_API_BASE_URL: base,
  ASCENDA_TOOL_INSTALLATION_ID: "claude_code:00000000-0000-4000-8000-000000000001",
  ASCENDA_EVENT_WRITE_TOKEN: "test-token"
});

test("status lists the changes published to you, fetched with the install's own token", async () => {
  await withServer(answer, async (base, requests) => {
    const m = machine("status-list");
    const result = await run(m, ["status", "--scope", "user"], { env: pairedEnv(base) });
    assert.match(result.stdout, /Changes your organisation has published to you/);
    assert.ok(result.stdout.includes(`Acme Health: ${MARKER_TITLE}`), result.stdout);
    assert.ok(result.stdout.includes(MARKER_SUMMARY));
    assert.ok(result.stdout.includes("Published, not scored yet."));
    const reads = requests.filter((r) => r.url.includes("/initiatives"));
    assert.equal(reads.length, 1);
    assert.equal(reads[0].method, "GET");
    assert.equal(reads[0].auth, "Bearer test-token");
    m.cleanup();
  });
});

test("status says which of the empty and failed cases it is", async () => {
  const m = machine("status-states");
  await withServer(() => [200, []], async (base) => {
    const result = await run(m, ["status", "--scope", "user"], { env: pairedEnv(base) });
    assert.match(result.stdout, /None published to you\./);
  });
  await withServer(() => [401, undefined], async (base) => {
    const result = await run(m, ["status", "--scope", "user"], { env: pairedEnv(base) });
    assert.match(result.stdout, /Couldn't check: the server turned this install's request down/);
    assert.doesNotMatch(result.stdout, /None published/);
  });
  await withServer(() => [503, { error: "down" }], async (base) => {
    const result = await run(m, ["status", "--scope", "user"], { env: pairedEnv(base) });
    assert.match(result.stdout, /Couldn't check: the server answered HTTP 503\. Run status again to retry\./);
  });
  m.cleanup();
});

test("status on an install that was never paired makes no request at all", async () => {
  await withServer(answer, async (base, requests) => {
    const m = machine("status-unpaired");
    await run(m, ["setup", "--no-pair", "--scope", "user", "--project-dir", m.project], { env: { ASCENDA_API_BASE_URL: base } });
    const result = await run(m, ["status", "--scope", "user"], { env: { ASCENDA_API_BASE_URL: base } });
    assert.match(result.stdout, /Not checked: this install holds no token, so nothing was fetched\./);
    assert.equal(requests.length, 0, "an unpaired install sends nothing anywhere");
    m.cleanup();
  });
});

test("no hook fetches the list, and nothing a hook prints mentions it", async () => {
  await withServer(answer, async (base, requests) => {
    const m = machine("hooks-silent");
    const shellOk = { stdout: "ok", stderr: "", interrupted: false, isImage: false, noOutputExpected: false };
    const hooks = [
      ["SessionStart", { source: "startup", session_id: "s1", cwd: m.project }],
      ["SessionStart", { source: "resume", session_id: "s1", cwd: m.project }],
      ["UserPromptSubmit", { prompt: "hello", session_id: "s1", cwd: m.project }],
      ["PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, session_id: "s1", cwd: m.project }],
      ["PostToolUse", { tool_name: "Bash", tool_input: { command: "gh pr merge 12 --squash" }, tool_response: shellOk, session_id: "s1", cwd: m.project }],
      ["Stop", { session_id: "s1", cwd: m.project }],
      ["SessionEnd", { session_id: "s1", cwd: m.project }]
    ];
    for (const [name, input] of hooks) {
      const result = await run(m, [name], { env: pairedEnv(base), input: JSON.stringify(input) });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      const printed = `${result.stdout}\n${result.stderr}`;
      assert.doesNotMatch(printed, /initiativ|published to you|Acme Health/i, `${name} printed something about them`);
      assert.ok(!printed.includes(MARKER_TITLE) && !printed.includes(MARKER_SUMMARY), `${name} printed the list`);
    }
    assert.equal(requests.filter((r) => r.url.includes("initiatives")).length, 0, "no hook asked for the list");
    m.cleanup();
  });
});
