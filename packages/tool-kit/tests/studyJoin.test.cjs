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
// grant Report mode carries, printed before they answer anything.

const START_RESPONSE = {
  joinSessionId: "join-session-1",
  shortCode: "654321",
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  organisationName: "Acme Health",
  studyTitle: "Study of Things",
  studyWindow: "1 Jan – 28 Jan 2027",
  grants: [
    "A weekly work-shape summary, shared with the organisation as a group figure only",
    "Your after-hours flag for the study window",
    "Your interleave rate for the study window"
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
  match: (url) => url.endsWith("/v1/org-study-joins"),
  respond: () => jsonResponse(200, response)
});

test("lists every grant the start response names, before the question", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { calls, restore } = mockFetch([startHandler()]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test Agent", joinCode: "CODE", stdin, stdout });
    await waitFor(output, "Choice [Not now]");
    stdin.write("\n"); // Enter: the default, not an explicit "Not now"
    const code = await done;
    assert.equal(code, 0);
    for (const grant of START_RESPONSE.grants) {
      assert.ok(output().includes(grant), `question is missing a grant: ${grant}`);
    }
    // Nothing is truncated or summarised behind "and more".
    assert.ok(!/and more/i.test(output()));
    assert.equal(calls.length, 1, "only the lookup that produced the question ran");
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
    {
      match: (url) => url.endsWith(`/v1/org-study-joins/${START_RESPONSE.joinSessionId}/status`),
      respond: () => jsonResponse(200, { status: "confirmed", grants: START_RESPONSE.grants, reason: null })
    }
  ]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout, pollIntervalMs: 5 });
    await waitFor(output, "Choice [Not now]");
    stdin.write("1\n");
    const code = await done;
    assert.equal(code, 0);
    assert.match(output(), new RegExp(START_RESPONSE.shortCode));
    assert.match(output(), /Joined\. Granted:/);
    for (const grant of START_RESPONSE.grants) assert.ok(output().includes(grant));
    assert.match(output(), /turned off separately, in the app's consent settings/);
    assert.match(output(), /group counts, never who joined/);
    assert.equal(calls.length, 2, "the lookup, then exactly one confirming poll");
  } finally {
    restore();
  }
});

test("expiry prints the backend's own reason, in plain words", async () => {
  const { stdin, stdout, output } = ttyPair();
  const reason = "This code expired before it was confirmed.";
  const { restore } = mockFetch([
    startHandler(),
    {
      match: (url) => url.endsWith(`/v1/org-study-joins/${START_RESPONSE.joinSessionId}/status`),
      respond: () => jsonResponse(200, { status: "expired", grants: null, reason })
    }
  ]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout, pollIntervalMs: 5 });
    await waitFor(output, "Choice [Not now]");
    stdin.write("1\n");
    const code = await done;
    assert.equal(code, 1);
    assert.ok(output().includes(reason), "the backend's own sentence must appear verbatim");
  } finally {
    restore();
  }
});

test("refusal prints the backend's own reason, in plain words", async () => {
  const { stdin, stdout, output } = ttyPair();
  const reason = "Declined on the confirming device.";
  const { restore } = mockFetch([
    startHandler(),
    {
      match: (url) => url.endsWith(`/v1/org-study-joins/${START_RESPONSE.joinSessionId}/status`),
      respond: () => jsonResponse(200, { status: "refused", grants: null, reason })
    }
  ]);
  try {
    const done = runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "CODE", stdin, stdout, pollIntervalMs: 5 });
    await waitFor(output, "Choice [Not now]");
    stdin.write("1\n");
    const code = await done;
    assert.equal(code, 1);
    assert.ok(output().includes(reason));
  } finally {
    restore();
  }
});

test("an unknown join code is refused in plain words, no session, no question asked", async () => {
  const { stdin, stdout, output } = ttyPair();
  const { restore } = mockFetch([
    { match: (url) => url.endsWith("/v1/org-study-joins"), respond: () => jsonResponse(404, { error: "unknown_join_code" }) }
  ]);
  try {
    let stderrText = "";
    const stderr = new PassThrough();
    stderr.on("data", (c) => { stderrText += c.toString(); });
    const code = await runStudyJoin({ apiBaseUrl: "http://mock", eventWriteToken: "tok", displayName: "Test", joinCode: "BOGUS", stdin, stdout, stderr });
    assert.equal(code, 1);
    assert.ok(!/Choice \[Not now\]/.test(output()), "no question when there is nothing to ask about");
    assert.ok(!/error|unknown_join_code/i.test(stderrText), "a wire code is not a plain-words reason");
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
    for (const grant of START_RESPONSE.grants) assert.ok(output().includes(grant), "flags did not suppress the grants list");
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
