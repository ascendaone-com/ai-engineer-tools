import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `pair` is the one path that runs before anything is configured, so it is
// also the one that decides what identity everything after it uses. Both
// tests below are regressions: the guide for Codex sent people here with
// --tool-type cli_agent, and on a machine where Claude Code was already
// paired the exported id won, so a second tool inherited the first one's
// identity and its events were filed under it.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

/** The two endpoints `pair` touches, confirming immediately. */
async function pairingServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/tool-pairing-sessions") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pairingSessionId: "sess_1", code: "123456", expiresAt: new Date(Date.now() + 600_000).toISOString() }));
      });
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/v1/tool-pairing-sessions/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "paired", toolInstallationId: seen.at(-1)?.toolInstallationId, eventWriteToken: "tok_test" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

// Async, not spawnSync: the stub server runs in this process, so blocking
// the event loop would deadlock the poll it is waiting to answer.
function runPair(url, home, env = {}) {
  const child = spawn("node", [CLI, "pair", ...(env.args ?? [])], {
    env: { ...process.env, HOME: home, ASCENDA_HOME: home, ASCENDA_API_BASE_URL: url, ASCENDA_TOOL_INSTALLATION_ID: env.exported ?? "" }
  });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  return new Promise((resolve) => {
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("pairing writes the credentials file, so no shell export is needed", async () => {
  const { server, url } = await pairingServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-pair-"));
  const result = await runPair(url, home);
  server.close();

  assert.equal(result.status, 0, result.stderr);
  const credentials = JSON.parse(fs.readFileSync(path.join(home, "credentials.json"), "utf8"));
  assert.match(credentials.toolInstallationId, /^claude_code:/);
  assert.equal(credentials.apiBaseUrl, url);
  // Claude Code spawns hooks with whatever environment it was launched from;
  // from the Dock that is empty, and an export in a shell profile is never
  // read. Asking for one also puts a per-machine variable in the way of the
  // next tool that pairs.
  assert.doesNotMatch(result.stdout, /export ASCENDA_TOOL_INSTALLATION_ID/);
  assert.match(result.stdout, /Nothing to add to your shell profile/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("an explicit --tool-type mints its own id rather than inheriting an exported one", async () => {
  const { server, seen, url } = await pairingServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-pair-type-"));
  const result = await runPair(url, home, { exported: "claude_code:already-paired", args: ["--tool-type", "cli_agent"] });
  server.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(seen.at(-1).toolType, "cli_agent");
  assert.match(seen.at(-1).toolInstallationId, /^cli_agent:/, "a differently-typed pairing is a second tool, not a re-pair");
  assert.notEqual(seen.at(-1).toolInstallationId, "claude_code:already-paired");
  fs.rmSync(home, { recursive: true, force: true });
});

test("re-pairing the same type still heals the existing identity instead of forking it", async () => {
  const { server, seen, url } = await pairingServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-pair-heal-"));
  const result = await runPair(url, home, { exported: "claude_code:keep-me", args: ["--tool-type", "claude_code"] });
  server.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(seen.at(-1).toolInstallationId, "claude_code:keep-me", "a second id for the same tool splits its history in two");
  fs.rmSync(home, { recursive: true, force: true });
});

test("with no flag at all, an exported id is still reused", async () => {
  const { server, seen, url } = await pairingServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-pair-plain-"));
  const result = await runPair(url, home, { exported: "claude_code:keep-me" });
  server.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(seen.at(-1).toolInstallationId, "claude_code:keep-me");
  fs.rmSync(home, { recursive: true, force: true });
});
