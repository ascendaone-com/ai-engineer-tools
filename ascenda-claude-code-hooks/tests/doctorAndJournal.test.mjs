import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end against the built CLI, because every part of this fix is about
// what actually reaches disk and stdout when the process exits — precisely the
// behaviour a unit test of the mapping layer cannot see.

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const INSTALLATION_ID = "claude_code:test-0000";

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-"));
  return {
    dir,
    state: path.join(dir, "state.json"),
    // Redirected so the CLI's token-file seeding cannot touch the real ~/.ascenda.
    token: path.join(dir, "token")
  };
}

/** A stub ingest endpoint that answers every POST with `status`. */
async function withServer(status, body, run) {
  const server = http.createServer((req, res) => {
    let received = "";
    req.on("data", (chunk) => { received += chunk; });
    req.on("end", () => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Async on purpose. The stub server above lives in this process, and
 * `spawnSync` blocks the event loop — the child's request would sit unanswered
 * until its own timeout, which looks exactly like a broken collector.
 */
function run(args, { input, env = {}, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
      env: {
        ...process.env,
        ASCENDA_TOOL_INSTALLATION_ID: INSTALLATION_ID,
        ASCENDA_EVENT_WRITE_TOKEN: "tok_test",
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
    child.stdin.end(input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input));
  });
}

function runHook(hookName, input, env) {
  return run([hookName], { input, env });
}

const EDIT_PAYLOAD = {
  session_id: "s1",
  tool_name: "Edit",
  tool_input: { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" },
  tool_response: { success: true }
};

test("an unknown argument fails fast instead of blocking on stdin forever", () => {
  // The regression that cost three minutes of a debugging session: argv was
  // never validated, so `--version` waited on a pipe that would never carry a
  // hook payload. stdin is deliberately left open here — the guard must return
  // before any read, not merely handle an empty read.
  const result = spawnSync("node", [cliPath, "--version"], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ASCENDA_TOOL_INSTALLATION_ID: INSTALLATION_ID }
  });
  assert.notEqual(result.signal, "SIGTERM", "the CLI hung instead of rejecting the argument");
  assert.equal(result.status, 0, "still must not break the host");
  assert.match(result.stderr, /Unknown command "--version"/);
});

test("doctor reports an unpaired machine and exits, without reading stdin", () => {
  const result = spawnSync("node", [cliPath, "doctor"], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ASCENDA_TOOL_INSTALLATION_ID: "" }
  });
  assert.notEqual(result.signal, "SIGTERM", "doctor must never hang");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Not paired on this machine/);
});

