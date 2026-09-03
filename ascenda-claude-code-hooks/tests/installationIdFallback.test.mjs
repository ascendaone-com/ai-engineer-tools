import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Issue #48: on macOS a Dock-launched Claude Code never sees a shell rc file,
// so every hook it spawns runs with no ASCENDA_TOOL_INSTALLATION_ID. Before
// this fix the hook threw, exited 0, and never touched the journal — twelve
// hours and 885 tool calls lost with `doctor` reporting healthy throughout.
//
// Two guarantees are tested here. The id is recovered from the token store
// when, and only when, exactly one token of this tool type is on disk. And a
// send that still cannot name its installation is journalled, so `doctor`
// can see the gap while it is happening.

process.env.ASCENDA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-home-"));
delete process.env.ASCENDA_TOOL_INSTALLATION_ID;
delete process.env.ASCENDA_EVENT_WRITE_TOKEN;
delete process.env.ASCENDA_EVENT_WRITE_TOKEN_FILE;
delete process.env.ASCENDA_STATE_FILE;
delete process.env.ASCENDA_EVENT_LOG_FILE;

const { MissingInstallationIdError, loadConfigFromEnv, resolveToolInstallationId } = await import("../dist/config.js");
const { credentialsFilePath, writeCredentials } = await import("../dist/paths.js");
const { defaultTokenFilePath, persistEventWriteToken } = await import("@ascenda-one/tool-kit");

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const UUID_A = "0d7b1e2a-5f3c-4a8e-9b1d-2c3e4f5a6b7c";
const UUID_B = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";

function resetTokens() {
  fs.rmSync(path.join(process.env.ASCENDA_HOME, "tokens"), { recursive: true, force: true });
  fs.rmSync(credentialsFilePath(), { force: true });
}

// --- the resolver, in-process ---------------------------------------------

test("one claude_code token on disk: the id comes from disk", () => {
  resetTokens();
  persistEventWriteToken(defaultTokenFilePath(`claude_code:${UUID_A}`), "tok_a");

  assert.deepEqual(resolveToolInstallationId(), { toolInstallationId: `claude_code:${UUID_A}`, source: "disk" });

  const config = loadConfigFromEnv();
  assert.equal(config.toolInstallationId, `claude_code:${UUID_A}`);
  assert.equal(config.eventWriteToken, "tok_a", "and the token is read from that same file");
});

test("zero tokens on disk: still throws, naming every source that was tried", () => {
  resetTokens();
  assert.throws(
    () => resolveToolInstallationId(),
    (error) => error instanceof MissingInstallationIdError && error.candidates.length === 0
      && /Not configured/.test(error.message) && /no claude_code token/.test(error.message)
  );
  assert.throws(() => loadConfigFromEnv(), MissingInstallationIdError);
});

test("several tokens on disk: refuses to guess and lists the candidates", () => {
  resetTokens();
  persistEventWriteToken(defaultTokenFilePath(`claude_code:${UUID_A}`), "tok_a");
  persistEventWriteToken(defaultTokenFilePath(`claude_code:${UUID_B}`), "tok_b");

  assert.throws(
    () => resolveToolInstallationId(),
    (error) => error instanceof MissingInstallationIdError
      && error.candidates.length === 2
      && error.message.includes(UUID_A) && error.message.includes(UUID_B)
      && /refusing to guess/.test(error.message)
  );
});

test("a token for another tool type is not a candidate", () => {
  resetTokens();
  persistEventWriteToken(defaultTokenFilePath(`claude_code:${UUID_A}`), "tok_a");
  persistEventWriteToken(defaultTokenFilePath("cli_agent:codex-1"), "tok_codex");
  assert.equal(resolveToolInstallationId().toolInstallationId, `claude_code:${UUID_A}`);
});

test("environment, then credentials, still win over the disk fallback", () => {
  resetTokens();
  persistEventWriteToken(defaultTokenFilePath(`claude_code:${UUID_A}`), "tok_a");
  writeCredentials({ toolInstallationId: "claude_code:from-credentials" });
  assert.deepEqual(resolveToolInstallationId(), { toolInstallationId: "claude_code:from-credentials", source: "credentials" });

  process.env.ASCENDA_TOOL_INSTALLATION_ID = "claude_code:from-env";
  try {
    assert.deepEqual(resolveToolInstallationId(), { toolInstallationId: "claude_code:from-env", source: "env" });
  } finally {
    delete process.env.ASCENDA_TOOL_INSTALLATION_ID;
  }
});

// --- the built CLI, end to end --------------------------------------------

