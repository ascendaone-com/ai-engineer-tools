const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The journal defaults to the real ~/.ascenda/state when a caller omits
// stateFilePath, so a suite that builds a sender writes fixture installations
// into the developer's actual home, where `doctor` reports them as real
// pairings. Redirect before anything is constructed.
process.env.ASCENDA_STATE_DIR = require("node:fs").mkdtempSync(
  require("node:path").join(require("node:os").tmpdir(), "ascenda-test-state-")
);
const {
  AscendaEventSender,
  EVENT_LOG_ENV_VAR,
  appendEventLog,
  buildEventPayload,
  resolveEventLogPath,
  resolveEventLogSource,
  writeTopLevelCredentials
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

// The gap this closes: a hook spawned with no shell environment (a
// Desktop-app / GUI-launched session) never sees ASCENDA_EVENT_LOG_FILE even
// when a user turned logging on, because the export lived only in an rc file
// that process never sourced. `setup`/`pair` can instead persist the path to
// credentials.json, which needs no environment to read.

function withHome(run) {
  const previous = process.env.ASCENDA_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-eventlog-home-"));
  process.env.ASCENDA_HOME = home;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.ASCENDA_HOME;
    else process.env.ASCENDA_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("resolves via the env var alone, unchanged from before this existed", () => {
  const file = path.join(tempDir(), "events.jsonl");
  withHome(() => withEnv(file, () => {
    assert.equal(resolveEventLogPath(), file);
    assert.equal(resolveEventLogSource(), "env");
  }));
});

test("resolves via credentials.json alone, with no env var set", () => {
  withHome(() => withEnv(undefined, () => {
    const dir = tempDir();
    const file = path.join(dir, "events.jsonl");
    writeTopLevelCredentials({ toolInstallationId: "claude_code:abc", eventLogPath: file });

    assert.equal(resolveEventLogPath(), file);
    assert.equal(resolveEventLogSource(), "credentials");
    fs.rmSync(dir, { recursive: true, force: true });
  }));
});

test("neither source set means logging stays off — no ambient default", () => {
  withHome(() => withEnv(undefined, () => {
    writeTopLevelCredentials({ toolInstallationId: "claude_code:abc" });
    assert.equal(resolveEventLogPath(), undefined);
    assert.equal(resolveEventLogSource(), "off");
  }));
});

test("the env var wins when both are configured — one override still works across every tool", () => {
  withHome(() => {
    const dir = tempDir();
    writeTopLevelCredentials({ toolInstallationId: "claude_code:abc", eventLogPath: path.join(dir, "from-credentials.jsonl") });
    withEnv(path.join(dir, "from-env.jsonl"), () => {
      assert.equal(resolveEventLogPath(), path.join(dir, "from-env.jsonl"));
      assert.equal(resolveEventLogSource(), "env");
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test("a credentials path also expands ~ and whitespace-only is treated as unset", () => {
  withHome(() => withEnv(undefined, () => {
    writeTopLevelCredentials({ toolInstallationId: "claude_code:abc", eventLogPath: "~/logs/events.jsonl" });
    assert.equal(resolveEventLogPath(), path.join(os.homedir(), "logs", "events.jsonl"));

    writeTopLevelCredentials({ toolInstallationId: "claude_code:abc", eventLogPath: "   " });
    assert.equal(resolveEventLogPath(), undefined, "whitespace is not a path");
  }));
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

test("an unreachable backend is logged as transport_error, and no longer throws", async () => {
  // Previously this threw and was logged as the generic `other`. On the hook
  // path that throw unwound to a top-level catch which wrote to a stderr the
  // host discards — indistinguishable from success. It is now a returned
  // outcome that names the cause, so it can be journalled and retried.
  const dir = tempDir();
  const file = path.join(dir, "events.jsonl");
  const { instance, restore } = sender(file, async () => {
    throw new Error("ECONNREFUSED");
  });
  try {
    const result = await instance.send({ eventType: "compile_error", severity: "medium" });
    assert.equal(result, "transport_error");
    const [entry] = readLog(file);
    assert.equal(entry.delivery, "transport_error");
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
