const { test } = require("node:test");

// Same isolation as eventSender.test.cjs: a sender with no stateFilePath
// journals into ~/.ascenda/state unless this is redirected first.
process.env.ASCENDA_STATE_DIR = require("node:fs").mkdtempSync(
  require("node:path").join(require("node:os").tmpdir(), "ascenda-test-state-")
);
const assert = require("node:assert/strict");
const {
  AscendaEventSender,
  COLLECTOR_VERSION,
  UNRELEASED_COLLECTOR_VERSION,
  buildEventPayload,
  describeCollectorVersion
} = require("../out/index.js");

// Every builder in eventSender.ts stamps metadata.collectorVersion. This suite
// runs `out/` directly, with no bundler to define a release into it, which is
// exactly an unstamped build: it must say "unreleased".

function sender() {
  const bodies = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ status: "accepted" }), { status: 200 });
  };
  const instance = new AscendaEventSender({
    apiBaseUrl: "https://api.example.test",
    toolInstallationId: "claude_code:abc123",
    source: "mcp_server",
    eventWriteToken: "token-1",
    tokenFilePath: "/tmp/does-not-matter"
  });
  return { instance, bodies, restore: () => (global.fetch = originalFetch) };
}

test("an unbundled build reports the literal unreleased, never the package.json placeholder", () => {
  assert.equal(COLLECTOR_VERSION, "unreleased");
  assert.equal(UNRELEASED_COLLECTOR_VERSION, "unreleased");
});

test("buildEventPayload stamps the version, with or without caller metadata", () => {
  const bare = buildEventPayload(
    { toolInstallationId: "cli_agent:x", source: "cli_agent" },
    { eventType: "ai_tool_call_completed", severity: "low" }
  );
  assert.equal(bare.metadata.collectorVersion, COLLECTOR_VERSION);

  const withMetadata = buildEventPayload(
    { toolInstallationId: "cli_agent:x", source: "cli_agent" },
    { eventType: "ai_tool_call_completed", severity: "low", metadata: { host: "cursor", collectorVersion: "9.9.9" } }
  );
  assert.equal(withMetadata.metadata.host, "cursor");
  assert.equal(withMetadata.metadata.collectorVersion, COLLECTOR_VERSION, "a mapper cannot claim another build");
});

test("send, sendSemanticSignal and sendCollaborationSignal all put the version on the wire", async () => {
  const { instance, bodies, restore } = sender();
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    await instance.sendSemanticSignal({ eventType: "progress_stalled", metadata: { skillVersion: "1.0.0" } });
    await instance.sendCollaborationSignal({ eventType: "review_given", severity: "low" });
  } finally {
    restore();
  }
  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assert.equal(body.metadata.collectorVersion, COLLECTOR_VERSION, `${body.eventType} left without a version`);
  }
  assert.equal(bodies[1].metadata.skillVersion, "1.0.0", "the skill's own version rides beside it, untouched");
});

test("status says what an unreleased build is, and prints a release as the bare version", () => {
  assert.equal(describeCollectorVersion("unreleased"), "unreleased (built from a checkout, not a release)");
  assert.equal(describeCollectorVersion("0.1.28"), "0.1.28");
});
