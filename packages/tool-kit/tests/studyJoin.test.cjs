const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { runStudyJoin, runCliAgentSetup, persistEventWriteToken, writeHostCredentials, defaultTokenFilePath } = require("../out/index.js");

// `join` carries a live product decision (G-D55.3): an agent must never be
// able to join a person to a study. These pin the four rules that make that
// true regardless of who calls it — every CLI agent shares this one
// implementation — plus the one behaviour a person actually reads: every
// grant Report mode carries, printed before they answer anything, in plain
// words rather than the wire's own `code`/`name` shape.

// The two plain sentences `studyJoin.ts` renders for these codes — asserted
// against directly so a test that only checked "the grants are present"
// could not pass while quietly showing a raw `name` like `AiDataProcessing`.
const AI_DATA_PROCESSING_SENTENCE = "Live AI tool telemetry, for the study window";
const HISTORICAL_IMPORT_SENTENCE = "A one-time import of your past AI work";

const START_RESPONSE = {
  joinSessionId: "join-session-1",
  deviceCode: "654321",
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  organisationName: "Acme Health",
  studyKind: "Study of Things",
  windowStartUtc: "2027-01-01T00:00:00.000Z",
  windowEndUtc: "2027-01-28T00:00:00.000Z",
  // Report mode carries exactly two grants (confirmed 28 Sep 2026): live AI
  // tool telemetry, and a one-time import of past work. No third,
  // agent-observed grant. Named here exactly as the wire names them — a
  // stable numeric code plus the backend's own internal spelling — because
  // that is the point of these tests: the CLI must translate this, not
  // parrot it.
  grants: [
    { code: 501, name: "AiDataProcessing" },
    { code: 507, name: "HistoricalImport" }
  ]
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fetch stub that records every call and answers by URL suffix, in order. */
function mockFetch(handlers) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const handler of handlers) {
      if (handler.match(String(url), init)) return handler.respond(calls.length);
    }
    throw new Error(`unmocked fetch call: ${url}`);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

function ttyPair() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  let out = "";
  stdout.on("data", (chunk) => { out += chunk.toString(); });
  return { stdin, stdout, output: () => out };
}

function waitFor(getText, substring, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (getText().includes(substring)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${JSON.stringify(substring)} in:\n${getText()}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const startHandler = (response = START_RESPONSE) => ({
  match: (url) => url.endsWith("/v1/org-study-join-sessions"),
  respond: () => jsonResponse(200, response)
});

const statusHandler = (body, joinSessionId = START_RESPONSE.joinSessionId) => ({
  match: (url) => url.endsWith(`/v1/org-study-join-sessions/${joinSessionId}/status`),
  respond: () => jsonResponse(200, body)
});

test("lists every grant the start response names, as a plain sentence, before the question", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { calls, restore } = mockFetch([startHandler()]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test Agent", joinCode: "CODE", stdin, stdout });
    await waitFor(output, "Choice [Not now]");
    stdin.write("\n"); // Enter: the default, not an explicit "Not now"
    const code = await done;
    assert.equal(code, 0);
    assert.ok(output().includes(AI_DATA_PROCESSING_SENTENCE), "grant 501 did not render as its plain sentence");
    assert.ok(output().includes(HISTORICAL_IMPORT_SENTENCE), "grant 507 did not render as its plain sentence");
    // The raw wire name is not itself display text.
    assert.ok(!output().includes("AiDataProcessing"), "a raw wire name leaked into the question");
    assert.ok(!output().includes("HistoricalImport"), "a raw wire name leaked into the question");
    // Nothing is truncated or summarised behind "and more".
    assert.ok(!/and more/i.test(output()));
    assert.equal(calls.length, 1, "only the lookup that produced the question ran");
  } finally {
    restore();
  }
});

test("a grant code this table does not recognise still renders — humanised, not hidden", async () => {
  const { stdin, stdout, output } = ttyPair();
  const response = { ...START_RESPONSE, grants: [{ code: 999, name: "SomeFutureGrant" }] };
  const { restore } = mockFetch([startHandler(response)]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout });
    await waitFor(output, "Choice [Not now]");
    stdin.write("\n");
    await done;
    assert.ok(output().includes("Some Future Grant"), "an unrecognised grant must still be shown, humanised from its name");
  } finally {
    restore();
  }
});

