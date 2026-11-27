import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Per-call file capture through the real hook binary.
//
// The first test is the precondition the capture was built under: with
// capture on, no value it computes (a path hash, a line hash, a repository
// hash, the capture salt) and no clear path or line from the working tree
// reaches anything a hook sends, queues or logs. It also checks the capture
// really ran, so it cannot pass by capturing nothing.

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const SESSION = "7d1e0c4a-5b2f-4a9e-8c3d-1f2e3a4b5c6d";
const FILE_NAME = "zebra_quokka_module.ts";
const LINE = "export const pangolinThreshold = computeWombat(42);";

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  fs.writeFileSync(path.join(root, "README.md"), "a repository for the capture test\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

async function withIngest(run) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.url.endsWith("/batch")) {
        received.push(...parsed.events);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: parsed.events.map((_, index) => ({ index, status: "accepted" })) }));
        return;
      }
      received.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "accepted" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, received);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function envFor(base, apiBaseUrl) {
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    ASCENDA_HOME: path.join(home, ".ascenda"),
    ASCENDA_API_BASE_URL: apiBaseUrl ?? "http://127.0.0.1:9",
    ASCENDA_TOOL_INSTALLATION_ID: "claude_code:capture-0000",
    ASCENDA_EVENT_WRITE_TOKEN: "tok_test",
    ASCENDA_EVENT_WRITE_TOKEN_FILE: path.join(base, "token"),
    ASCENDA_STATE_FILE: path.join(base, "state.json"),
    ASCENDA_OUTBOX_FILE: path.join(base, "outbox.jsonl"),
    ASCENDA_EVENT_LOG_FILE: path.join(base, "events.jsonl"),
    ASCENDA_OUTBOX_DRAIN: "on",
    ASCENDA_SESSION_ID: "",
    ASCENDA_DISABLE_FAILURE_NOTICE: "true",
    ASCENDA_LIVE_BUS_SOCKET: path.join(base, "no-such.sock")
  };
}

