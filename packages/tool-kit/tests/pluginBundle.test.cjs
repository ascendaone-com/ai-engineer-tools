const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ASCENDA_HOME is read when paths are resolved, so each test points it at its own directory.
const { describePluginBundleOutcome, installPluginBundle, pluginBundlePaths } = require("../out/index.js");

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-plugin-"));
  const previous = process.env.ASCENDA_HOME;
  process.env.ASCENDA_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.ASCENDA_HOME;
    else process.env.ASCENDA_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function source(home, contents) {
  const file = path.join(home, `source-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, contents);
  return file;
}

test("the bundle lives under ~/.ascenda/plugin, apart from setup's bin", () => {
  withHome((home) => {
    const paths = pluginBundlePaths("claude-code-hooks");
    assert.equal(paths.bundle, path.join(home, "plugin", "claude-code-hooks.mjs"));
    assert.equal(paths.version, path.join(home, "plugin", "claude-code-hooks.version"));
    assert.equal(paths.checked, path.join(home, "plugin", "claude-code-hooks.checked"));
  });
});

test("installs the running bundle and records its release", () => {
  withHome((home) => {
    const outcome = installPluginBundle({ name: "claude-code-hooks", source: source(home, "// v0.1.36\n"), version: "0.1.36" });
    const paths = pluginBundlePaths("claude-code-hooks");
    assert.deepEqual(outcome, { kind: "installed", version: "0.1.36" });
    assert.equal(fs.readFileSync(paths.bundle, "utf8"), "// v0.1.36\n");
    assert.equal(fs.readFileSync(paths.version, "utf8"), "0.1.36\n");
  });
});

test("a newer release replaces the bundle, and the same one leaves it alone", () => {
  withHome((home) => {
    installPluginBundle({ name: "agent-mcp", source: source(home, "// old\n"), version: "0.1.35" });
    const same = installPluginBundle({ name: "agent-mcp", source: source(home, "// old\n"), version: "0.1.35" });
    assert.deepEqual(same, { kind: "current", version: "0.1.35" });

    const newer = installPluginBundle({ name: "agent-mcp", source: source(home, "// new\n"), version: "0.1.36" });
    assert.deepEqual(newer, { kind: "installed", version: "0.1.36", replaced: "0.1.35" });
    assert.equal(fs.readFileSync(pluginBundlePaths("agent-mcp").bundle, "utf8"), "// new\n");
  });
});

test("an older release keeps the newer bundle", () => {
  withHome((home) => {
    installPluginBundle({ name: "claude-code-hooks", source: source(home, "// new\n"), version: "0.1.36" });
    const outcome = installPluginBundle({ name: "claude-code-hooks", source: source(home, "// old\n"), version: "0.1.33" });
    assert.deepEqual(outcome, { kind: "kept-newer", installed: "0.1.36", incoming: "0.1.33" });
    assert.equal(fs.readFileSync(pluginBundlePaths("claude-code-hooks").bundle, "utf8"), "// new\n");
  });
});

test("a damaged copy of the same release is replaced", () => {
  withHome((home) => {
    installPluginBundle({ name: "claude-code-hooks", source: source(home, "// good\n"), version: "0.1.36" });
    fs.writeFileSync(pluginBundlePaths("claude-code-hooks").bundle, "// trunc");
    const outcome = installPluginBundle({ name: "claude-code-hooks", source: source(home, "// good\n"), version: "0.1.36" });
    assert.equal(outcome.kind, "installed");
    assert.equal(fs.readFileSync(pluginBundlePaths("claude-code-hooks").bundle, "utf8"), "// good\n");
  });
});

test("run from the installed bundle, it doesn't copy onto itself", () => {
  withHome((home) => {
    installPluginBundle({ name: "claude-code-hooks", source: source(home, "// v0.1.36\n"), version: "0.1.36" });
    const { bundle } = pluginBundlePaths("claude-code-hooks");
    const outcome = installPluginBundle({ name: "claude-code-hooks", source: bundle, version: "0.1.36" });
    assert.deepEqual(outcome, { kind: "current", version: "0.1.36" });
    assert.equal(fs.readFileSync(bundle, "utf8"), "// v0.1.36\n");
  });
});

test("each outcome reads as one line", () => {
  assert.equal(describePluginBundleOutcome({ kind: "installed", version: "0.1.36" }, "/b"), "Installed the plugin's bundle (0.1.36): /b");
  assert.equal(describePluginBundleOutcome({ kind: "installed", version: "0.1.36", replaced: "0.1.35" }, "/b"), "Updated the plugin's bundle from 0.1.35 to 0.1.36: /b");
  assert.equal(describePluginBundleOutcome({ kind: "current", version: "0.1.36" }, "/b"), "The plugin's bundle is already 0.1.36: /b");
  assert.equal(describePluginBundleOutcome({ kind: "kept-newer", installed: "0.1.36", incoming: "0.1.33" }, "/b"), "Kept the plugin's bundle at 0.1.36. This copy is the older 0.1.33.");
});
