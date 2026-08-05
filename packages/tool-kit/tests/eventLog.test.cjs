const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  AscendaEventSender,
  EVENT_LOG_ENV_VAR,
  appendEventLog,
  buildEventPayload,
  resolveEventLogPath
} = require("../out/index.js");

const IDENTITY = { toolInstallationId: "claude_code:abc", source: "claude_code" };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-log-"));
}

function withEnv(value, fn) {
  const before = process.env[EVENT_LOG_ENV_VAR];
  if (value === undefined) delete process.env[EVENT_LOG_ENV_VAR];
  else process.env[EVENT_LOG_ENV_VAR] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[EVENT_LOG_ENV_VAR];
    else process.env[EVENT_LOG_ENV_VAR] = before;
  }
}

function entry(overrides = {}) {
  return {
    loggedAt: "2026-01-01T00:00:00.000Z",
    delivery: "accepted",
    payload: buildEventPayload(IDENTITY, { eventType: "ai_file_edit", severity: "low", metadata: { toolName: "Edit" } }),
    ...overrides
  };
}

test("off unless the env var is set", () => {
  withEnv(undefined, () => assert.equal(resolveEventLogPath(), undefined));
  withEnv("   ", () => assert.equal(resolveEventLogPath(), undefined, "whitespace is not a path"));
});

test("expands a leading ~ rather than creating a directory called ~", () => {
  withEnv("~/logs/events.jsonl", () => {
    assert.equal(resolveEventLogPath(), path.join(os.homedir(), "logs", "events.jsonl"));
  });
  withEnv("~", () => assert.equal(resolveEventLogPath(), os.homedir()));
});

test("a relative path resolves against cwd, not the hook's install directory", () => {
  withEnv("events.jsonl", () => {
    assert.equal(resolveEventLogPath(), path.resolve("events.jsonl"));
  });
});

test("appends one parseable JSON object per line, creating missing directories", () => {
  const dir = tempDir();
  const file = path.join(dir, "nested", "events.jsonl");

  appendEventLog(file, entry());
  appendEventLog(file, entry({ delivery: "not_sent" }));

  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).delivery, "accepted");
  assert.equal(JSON.parse(lines[1]).delivery, "not_sent");
  assert.equal(JSON.parse(lines[0]).payload.eventType, "ai_file_edit");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the logged payload is what a send would put on the wire", () => {
  const payload = buildEventPayload(IDENTITY, { eventType: "compile_error", severity: "medium" });
  assert.equal(payload.privacyMode, "metadata_only");
  assert.equal(payload.consentScope, "ide_telemetry");
  assert.equal(payload.provenance, "ai_work_telemetry");
  assert.deepEqual(payload.metadata, {}, "absent metadata is an empty bag, never undefined");
  assert.ok(Date.parse(payload.occurredAt) > 0);
});

test("the log file is owner-only", { skip: process.platform === "win32" ? "POSIX permissions" : false }, () => {
  const dir = tempDir();
  const file = path.join(dir, "events.jsonl");
  // Simulate a log left world-readable by an earlier run or a stray touch.
  fs.writeFileSync(file, "", { mode: 0o644 });

  appendEventLog(file, entry());

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rotates one generation past the size cap instead of growing forever", () => {
  const dir = tempDir();
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 1));

  appendEventLog(file, entry());

  assert.ok(fs.existsSync(`${file}.1`), "the oversized log is moved aside");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "the live log restarts with just the new entry");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unwritable path is swallowed — the sink must never break the caller", () => {
  const dir = tempDir();
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, "");
  // A directory where the log file should be: every write will fail.
  const blocked = path.join(dir, "blocked");
  fs.mkdirSync(blocked);

  assert.doesNotThrow(() => appendEventLog(blocked, entry()));
  fs.rmSync(dir, { recursive: true, force: true });
});

// Every send path funnels through the sender's private post(), so these pin
// that the log covers semantic and collaboration signals too — a log that only
// held host events would be misleading as an audit of what left the machine.

function sender(logFile, fetchImpl) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  const instance = new AscendaEventSender({
    apiBaseUrl: "https://api.example.test",
    toolInstallationId: "claude_code:abc123",
    source: "mcp_server",
    eventWriteToken: "token-1",
    tokenFilePath: path.join(os.tmpdir(), "ascenda-log-token"),
    eventLogFile: logFile
  });
  return { instance, restore: () => (global.fetch = originalFetch) };
}

function readLog(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("a sent event is logged with the ingest result the backend returned", async () => {
  const dir = tempDir();
  const file = path.join(dir, "events.jsonl");
  // A paused consent lease is the case worth pinning: it is not an exception,
  // so without logging here the log would quietly imply the event landed.
  const { instance, restore } = sender(file, async () =>
    new Response(JSON.stringify({ error: "consent_missing_or_expired" }), { status: 403 })
  );
  try {
    assert.equal(await instance.send({ eventType: "ai_tool_call_completed", severity: "low" }), "consent_missing");
    const [entry] = readLog(file);
    assert.equal(entry.delivery, "consent_missing");
    assert.equal(entry.payload.eventType, "ai_tool_call_completed");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("semantic signals are logged on the same terms, carrying their own consent scope", async () => {
  const dir = tempDir();
  const file = path.join(dir, "events.jsonl");
  const { instance, restore } = sender(file, async () =>
    new Response(JSON.stringify({ status: "accepted" }), { status: 200 })
  );
  try {
    await instance.sendSemanticSignal({
      eventType: "approach_churn_detected",
      metadata: { skillVersion: "1.2.0" }
    });
    const [entry] = readLog(file);
    assert.equal(entry.delivery, "accepted");
    assert.equal(entry.payload.consentScope, "semantic_work_signals");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreachable backend is logged as 'other' before the error reaches the caller", async () => {
  const dir = tempDir();
  const file = path.join(dir, "events.jsonl");
  const { instance, restore } = sender(file, async () => {
    throw new Error("ECONNREFUSED");
  });
  try {
    await assert.rejects(() => instance.send({ eventType: "compile_error", severity: "medium" }));
    const [entry] = readLog(file);
    assert.equal(entry.delivery, "other");
    assert.equal(entry.payload.eventType, "compile_error");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("eventLogFile: null disables logging even when the env var is set", async () => {
  const dir = tempDir();
  const file = path.join(dir, "events.jsonl");
  await withEnv(file, async () => {
    const { instance, restore } = sender(null, async () =>
      new Response(JSON.stringify({ status: "accepted" }), { status: 200 })
    );
    try {
      await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
      assert.equal(fs.existsSync(file), false, "an explicit opt-out beats the ambient env var");
    } finally {
      restore();
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