function runCli(args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${args[0]} timed out`)); }, 20_000);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}

function hook(name, cwd, toolName, toolUseId, toolInput, env) {
  return runCli([name], env, {
    session_id: SESSION,
    cwd,
    hook_event_name: name,
    tool_name: toolName,
    tool_use_id: toolUseId,
    tool_input: toolInput,
    permission_mode: "default",
    ...(name === "PostToolUse" ? { tool_response: { stdout: "", stderr: "", interrupted: false } } : {})
  });
}

function captureValues(captureDir) {
  const values = new Set();
  for (const f of fs.readdirSync(captureDir)) {
    if (!f.startsWith("calls-")) continue;
    for (const line of fs.readFileSync(path.join(captureDir, f), "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line);
      values.add(r.repo);
      values.add(r.common);
      for (const file of r.files) {
        values.add(file.p);
        for (const h of file.w ?? []) values.add(h);
        for (const h of file.x ?? []) values.add(h);
      }
    }
  }
  values.add(fs.readFileSync(path.join(captureDir, "path-salt"), "utf8").trim());
  return values;
}

test("with capture on, nothing it computes and nothing it read reaches a sent, queued or logged payload", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-capture-wire-"));
  // A distinctive folder name, so finding it in a file means it leaked.
  const repo = makeRepo(path.join(base, "okapi-narwhal-workspace"));
  await withIngest(async (apiBaseUrl, received) => {
    const env = envFor(base, apiBaseUrl);
    assert.equal((await runCli(["capture", "on"], env)).status, 0);

    const bashInput = { command: "printf something > file" };
    assert.equal((await hook("PreToolUse", repo, "Bash", "toolu_01", bashInput, env)).status, 0);
    fs.writeFileSync(path.join(repo, FILE_NAME), `${LINE}\n`);
    assert.equal((await hook("PostToolUse", repo, "Bash", "toolu_01", bashInput, env)).status, 0);

    const editInput = { file_path: path.join(repo, "README.md"), old_string: "a", new_string: "b" };
    fs.appendFileSync(path.join(repo, "README.md"), "written by hand between the calls\n");
    // Past the PreToolUse skip window, so this one snapshots.
    await new Promise((r) => setTimeout(r, 3_200));
    assert.equal((await hook("PreToolUse", repo, "Edit", "toolu_02", editInput, env)).status, 0);
    fs.appendFileSync(path.join(repo, "README.md"), "written by the edit tool\n");
    assert.equal((await hook("PostToolUse", repo, "Edit", "toolu_02", editInput, env)).status, 0);

    const captureDir = path.join(env.ASCENDA_HOME, "capture");
    const records = fs.readdirSync(captureDir).filter((f) => f.startsWith("calls-"))
      .flatMap((f) => fs.readFileSync(path.join(captureDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    assert.deepEqual(records.map((r) => r.kind), ["call", "between", "call"], "the capture ran: two calls and the hand edit between them");
    assert.ok(received.length > 0, "the hooks sent events, so the wire was exercised");

    const wire = [
      JSON.stringify(received),
      fs.existsSync(env.ASCENDA_OUTBOX_FILE) ? fs.readFileSync(env.ASCENDA_OUTBOX_FILE, "utf8") : "",
      fs.existsSync(env.ASCENDA_EVENT_LOG_FILE) ? fs.readFileSync(env.ASCENDA_EVENT_LOG_FILE, "utf8") : ""
    ].join("\n");
    for (const value of captureValues(captureDir)) {
      assert.ok(!wire.includes(value), `a capture value (${value.slice(0, 6)}…) reached a payload`);
    }
    for (const clear of [FILE_NAME, "pangolinThreshold", "written by hand", "written by the edit tool", repo]) {
      assert.ok(!wire.includes(clear), `${clear} reached a payload`);
    }
    // And the capture's own files hold no clear path or line either.
    const stored = fs.readdirSync(captureDir, { recursive: true })
      .map((f) => path.join(captureDir, f)).filter((f) => fs.statSync(f).isFile())
      .map((f) => fs.readFileSync(f, "utf8")).join("\n");
    for (const clear of [FILE_NAME, "pangolinThreshold", "README", "written by hand", repo, path.basename(repo)]) {
      assert.ok(!stored.includes(clear), `${clear} stored in clear`);
    }
  });
});

test("capture is off until it is turned on, and off deletes everything it kept", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-capture-off-"));
  const repo = makeRepo(path.join(base, "repo"));
  const env = envFor(base);
  delete env.ASCENDA_CALL_CAPTURE;
  const input = { command: "true" };
  await hook("PreToolUse", repo, "Bash", "toolu_01", input, env);
  fs.writeFileSync(path.join(repo, "new.txt"), "a line nobody should capture\n");
  await hook("PostToolUse", repo, "Bash", "toolu_01", input, env);
  const captureDir = path.join(env.ASCENDA_HOME, "capture");
  assert.equal(fs.existsSync(captureDir), false, "off by default: nothing is written");

  await runCli(["capture", "on"], env);
  await hook("PreToolUse", repo, "Bash", "toolu_02", input, env);
  fs.appendFileSync(path.join(repo, "new.txt"), "a captured line\n");
  await hook("PostToolUse", repo, "Bash", "toolu_02", input, env);
  assert.ok(fs.readdirSync(captureDir).some((f) => f.startsWith("calls-")));
  const status = await runCli(["capture", "status"], env);
  assert.match(status.stdout, /capture: on/);
  assert.match(status.stdout, /records: 1 /);

  const off = await runCli(["capture", "off"], env);
  assert.equal(off.status, 0);
  assert.equal(fs.existsSync(captureDir), false, "off deletes records, baselines and the salt");
});

test("an edit to a file in another repository snapshots that repository too", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-capture-two-"));
  const here = makeRepo(path.join(base, "here"));
  const there = makeRepo(path.join(base, "there"));
  const env = envFor(base);
  await runCli(["capture", "on"], env);
  const target = path.join(there, "lib", "fresh.ts");
  const input = { file_path: target, content: "x" };
  await hook("PreToolUse", here, "Write", "toolu_01", input, env);
  // First sight of `there` only sets its baseline: it needs a snapshot before.
  await hook("PostToolUse", here, "Write", "toolu_01", input, env);
  await new Promise((r) => setTimeout(r, 3_200));
  await hook("PreToolUse", here, "Write", "toolu_02", input, env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "export const writtenInTheOtherRepository = true;\n");
  await hook("PostToolUse", here, "Write", "toolu_02", input, env);
  const captureDir = path.join(env.ASCENDA_HOME, "capture");
  const records = fs.readdirSync(captureDir).filter((f) => f.startsWith("calls-"))
    .flatMap((f) => fs.readFileSync(path.join(captureDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const calls = records.filter((r) => r.kind === "call" && r.callId === "toolu_02");
  assert.equal(calls.length, 1, "one record, for the repository the file is in");
  assert.equal(calls[0].files.length, 1);
  assert.equal(calls[0].files[0].w.length, 1);
});
