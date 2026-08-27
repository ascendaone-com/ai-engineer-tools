import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Claude Code spawns hooks with whatever environment it was launched from, so
// the credentials file is the difference between telemetry that works and
// telemetry that silently stops whenever the editor is opened from a launcher.
process.env.ASCENDA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-home-"));
delete process.env.ASCENDA_API_BASE_URL;
delete process.env.ASCENDA_TOOL_INSTALLATION_ID;
delete process.env.ASCENDA_EVENT_WRITE_TOKEN;

const { credentialsFilePath, readCredentials, writeCredentials } = await import("../dist/paths.js");
const { loadConfigFromEnv, DEFAULT_API_BASE_URL } = await import("../dist/config.js");
const { defaultTokenFilePath, persistEventWriteToken } = await import("@ascenda-one/tool-kit");

test("credentials round-trip, owner-readable only", () => {
  writeCredentials({ apiBaseUrl: "http://localhost:4477", toolInstallationId: "claude_code:abc" });
  assert.deepEqual(readCredentials(), { apiBaseUrl: "http://localhost:4477", toolInstallationId: "claude_code:abc" });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(credentialsFilePath()).mode & 0o777, 0o600);
  }
});

test("config falls back to the credentials file when the environment is empty", () => {
  writeCredentials({ apiBaseUrl: "http://localhost:4477", toolInstallationId: "claude_code:abc" });
  persistEventWriteToken(defaultTokenFilePath("claude_code:abc"), "tok_123");

  const config = loadConfigFromEnv();
  assert.equal(config.apiBaseUrl, "http://localhost:4477");
  assert.equal(config.toolInstallationId, "claude_code:abc");
  assert.equal(config.eventWriteToken, "tok_123");
});

test("environment still wins over the credentials file", () => {
  writeCredentials({ apiBaseUrl: "http://localhost:4477", toolInstallationId: "claude_code:abc" });
  process.env.ASCENDA_API_BASE_URL = "https://example.test/";
  try {
    assert.equal(loadConfigFromEnv().apiBaseUrl, "https://example.test", "and the trailing slash is trimmed");
  } finally {
    delete process.env.ASCENDA_API_BASE_URL;
  }
});

test("unreadable or malformed credentials degrade to unconfigured, not a crash", () => {
  fs.writeFileSync(credentialsFilePath(), "{ not json");
  assert.equal(readCredentials(), undefined);
  assert.throws(() => loadConfigFromEnv(), /Not configured/, "and the error tells you how to fix it");

  fs.writeFileSync(credentialsFilePath(), JSON.stringify(["wrong", "shape"]));
  assert.equal(readCredentials(), undefined);
});

test("the built-in default is only used when nothing else is configured", () => {
  fs.rmSync(credentialsFilePath(), { force: true });
  process.env.ASCENDA_TOOL_INSTALLATION_ID = "claude_code:abc";
  try {
    assert.equal(loadConfigFromEnv().apiBaseUrl, DEFAULT_API_BASE_URL);
  } finally {
    delete process.env.ASCENDA_TOOL_INSTALLATION_ID;
  }
});