function run(args, { input, env = {}, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
      env: {
        ...process.env,
        // Explicitly empty: the point of every test below is an environment
        // that does not carry the id.
        ASCENDA_TOOL_INSTALLATION_ID: "",
        ...env
      }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeout}ms: ${args.join(" ")}`));
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}

async function withServer(status, body, fn) {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const EDIT_PAYLOAD = {
  session_id: "s1",
  tool_name: "Edit",
  tool_input: { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" },
  tool_response: { success: true }
};

function stateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-state-"));
}

test("CLI: with the env empty and one token on disk, the hook ships and journals under the disk id", async () => {
  resetTokens();
  persistEventWriteToken(defaultTokenFilePath(`claude_code:${UUID_A}`), "tok_a");
  const dir = stateDir();
  await withServer(200, JSON.stringify({ status: "accepted" }), async (apiBaseUrl) => {
    const result = await run(["PostToolUse"], { input: EDIT_PAYLOAD, env: { ASCENDA_API_BASE_URL: apiBaseUrl, ASCENDA_STATE_DIR: dir } });
    assert.equal(result.status, 0);
    const journal = JSON.parse(fs.readFileSync(path.join(dir, `claude_code_${UUID_A}.json`), "utf8"));
    assert.equal(journal.toolInstallationId, `claude_code:${UUID_A}`);
    assert.equal(journal.lastOutcome, "accepted");
    assert.ok(!fs.existsSync(path.join(dir, "claude_code_unresolved.json")), "nothing was skipped");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI: a send with no resolvable id is journalled as skipped_no_installation_id — the fix for the silent no-op", async () => {
  resetTokens();
  const dir = stateDir();
  const env = { ASCENDA_STATE_DIR: dir };

  const first = await run(["PostToolUse"], { input: EDIT_PAYLOAD, env });
  assert.equal(first.status, 0, "telemetry failure must never break the host");
  assert.match(first.stderr, /Not configured/);
  const second = await run(["PostToolUse"], { input: EDIT_PAYLOAD, env });
  assert.equal(second.status, 0);

  const journal = JSON.parse(fs.readFileSync(path.join(dir, "claude_code_unresolved.json"), "utf8"));
  assert.equal(journal.lastOutcome, "skipped_no_installation_id");
  assert.equal(journal.toolInstallationId, "claude_code:unresolved");
  assert.equal(journal.consecutiveFailures, 2, "one entry per skipped hook invocation");
  assert.ok(journal.failingSince, "since when");
  assert.equal(journal.lastSuccessAt, undefined);
  assert.match(journal.detail, /no claude_code token file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI: several tokens on disk also journal a skip, naming the candidates", async () => {
  resetTokens();
  persistEventWriteToken(defaultTokenFilePath(`claude_code:${UUID_A}`), "tok_a");
  persistEventWriteToken(defaultTokenFilePath(`claude_code:${UUID_B}`), "tok_b");
  const dir = stateDir();

  const result = await run(["PostToolUse"], { input: EDIT_PAYLOAD, env: { ASCENDA_STATE_DIR: dir } });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /refusing to guess/);
  const journal = JSON.parse(fs.readFileSync(path.join(dir, "claude_code_unresolved.json"), "utf8"));
  assert.equal(journal.lastOutcome, "skipped_no_installation_id");
  assert.match(journal.detail, /2 claude_code token files/);
  assert.ok(!fs.existsSync(path.join(dir, `claude_code_${UUID_A}.json`)), "neither candidate was guessed");
  assert.ok(!fs.existsSync(path.join(dir, `claude_code_${UUID_B}.json`)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor: names the source of the id — disk when it came from the token file", async () => {
  resetTokens();
  persistEventWriteToken(defaultTokenFilePath(`claude_code:${UUID_A}`), "tok_a");
  const dir = stateDir();
  await withServer(200, JSON.stringify({ status: "accepted" }), async (apiBaseUrl) => {
    const result = await run(["doctor"], { env: { ASCENDA_API_BASE_URL: apiBaseUrl, ASCENDA_STATE_DIR: dir } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`Installation id\\s+claude_code:${UUID_A}`));
    assert.match(result.stdout, /Id source\s+disk \(token file .*claude_code_0d7b1e2a/);
    assert.match(result.stdout, /OK — event accepted/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor: names the source of the id — env when the variable is set", async () => {
  resetTokens();
  persistEventWriteToken(defaultTokenFilePath(`claude_code:${UUID_A}`), "tok_a");
  const dir = stateDir();
  await withServer(200, JSON.stringify({ status: "accepted" }), async (apiBaseUrl) => {
    const result = await run(["doctor"], {
      env: { ASCENDA_API_BASE_URL: apiBaseUrl, ASCENDA_STATE_DIR: dir, ASCENDA_TOOL_INSTALLATION_ID: `claude_code:${UUID_A}` }
    });
    assert.match(result.stdout, /Id source\s+env \(ASCENDA_TOOL_INSTALLATION_ID\)/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor: surfaces skipped sends, both while unresolved and after the id is fixed", async () => {
  resetTokens();
  const dir = stateDir();
  const env = { ASCENDA_STATE_DIR: dir };
  await run(["PostToolUse"], { input: EDIT_PAYLOAD, env });
  await run(["PostToolUse"], { input: EDIT_PAYLOAD, env });

  const unresolved = await run(["doctor"], { env });
  assert.equal(unresolved.status, 0);
  assert.match(unresolved.stdout, /Installation id\s+\(unresolved — Not configured/);
  assert.match(unresolved.stdout, /Skipped sends\s+2 since \S+ — no installation id could be resolved/);
  assert.match(unresolved.stdout, /Skipped-send journal\s+.*claude_code_unresolved\.json/);
  assert.match(unresolved.stdout, /Not paired on this machine/);

  // The gap stays visible once the id is back: a fixed environment does not
  // un-lose the events that were skipped.
  persistEventWriteToken(defaultTokenFilePath(`claude_code:${UUID_A}`), "tok_a");
  await withServer(200, JSON.stringify({ status: "accepted" }), async (apiBaseUrl) => {
    const fixed = await run(["doctor"], { env: { ...env, ASCENDA_API_BASE_URL: apiBaseUrl } });
    assert.match(fixed.stdout, /Id source\s+disk/);
    assert.match(fixed.stdout, /Skipped sends\s+2 since/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
