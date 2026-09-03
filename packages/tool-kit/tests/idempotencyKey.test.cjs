const { test } = require("node:test");

// See eventSender.test.cjs: the journal defaults to the real ~/.ascenda/state
// when stateFilePath is omitted, so redirect before anything is constructed.
process.env.ASCENDA_STATE_DIR = require("node:fs").mkdtempSync(
  require("node:path").join(require("node:os").tmpdir(), "ascenda-test-state-")
);
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IDEMPOTENCY_KEY_MAX_LENGTH } = require("@ascenda-one/tool-contract");
const { AscendaEventSender, buildEventPayload, mintIdempotencyKey } = require("../out/index.js");

// The idempotencyKey (issues #50 / #51; backend asc-core-be#141) only does its
// job if one event carries one key for its whole life. These tests pin the two
// halves of that: the key is minted where the payload is constructed, and every
// in-process resend — the 250 ms transport retry and the post-renewal replay —
// puts the identical payload back on the wire. A key minted at send time would
// pass a "key is present" check and dedupe nothing; the stability tests are
// the ones that matter.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertWireKey(key) {
  assert.equal(typeof key, "string");
  assert.equal(key, key.trim(), "a key with surrounding whitespace would be trimmed server-side — send it clean");
  assert.ok(key.length > 0, "blank is treated as absent by the server");
  assert.ok(key.length <= IDEMPOTENCY_KEY_MAX_LENGTH, `${key.length} chars exceeds the ${IDEMPOTENCY_KEY_MAX_LENGTH}-char wire limit`);
  assert.match(key, UUID_V4);
}

function sender(fetchImpl) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  const tokenFilePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-test-token-")), "token");
  const instance = new AscendaEventSender({
    apiBaseUrl: "https://api.example.test",
    toolInstallationId: "claude_code:abc123",
    source: "claude_code",
    eventWriteToken: "token-1",
    tokenFilePath,
    eventLogFile: null
  });
  return { instance, restore: () => (global.fetch = originalFetch) };
}

const accepted = () => new Response(JSON.stringify({ status: "accepted" }), { status: 200 });

test("mintIdempotencyKey yields a v4 UUID inside the wire limit", () => {
  const key = mintIdempotencyKey();
  assertWireKey(key);
  assert.equal(IDEMPOTENCY_KEY_MAX_LENGTH, 128, "the limit is the backend's; re-read the contract before changing it");
  // Two mints are two keys. The point of the key is that *the same event*
  // keeps its key, not that all events share one.
  assert.notEqual(key, mintIdempotencyKey());
});

test("buildEventPayload stamps a key at construction, top-level and not in metadata", () => {
  const identity = { toolInstallationId: "claude_code:abc123", source: "claude_code" };
  const payload = buildEventPayload(identity, { eventType: "ai_tool_call_completed", severity: "low" });
  assertWireKey(payload.idempotencyKey);
  // importKey lives in metadata and is a different thing; the two must not
  // be conflated in either direction.
  assert.equal(payload.metadata.idempotencyKey, undefined);
  assert.equal(payload.importKey, undefined);
});

test("every send path carries a key: host, semantic and collaboration events", async () => {
  const bodies = [];
  const { instance, restore } = sender(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return accepted();
  });
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    await instance.sendSemanticSignal({ eventType: "progress_stalled", metadata: { skillVersion: "1.0.0" } });
    await instance.sendCollaborationSignal({ eventType: "review_given", severity: "low" });
    assert.equal(bodies.length, 3);
    for (const body of bodies) assertWireKey(body.idempotencyKey);
    assert.equal(new Set(bodies.map((b) => b.idempotencyKey)).size, 3, "three events, three keys");
  } finally {
    restore();
  }
});

test("the 250 ms transport retry resends the same key — it is not re-minted on retry", async () => {
  const bodies = [];
  let calls = 0;
  const { instance, restore } = sender(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    calls += 1;
    // A 503 is the "no verdict" case the retry exists for: the server may or
    // may not have written the event. Only a stable key makes that safe.
    if (calls === 1) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    return accepted();
  });
  try {
    const result = await instance.send({ eventType: "ai_prompt_submitted", severity: "low" });
    assert.equal(result, "accepted");
    assert.equal(bodies.length, 2, "one retry, no more");
    assertWireKey(bodies[0].idempotencyKey);
    assert.equal(bodies[1].idempotencyKey, bodies[0].idempotencyKey);
    // Not just the key: the whole payload is byte-for-byte the same object.
    assert.deepEqual(bodies[1], bodies[0]);
  } finally {
    restore();
  }
});

test("a network-level failure (fetch throws) retries with the same key too", async () => {
  const bodies = [];
  let calls = 0;
  const { instance, restore } = sender(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return accepted();
  });
  try {
    assert.equal(await instance.send({ eventType: "ai_prompt_submitted", severity: "low" }), "accepted");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].idempotencyKey, bodies[0].idempotencyKey);
  } finally {
    restore();
  }
});

test("the post-renewal replay after a 401 resends the same key", async () => {
  const bodies = [];
  let eventCalls = 0;
  const { instance, restore } = sender(async (url, init) => {
    if (String(url).endsWith("/v1/tool-events/renew-token")) {
      return new Response(JSON.stringify({ eventWriteToken: "token-2", expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 });
    }
    bodies.push({ body: JSON.parse(init.body), auth: init.headers.Authorization });
    eventCalls += 1;
    if (eventCalls === 1) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    return accepted();
  });
  try {
    assert.equal(await instance.send({ eventType: "ai_prompt_submitted", severity: "low" }), "accepted");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].auth, "Bearer token-1");
    assert.equal(bodies[1].auth, "Bearer token-2", "the replay goes out under the renewed token");
    assert.equal(bodies[1].body.idempotencyKey, bodies[0].body.idempotencyKey);
  } finally {
    restore();
  }
});

test("a replay the server answers `duplicate` is a success on the sender, journalled as healthy", async () => {
  const { instance, restore } = sender(async () =>
    new Response(JSON.stringify({ status: "duplicate" }), { status: 200 })
  );
  try {
    const result = await instance.send({ eventType: "ai_prompt_submitted", severity: "low" });
    assert.equal(result, "accepted");
    assert.equal(instance.state.lastOutcome, "accepted");
    assert.equal(instance.state.consecutiveFailures, 0);
  } finally {
    restore();
  }
});
