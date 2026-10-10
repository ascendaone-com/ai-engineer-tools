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
// The saved setting lives in ~/.ascenda/credentials.json. Point that at a
// scratch directory so a developer's own setting can't change these results.
process.env.ASCENDA_HOME = require("node:fs").mkdtempSync(
  require("node:path").join(require("node:os").tmpdir(), "ascenda-test-home-")
);
const {
  AscendaEventSender,
  EVENT_LOG_ENV_VAR,
  appendEventLog,
  buildEventPayload,
  defaultEventLogPath,
  describeEventLog,
  parseEventLogFlag,
  readMachineCredentials,
  resolveEventLog,
  resolveEventLogPath,
  writeEventLogSetting,
  writeMachineCredentials,
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

function withSaved(value, fn) {
  const before = readMachineCredentials();
  if (value === undefined) writeMachineCredentials({});
  else writeEventLogSetting(value);
  try {
    return fn();
  } finally {
    writeMachineCredentials(before ?? {});
  }
}

test("off on a paired install unless something turns it on", () => {
  withSaved(undefined, () => {
    withEnv(undefined, () => assert.equal(resolveEventLogPath(), undefined));
    withEnv("   ", () => assert.equal(resolveEventLogPath(), undefined, "whitespace is not a path"));
    withEnv(undefined, () => assert.equal(resolveEventLog().source, "off"));
  });
});

test("on by default for an unpaired install, at ~/.ascenda/events.jsonl", () => {
  withSaved(undefined, () => withEnv(undefined, () => {
    assert.deepEqual(resolveEventLog({ localOnly: true }), { path: defaultEventLogPath(), source: "unpaired-default" });
    assert.equal(defaultEventLogPath(), path.join(process.env.ASCENDA_HOME, "events.jsonl"));
  }));
});

test("the env var wins over the saved setting, and the saved setting over the unpaired default", () => {
  withSaved("~/saved.jsonl", () => {
    withEnv(undefined, () => {
      assert.deepEqual(resolveEventLog({ localOnly: true }), { path: path.join(os.homedir(), "saved.jsonl"), source: "credentials" });
      assert.equal(resolveEventLogPath(), path.join(os.homedir(), "saved.jsonl"), "a saved path turns a paired install on too");
    });
    withEnv("/tmp/env.jsonl", () => assert.deepEqual(resolveEventLog({ localOnly: true }), { path: "/tmp/env.jsonl", source: "env" }));
  });
});

test("off in either place turns it off, unpaired included", () => {
  withSaved(undefined, () => withEnv("OFF", () => assert.deepEqual(resolveEventLog({ localOnly: true }), { path: undefined, source: "disabled" })));
  withSaved("off", () => withEnv(undefined, () => assert.deepEqual(resolveEventLog({ localOnly: true }), { path: undefined, source: "disabled" })));
  withSaved("off", () => withEnv("/tmp/env.jsonl", () => assert.equal(resolveEventLogPath(), "/tmp/env.jsonl", "the env var still wins")));
});

test("a re-pair keeps the saved setting", () => {
  withSaved("off", () => {
    writeTopLevelCredentials({ apiBaseUrl: "https://example.test", toolInstallationId: "claude_code:abc", pairedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(readMachineCredentials().eventLogPath, "off");
  });
});

test("--event-log takes an optional value", () => {
  assert.deepEqual(parseEventLogFlag(["--event-log"], 0), { value: defaultEventLogPath(), consumed: 0 });
  assert.deepEqual(parseEventLogFlag(["--event-log", "--no-pair"], 0), { value: defaultEventLogPath(), consumed: 0 });
  assert.deepEqual(parseEventLogFlag(["--event-log", "off"], 0), { value: "off", consumed: 1 });
  assert.deepEqual(parseEventLogFlag(["--event-log", "~/x.jsonl"], 0), { value: "~/x.jsonl", consumed: 1 });
});

test("status names which rule decided", () => {
  assert.match(describeEventLog({ path: "/a", source: "unpaired-default" }, "npx x setup"), /isn't paired; npx x setup --event-log off/);
  assert.match(describeEventLog({ path: undefined, source: "disabled" }, "npx x setup"), /^off \(turned off/);
  assert.match(describeEventLog({ path: "/a", source: "env" }, "npx x setup"), /ASCENDA_EVENT_LOG_FILE/);
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
  assert.deepEqual(payload.metadata, { collectorVersion: "unreleased" }, "absent metadata is a bag holding only the build, never undefined");
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

test("each line carries the public v0 event beside the wire payload", () => {
  const { toAgentEvent } = require("../out/index.js");
  const file = path.join(tempDir(), "events.jsonl");
  const payload = buildEventPayload(
    { toolInstallationId: "cli_agent:abc", source: "cli_agent", sessionId: "s1", projectHash: "p1" },
    { eventType: "ai_tool_call_failed", severity: "low", metadata: { host: "cursor", toolName: "Shell", outcome: "failure", durationBucket: "0-1m", subagentId: "sub-1" } }
  );
  appendEventLog(file, { loggedAt: "2026-01-01T00:00:00.000Z", delivery: "not_sent", payload });
  const line = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(line.event, toAgentEvent(payload));
  assert.equal(line.event.schema, "agent-event/v0");
  assert.equal(line.event.id, payload.idempotencyKey);
  assert.equal(line.event.time, payload.occurredAt);
  assert.equal(line.event.agent, "cursor", "the host names the agent; the source only names the tool type");
  assert.equal(line.event.kind, "tool.failed");
  assert.equal(line.event.tool, "Shell");
  assert.equal(line.event.outcome, "failure");
  assert.equal(line.event.sessionId, "s1");
  assert.equal(line.event.subagentId, "sub-1");
  assert.equal(line.event.projectHash, "p1");
  assert.equal(line.event.sourceType, "ai_tool_call_failed");
});

test("the v0 event keeps to the schema's fields, and says nothing the wire payload doesn't", () => {
  const { toAgentEvent } = require("../out/index.js");
  const schema = require("@ascenda-one/agent-events/schema/agent-event.v0.schema.json");
  const allowed = new Set(Object.keys(schema.properties));
  const types = ["create_focus_session", "ai_prompt_submitted", "ai_tool_call_started", "ai_file_edit", "ai_turn_completed", "supervision_interruption", "subagent_started", "editor_activity"];
  for (const eventType of types) {
    const event = toAgentEvent(buildEventPayload(IDENTITY, { eventType, severity: "low", metadata: { toolName: "Edit", outcome: "unknown", workspaceLabel: "never-copied" } }));
    for (const key of Object.keys(event)) assert.ok(allowed.has(key), `${eventType}: ${key} isn't in the schema`);
    assert.ok(schema.properties.kind.enum.includes(event.kind), `${eventType}: ${event.kind}`);
    assert.equal(event.outcome, undefined, "unknown is the same as not saying");
    assert.equal(JSON.stringify(event).includes("never-copied"), false, "metadata is copied field by field, never wholesale");
  }
  assert.equal(toAgentEvent(buildEventPayload(IDENTITY, { eventType: "ai_prompt_submitted", severity: "low", metadata: { toolName: "Edit" } })).tool, undefined, "a tool name only rides tool events");
  assert.equal(toAgentEvent(buildEventPayload({ toolInstallationId: "v:1", source: "vscode_extension" }, { eventType: "editor_activity", severity: "low", metadata: {} })).agent, "vscode");
  assert.equal(toAgentEvent(buildEventPayload(IDENTITY, { eventType: "editor_activity", severity: "low", metadata: {} })).kind, "other");
});
