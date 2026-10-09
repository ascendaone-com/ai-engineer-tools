const { test } = require("node:test");

// The journal defaults to the real ~/.ascenda/state when a caller omits
// stateFilePath, so a suite that builds a sender writes fixture installations
// into the developer's actual home, where `doctor` reports them as real
// pairings. Redirect before anything is constructed.
process.env.ASCENDA_STATE_DIR = require("node:fs").mkdtempSync(
  require("node:path").join(require("node:os").tmpdir(), "ascenda-test-state-")
);
const assert = require("node:assert/strict");
const { AscendaEventSender, AscendaSemanticEventError } = require("../out/index.js");

// sendSemanticSignal is the one path a skill or the semantic MCP tool can use
// to reach the wire, and its whole job is to make the six rules from
// dark-flow-gap-analysis §2.1 impossible to get wrong from the call site:
// the right consent scope, severity pinned to "low", skillVersion present,
// and eventType actually one of the six. Each is pinned here because a
// caller violating any one of them would ship a semantic event the backend
// treats as a §12 claim violation, not merely a malformed request.

function sender(fetchImpl) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  const instance = new AscendaEventSender({
    apiBaseUrl: "https://api.example.test",
    toolInstallationId: "claude_code:abc123",
    source: "mcp_server",
    eventWriteToken: "token-1",
    tokenFilePath: "/tmp/does-not-matter"
  });
  return { instance, restore: () => (global.fetch = originalFetch) };
}

test("sendSemanticSignal rejects a non-semantic eventType before any network call", async () => {
  const { instance, restore } = sender(async () => {
    throw new Error("must not be called");
  });
  try {
    await assert.rejects(
      () =>
        instance.sendSemanticSignal({
          eventType: "ai_tool_call_completed",
          metadata: { skillVersion: "1.0.0" }
        }),
      AscendaSemanticEventError
    );
  } finally {
    restore();
  }
});

test("sendSemanticSignal rejects a missing skillVersion before any network call", async () => {
  const { instance, restore } = sender(async () => {
    throw new Error("must not be called");
  });
  try {
    await assert.rejects(
      () =>
        instance.sendSemanticSignal({
          eventType: "goal_drift_detected",
          metadata: { skillVersion: "" }
        }),
      AscendaSemanticEventError
    );
  } finally {
    restore();
  }
});

test("sendSemanticSignal sends the semantic consent scope, low severity, and the given skillVersion", async () => {
  let sentBody;
  const { instance, restore } = sender(async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: "accepted" }), { status: 200 });
  });
  try {
    const result = await instance.sendSemanticSignal({
      eventType: "approach_churn_detected",
      metadata: { skillVersion: "1.2.0", taskFingerprint: "abc" }
    });
    assert.equal(result, "accepted");
    assert.equal(sentBody.consentScope, "semantic_work_signals");
    assert.equal(sentBody.severity, "low");
    assert.equal(sentBody.eventType, "approach_churn_detected");
    assert.equal(sentBody.metadata.skillVersion, "1.2.0");
    assert.equal(sentBody.metadata.taskFingerprint, "abc");
  } finally {
    restore();
  }
});

test("sendSemanticSignal ignores a caller-supplied severity — it is never negotiable", async () => {
  let sentBody;
  const { instance, restore } = sender(async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: "accepted" }), { status: 200 });
  });
  try {
    await instance.sendSemanticSignal({
      eventType: "progress_stalled",
      // Not a valid input per the type, but the runtime check must still hold
      // for a caller that bypasses TypeScript (plain JS, dynamic construction).
      metadata: { skillVersion: "1.0.0", severity: "critical" }
    });
    assert.equal(sentBody.severity, "low");
  } finally {
    restore();
  }
});

test("send() (the deterministic-event path) is unaffected — still ide_telemetry, still metadata_only", async () => {
  let sentBody;
  const { instance, restore } = sender(async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: "accepted" }), { status: 200 });
  });
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.equal(sentBody.consentScope, "ide_telemetry");
    assert.equal(sentBody.privacyMode, "metadata_only");
  } finally {
    restore();
  }
});

// Renewal rotates the token and revokes the old one. A host whose token comes
// from its environment on every start (a hosted cloud session) cannot keep the
// replacement, so a rotation there would revoke the one copy every later
// session relies on. `renewToken: false` must therefore never reach the renew
// door, and must report the rejection it got rather than hide it.
test("renewToken: false leaves a rejected token rejected and never calls renew", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-norenew-"));
  const urls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers: { "Content-Type": "application/json" } });
  };
  try {
    const instance = new AscendaEventSender({
      apiBaseUrl: "https://api.example.test",
      toolInstallationId: "claude_code:abc123",
      source: "claude_code",
      eventWriteToken: "token-1",
      tokenFilePath: path.join(dir, "token"),
      stateFilePath: path.join(dir, "state.json"),
      outboxFilePath: path.join(dir, "outbox.jsonl"),
      outboxDrain: false,
      eventLogFile: null,
      renewToken: false
    });
    const result = await instance.send({ eventType: "ai_turn_completed", severity: "low", metadata: {} });
    assert.equal(result, "auth_failed");
    assert.ok(urls.length > 0, "the ingest door was tried");
    assert.ok(!urls.some((url) => url.includes("renew-token")), `renew was called: ${urls.join(", ")}`);
    assert.equal(await instance.renewEventToken(), false);
    assert.ok(!fs.existsSync(path.join(dir, "token")), "no rotated token was persisted");
  } finally {
    global.fetch = originalFetch;
  }
});