test("no TTY on stdin: Not now, exit 0, zero requests", async () => {
  const { calls, restore } = mockFetch([]); // any call throws — proves none happens
  try {
    const stdin = new PassThrough(); // isTTY left undefined
    const stdout = new PassThrough();
    stdout.isTTY = true;
    const code = await runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout });
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("no TTY on stdout: Not now, exit 0, zero requests", async () => {
  const { calls, restore } = mockFetch([]);
  try {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    const stdout = new PassThrough(); // isTTY left undefined
    const code = await runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout });
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("non-interactive stdin (piped, no TTY) means Not now even with a code given", async () => {
  const { calls, restore } = mockFetch([]);
  try {
    const stdin = new PassThrough();
    stdin.end("some piped input\n"); // a real pipe: never a TTY
    const stdout = new PassThrough();
    stdout.isTTY = true;
    const code = await runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout });
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("Enter at the prompt means Not now: no request beyond the one that rendered the question", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { calls, restore } = mockFetch([startHandler()]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout });
    await waitFor(output, "Choice [Not now]");
    stdin.write("\n");
    const code = await done;
    assert.equal(code, 0);
    assert.match(output(), /Not now\./);
    assert.equal(calls.length, 1, "no confirm/poll request follows a decline");
  } finally {
    restore();
  }
});

test("EOF at the prompt means Not now: same guarantee as Enter", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { calls, restore } = mockFetch([startHandler()]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout });
    await waitFor(output, "Choice [Not now]");
    stdin.end(); // Ctrl-D with nothing typed
    const code = await done;
    assert.equal(code, 0);
    assert.match(output(), /Not now\./);
    assert.equal(calls.length, 1, "no confirm/poll request follows an EOF decline");
  } finally {
    restore();
  }
});

test("garbage input is Not now too — only an explicit Report choice proceeds", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { calls, restore } = mockFetch([startHandler()]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout });
    await waitFor(output, "Choice [Not now]");
    stdin.write("yes please\n");
    const code = await done;
    assert.equal(code, 0);
    assert.match(output(), /Not now\./);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test("choosing Report polls until confirmed, then prints every granted item and the revoke line", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { calls, restore } = mockFetch([
    startHandler(),
    statusHandler({ status: "confirmed", granted: START_RESPONSE.grants, refusedReason: null })
  ]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout, pollIntervalMs: 5 });
    await waitFor(output, "Choice [Not now]");
    stdin.write("1\n");
    const code = await done;
    assert.equal(code, 0);
    assert.match(output(), new RegExp(START_RESPONSE.deviceCode));
    assert.match(output(), /Joined\. Granted:/);
    assert.ok(output().includes(AI_DATA_PROCESSING_SENTENCE));
    assert.ok(output().includes(HISTORICAL_IMPORT_SENTENCE));
    assert.match(output(), /turned off separately, in the app's consent settings/);
    assert.match(output(), /group counts, never who joined/);
    assert.equal(calls.length, 2, "the lookup, then exactly one confirming poll");
  } finally {
    restore();
  }
});

test("expiry has no reason of its own — a fixed, plain-words line, never a wire code", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { restore } = mockFetch([
    startHandler(),
    statusHandler({ status: "expired", granted: null, refusedReason: null })
  ]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout, pollIntervalMs: 5 });
    await waitFor(output, "Choice [Not now]");
    stdin.write("1\n");
    const code = await done;
    assert.equal(code, 1);
    assert.match(output(), /expired before it was confirmed/i);
  } finally {
    restore();
  }
});

test("refusal translates the enum reason into plain words — wrong_user", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { restore } = mockFetch([
    startHandler(),
    statusHandler({ status: "refused", granted: null, refusedReason: "wrong_user" })
  ]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout, pollIntervalMs: 5 });
    await waitFor(output, "Choice [Not now]");
    stdin.write("1\n");
    const code = await done;
    assert.equal(code, 1);
    assert.ok(!/wrong_user/.test(output()), "the enum value itself is not a plain-words reason");
    assert.match(output(), /someone other than who this tool is paired to/i);
  } finally {
    restore();
  }
});

test("refusal translates the enum reason into plain words — study_no_longer_live", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { restore } = mockFetch([
    startHandler(),
    statusHandler({ status: "refused", granted: null, refusedReason: "study_no_longer_live" })
  ]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout, pollIntervalMs: 5 });
    await waitFor(output, "Choice [Not now]");
    stdin.write("1\n");
    const code = await done;
    assert.equal(code, 1);
    assert.ok(!/study_no_longer_live/.test(output()));
    assert.match(output(), /no longer open to join/i);
  } finally {
    restore();
  }
});

