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
