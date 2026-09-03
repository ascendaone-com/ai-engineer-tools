import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end against the built CLI: the outbox exists to survive the process
// exiting, so the only test that proves it is one where the process exits.

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const INSTALLATION_ID = "claude_code:outbox-0000";

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-outbox-"));
  return {
    dir,
    state: path.join(dir, "state.json"),
    outbox: path.join(dir, "outbox.jsonl"),
    token: path.join(dir, "token")
  };
}

/** A stub ingest endpoint answering by door, recording what each door received. */
async function withServer(handlers, run) {
  const received = { single: [], batch: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const door = req.url.endsWith("/batch") ? "batch" : "single";
      const parsed = body ? JSON.parse(body) : undefined;
      received[door].push(parsed);
      const answer = handlers[door] ? handlers[door](parsed) : { status: 500, body: "no route" };
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, received);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function run(args, { input, env = {}, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
      env: {
        ...process.env,
        ASCENDA_TOOL_INSTALLATION_ID: INSTALLATION_ID,
        ASCENDA_EVENT_WRITE_TOKEN: "tok_test",
        ASCENDA_OUTBOX_DRAIN: "",
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

const EDIT_PAYLOAD = {
  session_id: "s1",
  tool_name: "Edit",
  tool_input: { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" },
  tool_response: { success: true }
};

const readOutbox = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("a hook whose send is refused leaves the event in the outbox after the process exits", async () => {
  const { dir, state, outbox, token } = scratch();
  await withServer({ single: () => ({ status: 503, body: "restarting" }) }, async (apiBaseUrl) => {
    const result = await run(["PostToolUse"], {
      input: EDIT_PAYLOAD,
      env: { ASCENDA_API_BASE_URL: apiBaseUrl, ASCENDA_STATE_FILE: state, ASCENDA_OUTBOX_FILE: outbox, ASCENDA_EVENT_WRITE_TOKEN_FILE: token }
    });
    assert.equal(result.status, 0, "telemetry failure must never break the host");

    const queued = readOutbox(outbox);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].payload.eventType, "ai_file_edit");
    assert.match(queued[0].payload.idempotencyKey, /^[0-9a-f-]{36}$/, "the key minted at construction, kept for the replay");

    const journal = JSON.parse(fs.readFileSync(state, "utf8"));
    assert.equal(journal.lastOutcome, "transport_error");
    assert.match(journal.detail, /queued in outbox/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the next hook drains it when the drain is enabled, and the entry is gone once the server confirms", async () => {
  const { dir, state, outbox, token } = scratch();
  const env = { ASCENDA_STATE_FILE: state, ASCENDA_OUTBOX_FILE: outbox, ASCENDA_EVENT_WRITE_TOKEN_FILE: token };

  await withServer({ single: () => ({ status: 503, body: "" }) }, async (apiBaseUrl) => {
    await run(["PostToolUse"], { input: EDIT_PAYLOAD, env: { ...env, ASCENDA_API_BASE_URL: apiBaseUrl } });
  });
  const [queued] = readOutbox(outbox);
  assert.ok(queued, "precondition: one event waiting");

  await withServer({
    batch: (body) => ({ status: 200, body: JSON.stringify({ results: body.events.map((_, index) => ({ index, status: "duplicate", reason: "already_delivered" })) }) }),
    single: () => ({ status: 200, body: JSON.stringify({ status: "accepted" }) })
  }, async (apiBaseUrl, received) => {
    const result = await run(["PostToolUse"], { input: EDIT_PAYLOAD, env: { ...env, ASCENDA_API_BASE_URL: apiBaseUrl, ASCENDA_OUTBOX_DRAIN: "true" } });
    assert.equal(result.status, 0);
    assert.equal(received.batch.length, 1, "one batch, oldest first, then the live event through its own door");
    assert.equal(received.batch[0].events[0].idempotencyKey, queued.payload.idempotencyKey);
    assert.equal(received.single.length, 1);
    assert.equal(readOutbox(outbox).length, 0, "a duplicate is a success with nothing to do: evicted");
    assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".draining")).length, 0);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with the drain off (the default), the next hook keeps the queue and sends nothing from it", async () => {
  const { dir, state, outbox, token } = scratch();
  const env = { ASCENDA_STATE_FILE: state, ASCENDA_OUTBOX_FILE: outbox, ASCENDA_EVENT_WRITE_TOKEN_FILE: token };
  await withServer({ single: () => ({ status: 503, body: "" }) }, async (apiBaseUrl) => {
    await run(["PostToolUse"], { input: EDIT_PAYLOAD, env: { ...env, ASCENDA_API_BASE_URL: apiBaseUrl } });
  });
  await withServer({ single: () => ({ status: 200, body: JSON.stringify({ status: "accepted" }) }) }, async (apiBaseUrl, received) => {
    await run(["PostToolUse"], { input: EDIT_PAYLOAD, env: { ...env, ASCENDA_API_BASE_URL: apiBaseUrl } });
    assert.equal(received.batch.length, 0, "gated off until the ingest door is confirmed to dedupe");
    assert.equal(readOutbox(outbox).length, 1, "still waiting, still on disk");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor reports outbox depth, the oldest entry's age, the drain flag and any discards", async () => {
  const { dir, state, outbox, token } = scratch();
  const env = { ASCENDA_STATE_FILE: state, ASCENDA_OUTBOX_FILE: outbox, ASCENDA_EVENT_WRITE_TOKEN_FILE: token };

  // Two refused sends, the first of them three hours ago.
  await withServer({ single: () => ({ status: 503, body: "" }) }, async (apiBaseUrl) => {
    await run(["PostToolUse"], { input: EDIT_PAYLOAD, env: { ...env, ASCENDA_API_BASE_URL: apiBaseUrl } });
    await run(["PostToolUse"], { input: EDIT_PAYLOAD, env: { ...env, ASCENDA_API_BASE_URL: apiBaseUrl } });
  });
  const entries = readOutbox(outbox);
  assert.equal(entries.length, 2);
  entries[0].queuedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
  fs.writeFileSync(outbox, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));

  await withServer({ single: () => ({ status: 503, body: "" }) }, async (apiBaseUrl) => {
    const result = await run(["doctor"], { env: { ...env, ASCENDA_API_BASE_URL: apiBaseUrl } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Outbox depth\s+2 waiting — oldest queued \S+ \(3h \d+m ago\)/);
    assert.match(result.stdout, /Outbox drain\s+off .*ASCENDA_OUTBOX_DRAIN/);
    assert.doesNotMatch(result.stdout, /Outbox discarded/, "nothing has been thrown away");
  });

  // The doctor's own live round trip failed too and was queued: the depth
  // grows and the health answer stays honest.
  assert.equal(readOutbox(outbox).length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor surfaces a journaled discard, and it survives the recovery that follows", async () => {
  const { dir, state, outbox, token } = scratch();
  const env = { ASCENDA_STATE_FILE: state, ASCENDA_OUTBOX_FILE: outbox, ASCENDA_EVENT_WRITE_TOKEN_FILE: token };

  // An entry queued eight days ago: past the age bound.
  const stale = {
    queuedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    payload: { toolInstallationId: INSTALLATION_ID, source: "claude_code", eventType: "ai_file_edit", occurredAt: "2026-08-20T00:00:00.000Z", idempotencyKey: "stale-key", severity: "low", consentScope: "ide_telemetry", provenance: "ai_work_telemetry", privacyMode: "metadata_only", metadata: {} }
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outbox, `${JSON.stringify(stale)}\n`);

  await withServer({ single: () => ({ status: 200, body: JSON.stringify({ status: "accepted" }) }) }, async (apiBaseUrl) => {
    await run(["PostToolUse"], { input: EDIT_PAYLOAD, env: { ...env, ASCENDA_API_BASE_URL: apiBaseUrl } });
    const journal = JSON.parse(fs.readFileSync(state, "utf8"));
    assert.equal(journal.lastOutcome, "accepted", "the live send after the eviction succeeded");
    assert.equal(journal.consecutiveFailures, 0);
    assert.equal(journal.outboxDiscarded.total, 1, "and the loss is still on record");

    const result = await run(["doctor"], { env: { ...env, ASCENDA_API_BASE_URL: apiBaseUrl } });
    assert.match(result.stdout, /Outbox discarded\s+1 total; last 1 at \S+ \(1 age, reaching back to /);
    assert.match(result.stdout, /Outbox depth\s+0 \(nothing waiting\)/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