test("renewal stays on by default: a rejected token is renewed once", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-renew-"));
  const urls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers: { "Content-Type": "application/json" } });
  };
  try {
    const instance = new AscendaEventSender({
      apiBaseUrl: "https://api.example.test",
      toolInstallationId: "claude_code:abc123",
      source: "claude_code",
      eventWriteToken: "token-1",
      tokenFilePath: path.join(dir, "token"),
      stateFilePath: path.join(dir, "state.json"),
      outboxFilePath: path.join(dir, "outbox.jsonl"),
      outboxDrain: false,
      eventLogFile: null
    });
    await instance.send({ eventType: "ai_turn_completed", severity: "low", metadata: {} });
    assert.equal(urls.filter((url) => url.includes("renew-token")).length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

// Renewal on a 401 can't save an expired token: the server only rotates a
// live one. So a sender renews before it sends once the token is inside
// TOKEN_RENEW_LEAD_MS of expiry, and records the new expiry for next time.
function expiryFixture({ expiresInMs, recorded = true, renewToken, renewStatus = 200 }) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { persistEventWriteToken } = require("../out/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-expiry-"));
  const tokenFilePath = path.join(dir, "tokens", "token");
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  persistEventWriteToken(tokenFilePath, "token-1", recorded ? new Date(now + expiresInMs).toISOString() : undefined);
  if (!recorded) {
    const { EVENT_TOKEN_TTL_MS } = require("../out/index.js");
    const issued = new Date(now + expiresInMs - EVENT_TOKEN_TTL_MS);
    fs.utimesSync(tokenFilePath, issued, issued);
  }

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    if (String(url).includes("renew-token")) {
      if (renewStatus !== 200) return new Response(JSON.stringify({ error: "invalid_token" }), { status: renewStatus });
      return new Response(JSON.stringify({ eventWriteToken: "token-2", expiresAt: "2026-11-08T12:00:00.000Z" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "accepted" }), { status: 200 });
  };
  const instance = new AscendaEventSender({
    apiBaseUrl: "https://api.example.test",
    toolInstallationId: "claude_code:abc123",
    source: "claude_code",
    eventWriteToken: "token-1",
    tokenFilePath,
    stateFilePath: path.join(dir, "state.json"),
    outboxFilePath: path.join(dir, "outbox.jsonl"),
    outboxDrain: false,
    eventLogFile: null,
    timeProvider: { now: () => now },
    ...(renewToken === undefined ? {} : { renewToken })
  });
  const event = { eventType: "ai_turn_completed", severity: "low", metadata: {} };
  return { instance, event, calls, tokenFilePath, restore: () => (global.fetch = originalFetch) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

test("a token inside the renewal lead is renewed before the event is sent", async () => {
  const { readTokenFile, readTokenExpiry } = require("../out/index.js");
  const f = expiryFixture({ expiresInMs: 5 * DAY_MS });
  try {
    assert.equal(await f.instance.send(f.event), "accepted");
    assert.ok(f.calls[0].url.includes("renew-token"), "renewal goes first");
    assert.equal(f.calls[0].auth, "Bearer token-1");
    assert.equal(f.calls[1].auth, "Bearer token-2", "the event goes out on the new token");
    assert.equal(readTokenFile(f.tokenFilePath), "token-2");
    assert.equal(readTokenExpiry(f.tokenFilePath), Date.parse("2026-11-08T12:00:00.000Z"));

    await f.instance.send(f.event);
    assert.equal(f.calls.filter((c) => c.url.includes("renew-token")).length, 1, "once per sender");
  } finally {
    f.restore();
  }
});

test("a token with more than the lead left is not renewed", async () => {
  const { TOKEN_RENEW_LEAD_MS } = require("../out/index.js");
  const f = expiryFixture({ expiresInMs: TOKEN_RENEW_LEAD_MS + DAY_MS });
  try {
    await f.instance.send(f.event);
    assert.ok(!f.calls.some((c) => c.url.includes("renew-token")));
  } finally {
    f.restore();
  }
});

test("with no recorded expiry, the token file's age decides", async () => {
  const f = expiryFixture({ expiresInMs: 2 * DAY_MS, recorded: false });
  try {
    await f.instance.send(f.event);
    assert.ok(f.calls[0].url.includes("renew-token"), "a 28-day-old token file is renewed");
  } finally {
    f.restore();
  }
});

test("renewToken: false never renews early either", async () => {
  const f = expiryFixture({ expiresInMs: DAY_MS, renewToken: false });
  try {
    await f.instance.send(f.event);
    assert.ok(!f.calls.some((c) => c.url.includes("renew-token")));
  } finally {
    f.restore();
  }
});

// Two processes renewing the same token at once: the second is refused,
// because the first revoked the token it presented. The first's replacement
// is on disk by then, and the second should send on it.
test("a refused renewal adopts the token another process persisted", async () => {
  const fs = require("node:fs");
  const f = expiryFixture({ expiresInMs: 5 * DAY_MS, renewStatus: 401 });
  const fetchWithRace = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes("renew-token")) fs.writeFileSync(f.tokenFilePath, "token-from-other-process");
    return fetchWithRace(url, init);
  };
  try {
    assert.equal(await f.instance.send(f.event), "accepted");
    assert.equal(f.calls[1].auth, "Bearer token-from-other-process");
  } finally {
    f.restore();
  }
});