test("doctor prints the journal and a live round-trip verdict", async () => {
  const { dir, state, token } = scratch();
  await withServer(401, JSON.stringify({ error: "invalid_token" }), async (apiBaseUrl) => {
    const env = {
      ASCENDA_API_BASE_URL: apiBaseUrl,
      ASCENDA_STATE_FILE: state,
      ASCENDA_EVENT_WRITE_TOKEN_FILE: token
    };
    // Seed a journal by running a real hook first.
    await runHook("PostToolUse", EDIT_PAYLOAD, env);

    const result = await run(["doctor"], { env });
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(INSTALLATION_ID));
    assert.match(result.stdout, /Last outcome\s+auth_failed \(HTTP 401\)/);
    assert.match(result.stdout, /Consecutive failures\s+[12]/);
    assert.match(result.stdout, /FAILED — .*token invalid or revoked/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a rejected send is journalled — the fix for the silent drop", async () => {
  const { dir, state, token } = scratch();
  await withServer(401, JSON.stringify({ error: "invalid_token" }), async (apiBaseUrl) => {
    const result = await runHook("PostToolUse", EDIT_PAYLOAD, {
      ASCENDA_API_BASE_URL: apiBaseUrl,
      ASCENDA_STATE_FILE: state,
      ASCENDA_EVENT_WRITE_TOKEN_FILE: token
    });
    assert.equal(result.status, 0, "telemetry failure must never break the host");

    const journal = JSON.parse(fs.readFileSync(state, "utf8"));
    assert.equal(journal.lastOutcome, "auth_failed");
    assert.equal(journal.httpStatus, 401);
    assert.ok(journal.consecutiveFailures >= 1);
    assert.ok(journal.failingSince);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an accepted send is journalled too, so a stale journal means 'never ran'", async () => {
  const { dir, state, token } = scratch();
  await withServer(200, JSON.stringify({ status: "accepted" }), async (apiBaseUrl) => {
    await runHook("PostToolUse", EDIT_PAYLOAD, {
      ASCENDA_API_BASE_URL: apiBaseUrl,
      ASCENDA_STATE_FILE: state,
      ASCENDA_EVENT_WRITE_TOKEN_FILE: token
    });
    const journal = JSON.parse(fs.readFileSync(state, "utf8"));
    assert.equal(journal.lastOutcome, "accepted");
    assert.equal(journal.consecutiveFailures, 0);
    assert.ok(journal.lastSuccessAt);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a 500 is a recorded transport_error, not a swallowed exception", async () => {
  const { dir, state, token } = scratch();
  await withServer(500, "upstream exploded", async (apiBaseUrl) => {
    const result = await runHook("PostToolUse", EDIT_PAYLOAD, {
      ASCENDA_API_BASE_URL: apiBaseUrl,
      ASCENDA_STATE_FILE: state,
      ASCENDA_EVENT_WRITE_TOKEN_FILE: token
    });
    assert.equal(result.status, 0);
    const journal = JSON.parse(fs.readFileSync(state, "utf8"));
    assert.equal(journal.lastOutcome, "transport_error");
    assert.equal(journal.httpStatus, 500);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("SessionStart emits ONE valid JSON carrying both the invite and the notice", async () => {
  const { dir, state, token } = scratch();
  await withServer(401, JSON.stringify({ error: "invalid_token" }), async (apiBaseUrl) => {
    const env = {
      ASCENDA_API_BASE_URL: apiBaseUrl,
      ASCENDA_STATE_FILE: state,
      ASCENDA_EVENT_WRITE_TOKEN_FILE: token
    };
    await runHook("PostToolUse", EDIT_PAYLOAD, env);

    const result = await runHook("SessionStart", { source: "startup" }, env);
    assert.equal(result.status, 0);
    // Two writes would produce `{...}{...}` and lose both messages — the whole
    // reason the context is composed once.
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    const context = parsed.hookSpecificOutput.additionalContext;
    assert.match(context, /what would make this session count/, "the invite must survive");
    assert.match(context, /has not been reaching Ascenda/, "the notice must appear");
    assert.match(context, /write token was rejected, HTTP 401/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the notice appears once, then stays quiet for the same outage", async () => {
  const { dir, state, token } = scratch();
  await withServer(401, JSON.stringify({ error: "invalid_token" }), async (apiBaseUrl) => {
    const env = {
      ASCENDA_API_BASE_URL: apiBaseUrl,
      ASCENDA_STATE_FILE: state,
      ASCENDA_EVENT_WRITE_TOKEN_FILE: token
    };
    await runHook("PostToolUse", EDIT_PAYLOAD, env);

    const first = await runHook("SessionStart", { source: "startup" }, env);
    assert.match(first.stdout, /has not been reaching Ascenda/);

    const second = await runHook("SessionStart", { source: "startup" }, env);
    assert.doesNotMatch(second.stdout, /has not been reaching Ascenda/, "never nag");
    assert.match(second.stdout, /what would make this session count/, "the invite still runs");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a healthy collector says nothing extra", async () => {
  const { dir, state, token } = scratch();
  await withServer(200, JSON.stringify({ status: "accepted" }), async (apiBaseUrl) => {
    const env = {
      ASCENDA_API_BASE_URL: apiBaseUrl,
      ASCENDA_STATE_FILE: state,
      ASCENDA_EVENT_WRITE_TOKEN_FILE: token
    };
    await runHook("PostToolUse", EDIT_PAYLOAD, env);
    const result = await runHook("SessionStart", { source: "startup" }, env);
    assert.doesNotMatch(result.stdout, /has not been reaching Ascenda/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
