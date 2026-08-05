import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * `vscode` only exists inside an extension host, so it is stubbed. The strings
 * below are the real `env.appName` / `env.uriScheme` each editor reports —
 * Antigravity's come from its product.json (`nameShort`, `urlProtocol`).
 */
function hostFor(appName, uriScheme) {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return { env: { appName, uriScheme } };
    return original.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes("ide-extension-core")) delete require.cache[key];
    }
    return require("../out/host.js");
  } finally {
    Module._load = original;
  }
}

test("Antigravity is recognised rather than falling through to unknown", () => {
  const host = hostFor("Antigravity IDE", "antigravity-ide");
  assert.equal(host.detectHostKind(), "antigravity");
  assert.equal(host.getHostDisplayName(), "Antigravity");
});

test("Antigravity reports the vscode_extension source, because the catalog has no other", () => {
  const host = hostFor("Antigravity IDE", "antigravity-ide");
  // Minting a new source is a backend contract change; until then `host`
  // metadata is the only thing separating a fork from stock VS Code.
  assert.equal(host.getToolType(), "vscode_extension");
  assert.equal(host.getTelemetrySource(), "vscode_extension");
});

test("stock VS Code and Cursor are unaffected by the fork check", () => {
  const code = hostFor("Visual Studio Code", "vscode");
  assert.equal(code.detectHostKind(), "vscode");
  assert.equal(code.getTelemetrySource(), "vscode_extension");

  const cursor = hostFor("Cursor", "cursor");
  assert.equal(cursor.detectHostKind(), "cursor");
  assert.equal(cursor.getTelemetrySource(), "cursor_mcp");
});

test("an unrecognised fork still names itself rather than reporting 'Editor'", () => {
  const host = hostFor("Some Other Fork", "weird");
  assert.equal(host.detectHostKind(), "unknown");
  assert.equal(host.getHostDisplayName(), "Some Other Fork");
});

test("source stays pinned to the identity an install paired under", () => {
  // An install paired as vscode_extension that is later opened in Cursor must
  // not silently flip its reported source mid-stream.
  const host = hostFor("Cursor", "cursor");
  assert.equal(host.resolveTelemetrySource("vscode_extension:abc-123"), "vscode_extension");
  assert.equal(host.resolveTelemetrySource("nonsense-prefix"), "cursor_mcp", "falls back to live detection");
});
