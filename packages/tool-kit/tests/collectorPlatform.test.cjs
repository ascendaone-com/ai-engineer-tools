const { test } = require("node:test");

// Same isolation as collectorVersion.test.cjs: a sender with no stateFilePath
// journals into ~/.ascenda/state unless this is redirected first.
process.env.ASCENDA_STATE_DIR = require("node:fs").mkdtempSync(
  require("node:path").join(require("node:os").tmpdir(), "ascenda-test-state-")
);
const assert = require("node:assert/strict");
const { COLLECTOR_PLATFORM, buildEventPayload, detectCollectorPlatform } = require("../out/index.js");

test("macOS and Windows report themselves", () => {
  assert.equal(detectCollectorPlatform({ platform: "darwin" }), "darwin");
  assert.equal(detectCollectorPlatform({ platform: "win32" }), "win32");
});

test("plain Linux is linux", () => {
  assert.equal(detectCollectorPlatform({ platform: "linux", env: {}, release: "6.8.0-45-generic" }), "linux");
});

test("WSL is told apart from Linux, by environment or by kernel release", () => {
  assert.equal(detectCollectorPlatform({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, release: "6.8.0" }), "wsl");
  assert.equal(detectCollectorPlatform({ platform: "linux", env: { WSL_INTEROP: "/run/WSL/1_interop" }, release: "6.8.0" }), "wsl");
  // A scrubbed environment still has the kernel: WSL 2 and WSL 1 spellings.
  assert.equal(detectCollectorPlatform({ platform: "linux", env: {}, release: "5.15.153.1-microsoft-standard-WSL2" }), "wsl");
  assert.equal(detectCollectorPlatform({ platform: "linux", env: {}, release: "4.4.0-19041-Microsoft" }), "wsl");
});

test("anything else is other, never a raw platform string", () => {
  assert.equal(detectCollectorPlatform({ platform: "freebsd" }), "other");
  assert.equal(detectCollectorPlatform({ platform: "aix" }), "other");
});

test("this process's platform is one of the closed list", () => {
  assert.ok(["darwin", "win32", "linux", "wsl", "other"].includes(COLLECTOR_PLATFORM));
});

test("buildEventPayload stamps the platform beside the version, and a mapper cannot override it", () => {
  const bare = buildEventPayload(
    { toolInstallationId: "cli_agent:x", source: "cli_agent" },
    { eventType: "ai_tool_call_completed", severity: "low" }
  );
  assert.equal(bare.metadata.collectorPlatform, COLLECTOR_PLATFORM);

  const spoofed = buildEventPayload(
    { toolInstallationId: "cli_agent:x", source: "cli_agent" },
    { eventType: "ai_tool_call_completed", severity: "low", metadata: { collectorPlatform: "plan9" } }
  );
  assert.equal(spoofed.metadata.collectorPlatform, COLLECTOR_PLATFORM);
});