test("an unrecognised refusal reason still prints something rather than crashing", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { restore } = mockFetch([
    startHandler(),
    statusHandler({ status: "refused", granted: null, refusedReason: "brand_new_reason_not_in_the_table" })
  ]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout, pollIntervalMs: 5 });
    await waitFor(output, "Choice [Not now]");
    stdin.write("1\n");
    const code = await done;
    assert.equal(code, 1);
    assert.match(output(), /Declined/);
  } finally {
    restore();
  }
});

test("an unknown join code is refused in plain words, no session, no question asked", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { restore } = mockFetch([
    { match: (url) => url.endsWith("/v1/org-study-join-sessions"), respond: () => jsonResponse(404, { code: "join_code_not_found" }) }
  ]);
  try {
    let stderrText = "";
    const stderr = new PassThrough();
    stderr.on("data", (c) => { stderrText += c.toString(); });
    const code = await runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "BOGUS", stdin, stdout, stderr });
    assert.equal(code, 1);
    assert.ok(!/Choice \[Not now\]/.test(output()), "no question when there is nothing to ask about");
    assert.ok(!/join_code_not_found/i.test(stderrText), "a wire code is not a plain-words reason");
  } finally {
    restore();
  }
});

test("no_live_study is refused in plain words too", async () => {
  const { restore } = mockFetch([
    { match: (url) => url.endsWith("/v1/org-study-join-sessions"), respond: () => jsonResponse(404, { code: "no_live_study" }) }
  ]);
  try {
    let stderrText = "";
    const stderr = new PassThrough();
    stderr.on("data", (c) => { stderrText += c.toString(); });
    const stdin = new PassThrough(); stdin.isTTY = true;
    const stdout = new PassThrough(); stdout.isTTY = true;
    const code = await runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout, stderr });
    assert.equal(code, 1);
    assert.match(stderrText, /nothing open to join/i);
  } finally {
    restore();
  }
});

// --- No flag path skips the question ---
//
// The only way into this flow from a real adapter is `runCliAgentSetup(["join",
// <code>, ...anything else]`, and the handler reads nothing past the code —
// there is no `--yes`, `--mode` or similar. This drives that exact entry
// point with extra flags a bypass would need, and confirms they do nothing:
// the question still renders, and Enter still declines.
test("runCliAgentSetup: unrecognised flags after the code do not skip or answer the question", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-join-cli-"));
  const savedHome = process.env.ASCENDA_HOME;
  process.env.ASCENDA_HOME = home;

  const spec = {
    host: "flat", displayName: "Flat", toolType: "cli_agent", packageName: "@ascenda-one/flat-hooks",
    binaryName: "ascenda-flat-hook", hookEvents: ["start", "stop"], restartHint: "", sends: [],
    settings: {
      settingsPath: (_scope, dir) => path.join(dir, "hooks.json"),
      entry: (command, event) => ({ command: `${command} ${event}` }),
      commandOf: (entry) => entry?.command
    }
  };
  writeHostCredentials("flat", { apiBaseUrl: "http://mock" });
  persistEventWriteToken(defaultTokenFilePath("cli_agent:flat-test"), "tok");
  process.env.ASCENDA_TOOL_INSTALLATION_ID = "cli_agent:flat-test";

  const { stdin, stdout, output } = ttyPair();
  const { calls, restore } = mockFetch([startHandler()]);
  const origIn = Object.getOwnPropertyDescriptor(process, "stdin");
  const origOut = Object.getOwnPropertyDescriptor(process, "stdout");
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  Object.defineProperty(process, "stdout", { value: stdout, configurable: true });

  try {
    const done = runCliAgentSetup(["join", "CODE", "--yes", "--mode", "report", "--auto-confirm"], spec);
    await waitFor(output, "Choice [Not now]");
    assert.ok(output().includes(AI_DATA_PROCESSING_SENTENCE), "flags did not suppress the grants list");
    assert.ok(output().includes(HISTORICAL_IMPORT_SENTENCE));
    stdin.write("\n");
    const code = await done;
    assert.equal(code, 0);
    assert.match(output(), /Not now\./, "Enter still declines even with bypass-shaped flags present");
    assert.equal(calls.length, 1, "the extra flags triggered no additional request");
  } finally {
    Object.defineProperty(process, "stdin", origIn);
    Object.defineProperty(process, "stdout", origOut);
    restore();
    delete process.env.ASCENDA_TOOL_INSTALLATION_ID;
    if (savedHome === undefined) delete process.env.ASCENDA_HOME; else process.env.ASCENDA_HOME = savedHome;
  }
});
