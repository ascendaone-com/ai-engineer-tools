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

test("every source the contract declares is recognised as a paired identity", () => {
  // The regression this pins: `KNOWN_SOURCES` was a second copy of the
  // contract's list, restated by hand in host.ts, and it had drifted by one --
  // `code_forge` was absent, so an install paired under it fell through to live
  // host detection and reported the editor it was running in instead of the
  // identity it paired as. Neither the type nor the test above could see it:
  // `readonly AscendaTelemetrySource[]` accepts a subset of the union, and the
  // old test named two prefixes by hand rather than enumerating the contract.
  //
  // So this test enumerates. It cannot go stale when a source is added,
  // because the contract is the loop, not the fixture.
  const { ASCENDA_TELEMETRY_SOURCES } = require("@ascenda-one/tool-contract");
  const host = hostFor("Visual Studio Code", "vscode");

  assert.ok(ASCENDA_TELEMETRY_SOURCES.length > 0, "contract declares no sources");
  for (const source of ASCENDA_TELEMETRY_SOURCES) {
    assert.equal(
      host.resolveTelemetrySource(`${source}:install-abc`),
      source,
      `${source} is declared by the contract but not recognised as a paired identity`
    );
  }
});

test("an unknown prefix still falls back to live detection", () => {
  // The complement of the test above: recognising every declared source must
  // not mean recognising everything. A prefix the contract does not declare is
  // not a source, and guessing one onto the wire is worse than falling back.
  const host = hostFor("Cursor", "cursor");
  assert.equal(host.resolveTelemetrySource("not_a_source:install-abc"), "cursor_mcp");
  assert.equal(host.resolveTelemetrySource(undefined), "cursor_mcp");
});
