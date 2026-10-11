const { test } = require("node:test");

// Same isolation as eventSender.test.cjs: a sender with no stateFilePath
// journals into ~/.ascenda/state unless this is redirected first.
process.env.ASCENDA_STATE_DIR = require("node:fs").mkdtempSync(
  require("node:path").join(require("node:os").tmpdir(), "ascenda-test-state-")
);
const assert = require("node:assert/strict");
const { AscendaEventSender, buildEventBody, buildEventPayload } = require("../out/index.js");
const { DELIVERY_ENVELOPE_KEYS, joinEventPayload, splitEventPayload } = require("../../tool-contract/out/index.js");

// The envelope/body split is a type-level change. The ingest contract is
// fixed, so what each builder puts on the wire has to be the same bytes it
// was before the split: same keys, same order. These key lists are that
// wire shape, written down. If one changes, the backend sees a different
// request, and that is a contract change, not a refactor.

const IDENTITY = {
  toolInstallationId: "cli_agent:x",
  source: "cli_agent",
  sessionId: "s-1",
  workspaceHash: "w-1",
  projectHash: "p-1"
};

const HOST_EVENT_KEYS = [
  "toolInstallationId",
  "source",
  "occurredAt",
  "idempotencyKey",
  "utcOffsetMinutes",
  "sessionId",
  "workspaceHash",
  "projectHash",
  "consentScope",
  "provenance",
  "privacyMode",
  "eventType",
  "severity",
  "metadata"
];

const SIGNAL_KEYS = [
  "toolInstallationId",
  "source",
  "eventType",
  "occurredAt",
  "idempotencyKey",
  "utcOffsetMinutes",
  "severity",
  "sessionId",
  "workspaceHash",
  "projectHash",
  "consentScope",
  "provenance",
  "privacyMode",
  "metadata"
];

function sender() {
  const bodies = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    bodies.push(init.body);
    return new Response(JSON.stringify({ status: "accepted" }), { status: 200 });
  };
  const instance = new AscendaEventSender({
    apiBaseUrl: "https://api.example.test",
    eventWriteToken: "token-1",
    tokenFilePath: "/tmp/does-not-matter",
    ...IDENTITY
  });
  return { instance, bodies, restore: () => (global.fetch = originalFetch) };
}

test("buildEventPayload keeps its wire key order", () => {
  const payload = buildEventPayload(IDENTITY, { eventType: "ai_tool_call_completed", severity: "low", metadata: { host: "cursor" } });
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(payload))), HOST_EVENT_KEYS);
});

test("send, sendSemanticSignal and sendCollaborationSignal keep their wire key order", async () => {
  const { instance, bodies, restore } = sender();
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    await instance.sendSemanticSignal({ eventType: "progress_stalled", metadata: { skillVersion: "1.0.0" } });
    await instance.sendCollaborationSignal({ eventType: "review_given", severity: "low" });
  } finally {
    restore();
  }
  assert.equal(bodies.length, 3);
  assert.deepEqual(Object.keys(JSON.parse(bodies[0])), HOST_EVENT_KEYS);
  assert.deepEqual(Object.keys(JSON.parse(bodies[1])), SIGNAL_KEYS);
  assert.deepEqual(Object.keys(JSON.parse(bodies[2])), SIGNAL_KEYS);
});

test("a body carries no delivery field", () => {
  const body = buildEventBody(IDENTITY, { eventType: "ai_tool_call_completed", severity: "low" });
  for (const key of DELIVERY_ENVELOPE_KEYS) {
    assert.equal(key in body, false, `${key} leaked into the body`);
  }
  assert.equal(body.source, "cli_agent");
  assert.equal(body.sessionId, "s-1");
});

test("split then join gives back the same bytes", async () => {
  const { instance, bodies, restore } = sender();
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    await instance.sendSemanticSignal({ eventType: "progress_stalled", metadata: { skillVersion: "1.0.0" } });
  } finally {
    restore();
  }
  for (const wire of bodies) {
    const { envelope, body } = splitEventPayload(JSON.parse(wire));
    assert.deepEqual(Object.keys(envelope), [...DELIVERY_ENVELOPE_KEYS]);
    assert.equal(JSON.stringify(joinEventPayload(envelope, body)), wire);
  }
});

test("an envelope without an idempotency key joins to a payload without one", () => {
  const body = buildEventBody(IDENTITY, { eventType: "ai_tool_call_completed", severity: "low" });
  const joined = JSON.parse(JSON.stringify(joinEventPayload({ toolInstallationId: "cli_agent:x" }, body)));
  assert.equal("idempotencyKey" in joined, false);
  assert.deepEqual(Object.keys(joined), HOST_EVENT_KEYS.filter((key) => key !== "idempotencyKey"));
});
