/**
 * Where `import --ship` gets its identity and token when no Flow app (and no
 * exported variables) is around: flags, then env, then ~/.ascenda. Plus the
 * token's lifecycle before a shipment: renew inside the window, stop past
 * expiry. Every test points ASCENDA_HOME at its own temp dir.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadShipConfig, prepareToken, ShipConfigError } from "../dist/credentials.js";

const DAY = 24 * 60 * 60 * 1000;
const VARS = [
  "ASCENDA_HOME", "ASCENDA_TOOL_INSTALLATION_ID", "ASCENDA_EVENT_WRITE_TOKEN",
  "ASCENDA_EVENT_WRITE_TOKEN_FILE", "ASCENDA_API_BASE_URL"
];
let home;
let saved;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-ship-"));
  process.env.ASCENDA_HOME = home;
});
afterEach(() => {
  for (const v of VARS) saved[v] === undefined ? delete process.env[v] : (process.env[v] = saved[v]);
  fs.rmSync(home, { recursive: true, force: true });
});

function writeCredentials(value) {
  fs.writeFileSync(path.join(home, "credentials.json"), JSON.stringify(value));
}
function writeToken(id, token, expiresAt) {
  const dir = path.join(home, "tokens");
  fs.mkdirSync(path.join(dir, "expiry"), { recursive: true });
  const name = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  fs.writeFileSync(path.join(dir, name), token);
  if (expiresAt) fs.writeFileSync(path.join(dir, "expiry", name), new Date(expiresAt).toISOString());
  return path.join(dir, name);
}

test("with nothing set it names every place it looked", () => {
  assert.throws(() => loadShipConfig(), (e) => e instanceof ShipConfigError && /credentials\.json/.test(e.message) && /setup/.test(e.message));
});

test("credentials.json and tokens/ are enough on their own", () => {
  writeCredentials({ toolInstallationId: "claude_code:abc", apiBaseUrl: "https://api.example.test/" });
  writeToken("claude_code:abc", "tok-file");
  const config = loadShipConfig();
  assert.equal(config.toolInstallationId, "claude_code:abc");
  assert.equal(config.eventWriteToken, "tok-file");
  assert.equal(config.apiBaseUrl, "https://api.example.test");
});

test("env beats credentials, flags beat env", () => {
  writeCredentials({ toolInstallationId: "claude_code:from-creds" });
  writeToken("claude_code:from-creds", "t1");
  writeToken("claude_code:from-env", "t2");
  writeToken("claude_code:from-flag", "t3");
  process.env.ASCENDA_TOOL_INSTALLATION_ID = "from-env";
  assert.equal(loadShipConfig().toolInstallationId, "claude_code:from-env");
  assert.equal(loadShipConfig({ installationId: "claude_code:from-flag" }).eventWriteToken, "t3");
});

test("the env-only setup still works: id and token, no files", () => {
  process.env.ASCENDA_TOOL_INSTALLATION_ID = "abc";
  process.env.ASCENDA_EVENT_WRITE_TOKEN = "tok-env";
  const config = loadShipConfig();
  assert.equal(config.toolInstallationId, "claude_code:abc");
  assert.equal(config.eventWriteToken, "tok-env");
  assert.equal(config.tokenFilePath, undefined);
});

test("a lone codex pairing under tools.<host> is picked up", () => {
  writeCredentials({ tools: { codex: { toolInstallationId: "cli_agent:xyz" } } });
  writeToken("cli_agent:xyz", "tc");
  assert.equal(loadShipConfig().toolInstallationId, "cli_agent:xyz");
});

test("two candidates are refused rather than guessed", () => {
  writeToken("claude_code:one", "a");
  writeToken("claude_code:two", "b");
  assert.throws(() => loadShipConfig(), /--installation-id/);
});

test("an unpaired (local only) install says to pair", () => {
  writeCredentials({ localOnly: true, toolInstallationId: "claude_code:abc" });
  assert.throws(() => loadShipConfig(), /without pairing/);
});

test("a known id with no token says what is missing and the pair command", () => {
  writeCredentials({ toolInstallationId: "claude_code:abc" });
  assert.throws(() => loadShipConfig(), (e) => /No event write token for claude_code:abc/.test(e.message) && /pair/.test(e.message));
});

test("a token far from expiry is left alone", async () => {
  const now = Date.now();
  const file = writeToken("claude_code:abc", "t", now + 28 * DAY);
  let called = false;
  const { config, note } = await prepareToken(
    { apiBaseUrl: "x", toolInstallationId: "claude_code:abc", eventWriteToken: "t", tokenFilePath: file },
    { now: () => now, renew: async () => { called = true; } }
  );
  assert.equal(called, false);
  assert.equal(note, null);
  assert.equal(config.eventWriteToken, "t");
});

test("inside the window it renews and writes the new token where the hooks read it", async () => {
  const now = Date.now();
  const file = writeToken("claude_code:abc", "old", now + 5 * DAY);
  const newExpiry = new Date(now + 30 * DAY).toISOString();
  const seen = [];
  const { config, note } = await prepareToken(
    { apiBaseUrl: "https://api.example.test", toolInstallationId: "claude_code:abc", eventWriteToken: "old", tokenFilePath: file },
    { now: () => now, renew: async (base, token) => { seen.push([base, token]); return { eventWriteToken: "new", expiresAt: newExpiry }; } }
  );
  assert.deepEqual(seen, [["https://api.example.test", "old"]]);
  assert.equal(config.eventWriteToken, "new");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(home, "tokens", "expiry", "claude_code_abc"), "utf8"), newExpiry);
  assert.match(note, /renewed/);
});

test("an expired token stops with the pair command, never calls the server", async () => {
  const now = Date.now();
  const file = writeToken("claude_code:abc", "dead", now - DAY);
  let called = false;
  await assert.rejects(
    prepareToken(
      { apiBaseUrl: "x", toolInstallationId: "claude_code:abc", eventWriteToken: "dead", tokenFilePath: file },
      { now: () => now, renew: async () => { called = true; } }
    ),
    (e) => e instanceof ShipConfigError && /expired/.test(e.message) && /pair/.test(e.message) && !/\n\s+at /.test(e.message)
  );
  assert.equal(called, false);
});

test("a refused renewal adopts a token another process already rotated in", async () => {
  const now = Date.now();
  const file = writeToken("claude_code:abc", "old", now + 2 * DAY);
  fs.writeFileSync(file, "rotated-by-a-hook");
  const { config } = await prepareToken(
    { apiBaseUrl: "x", toolInstallationId: "claude_code:abc", eventWriteToken: "old", tokenFilePath: file },
    { now: () => now, renew: async () => null }
  );
  assert.equal(config.eventWriteToken, "rotated-by-a-hook");
});

test("a refused renewal with nothing newer on disk says to pair again", async () => {
  const now = Date.now();
  const file = writeToken("claude_code:abc", "old", now + 2 * DAY);
  await assert.rejects(
    prepareToken(
      { apiBaseUrl: "x", toolInstallationId: "claude_code:abc", eventWriteToken: "old", tokenFilePath: file },
      { now: () => now, renew: async () => null }
    ),
    /Pair again/
  );
});

test("an unreachable server doesn't block a token that is still valid", async () => {
  const now = Date.now();
  const file = writeToken("claude_code:abc", "old", now + 2 * DAY);
  const { config, note } = await prepareToken(
    { apiBaseUrl: "x", toolInstallationId: "claude_code:abc", eventWriteToken: "old", tokenFilePath: file },
    { now: () => now, renew: async () => { throw new Error("ECONNREFUSED"); } }
  );
  assert.equal(config.eventWriteToken, "old");
  assert.match(note, /unreachable/);
});
