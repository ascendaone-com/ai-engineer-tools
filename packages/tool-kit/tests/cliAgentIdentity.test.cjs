const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MissingInstallationIdError,
  defaultTokenFilePath,
  deliverHookEvents,
  loadCliAgentConfig,
  persistEventWriteToken,
  readCollectorState,
  resolveCliAgentInstallationId,
  unresolvedStateFilePath,
  writeHostCredentials
} = require("../out/index.js");

// The shared runtime's answer to issue #48, the same three tiers the Claude
// Code adapter resolves through: the environment, then this host's entry in
// the credentials file, then the token store — and a send that still cannot
// name its installation is journalled rather than lost without a trace.
// Each test gets its own ASCENDA_HOME and ASCENDA_STATE_DIR so nothing here
// touches the developer's real ~/.ascenda.

const UUID_A = "0d7b1e2a-5f3c-4a8e-9b1d-2c3e4f5a6b7c";
const UUID_B = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
const ENV_KEYS = ["ASCENDA_TOOL_INSTALLATION_ID", "ASCENDA_EVENT_WRITE_TOKEN", "ASCENDA_EVENT_WRITE_TOKEN_FILE", "ASCENDA_EVENT_LOG_FILE", "ASCENDA_API_BASE_URL"];

async function isolated(run) {
  const saved = Object.fromEntries([...ENV_KEYS, "ASCENDA_HOME", "ASCENDA_STATE_DIR", "HOME"].map((k) => [k, process.env[k]]));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-identity-"));
  process.env.ASCENDA_HOME = home;
  process.env.HOME = home;
  process.env.ASCENDA_STATE_DIR = path.join(home, "state");
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    // Awaited, so an async body runs inside the isolation rather than after it.
    return await run(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("one cli_agent token on disk: the id comes from disk, and the token from that file", async () => {
  await isolated(() => {
    persistEventWriteToken(defaultTokenFilePath(`cli_agent:${UUID_A}`), "tok_a");
    assert.deepEqual(resolveCliAgentInstallationId("cli_agent", { host: "cursor" }), { toolInstallationId: `cli_agent:${UUID_A}`, source: "disk" });
    const config = loadCliAgentConfig("cli_agent", undefined, undefined, { host: "cursor" });
    assert.equal(config.toolInstallationId, `cli_agent:${UUID_A}`);
    assert.equal(config.eventWriteToken, "tok_a");
  });
});

test("this host's credentials entry wins over the disk fallback, and the environment wins over both", async () => {
  await isolated(() => {
    persistEventWriteToken(defaultTokenFilePath(`cli_agent:${UUID_A}`), "tok_a");
    writeHostCredentials("cursor", { toolInstallationId: `cli_agent:${UUID_B}`, apiBaseUrl: "http://localhost:4477" });
    persistEventWriteToken(defaultTokenFilePath(`cli_agent:${UUID_B}`), "tok_b");

    assert.deepEqual(resolveCliAgentInstallationId("cli_agent", { host: "cursor" }), { toolInstallationId: `cli_agent:${UUID_B}`, source: "credentials" });
    const config = loadCliAgentConfig("cli_agent", undefined, undefined, { host: "cursor" });
    assert.equal(config.apiBaseUrl, "http://localhost:4477", "the api base url comes from the same entry");

    process.env.ASCENDA_TOOL_INSTALLATION_ID = `cli_agent:${UUID_A}`;
    assert.deepEqual(resolveCliAgentInstallationId("cli_agent", { host: "cursor" }), { toolInstallationId: `cli_agent:${UUID_A}`, source: "env" });
  });
});

test("another host's entry is not this host's identity", async () => {
  await isolated(() => {
    writeHostCredentials("gemini_cli", { toolInstallationId: `cli_agent:${UUID_B}` });
    assert.throws(() => resolveCliAgentInstallationId("cli_agent", { host: "cursor" }), MissingInstallationIdError);
  });
});

test("zero or several tokens: throws, naming every source tried and the host's own setup command", async () => {
  await isolated(() => {
    assert.throws(
      () => resolveCliAgentInstallationId("cli_agent", { host: "cursor", setupCommand: "npx @ascenda-one/cursor-hooks setup" }),
      (error) => error instanceof MissingInstallationIdError && error.candidates.length === 0
        && /Not configured/.test(error.message) && /no cli_agent token/.test(error.message)
        && /npx @ascenda-one\/cursor-hooks setup/.test(error.message)
    );

    persistEventWriteToken(defaultTokenFilePath(`cli_agent:${UUID_A}`), "tok_a");
    persistEventWriteToken(defaultTokenFilePath(`cli_agent:${UUID_B}`), "tok_b");
    assert.throws(
      () => resolveCliAgentInstallationId("cli_agent", { host: "cursor" }),
      (error) => error instanceof MissingInstallationIdError && error.candidates.length === 2
        && error.message.includes(UUID_A) && error.message.includes(UUID_B) && /refusing to guess/.test(error.message)
    );
  });
});

test("a delivery with no resolvable id is journalled as skipped_no_installation_id before anything else", async () => {
  await isolated(async () => {
    const event = { eventType: "ai_tool_call_started", severity: "low", metadata: { host: "cursor", toolName: "Shell" } };
    // No log file configured: the runtime rethrows for the CLI's stderr, but
    // only after the journal has the line — that ordering is the fix.
    await assert.rejects(() => deliverHookEvents([event], { toolType: "cli_agent", host: "cursor", source: "cli_agent" }), MissingInstallationIdError);
    await assert.rejects(() => deliverHookEvents([event], { toolType: "cli_agent", host: "cursor", source: "cli_agent" }), MissingInstallationIdError);

    const journal = readCollectorState(unresolvedStateFilePath("cli_agent"));
    assert.equal(journal.lastOutcome, "skipped_no_installation_id");
    assert.equal(journal.toolInstallationId, "cli_agent:unresolved");
    assert.equal(journal.consecutiveFailures, 2, "one entry per skipped hook invocation");
    assert.ok(journal.failingSince, "since when");
    assert.match(journal.detail, /^cursor: .*no cli_agent token file/);

    // With a log file the unpaired mode is supported, and the skip is still journalled.
    process.env.ASCENDA_EVENT_LOG_FILE = path.join(process.env.ASCENDA_HOME, "events.jsonl");
    await deliverHookEvents([event], { toolType: "cli_agent", host: "windsurf", source: "cli_agent" });
    assert.equal(readCollectorState(unresolvedStateFilePath("cli_agent")).consecutiveFailures, 3);
    assert.match(readCollectorState(unresolvedStateFilePath("cli_agent")).detail, /^windsurf: /);
    const logged = JSON.parse(fs.readFileSync(process.env.ASCENDA_EVENT_LOG_FILE, "utf8").trim());
    assert.equal(logged.delivery, "not_sent");
    assert.ok(Number.isInteger(logged.payload.utcOffsetMinutes), "even an unsent record carries the offset the wire would");
  });
});
