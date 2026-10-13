const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ASCENDA_HOME is read when paths are resolved, so each test points it at its own directory.
const { hookRunnerCommand, hookRunnerPaths, installHookRunner, isDowngrade } = require("../out/index.js");

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-runner-"));
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

const OPTIONS = { binaryName: "ascenda-test-hook", setupCommand: "npx test setup", dryRun: false };

test("isDowngrade orders releases and never blocks on a version it can't read", () => {
  assert.equal(isDowngrade("v0.1.40", "v0.1.35"), true);
  assert.equal(isDowngrade("0.2.0", "0.1.99"), true);
  assert.equal(isDowngrade("v0.1.35", "v0.1.35"), false);
  assert.equal(isDowngrade("v0.1.35", "v0.1.40"), false);
  assert.equal(isDowngrade("v0.1.35-rc.1", "v0.1.35"), false);
  assert.equal(isDowngrade(undefined, "v0.1.35"), false);
  assert.equal(isDowngrade("v0.1.40", "unreleased"), false, "a checkout build replaces a release");
  assert.equal(isDowngrade("unreleased", "v0.1.35"), false);
});

test("an older setup leaves a newer bundle in place", { skip: process.platform === "win32" }, () => {
  withHome(() => {
    const paths = hookRunnerPaths(OPTIONS.binaryName);
    const source = path.join(os.tmpdir(), `ascenda-source-${process.pid}.mjs`);
    fs.writeFileSync(source, "// newer\n");
    installHookRunner({ ...OPTIONS, source, version: "v0.1.40" });
    assert.equal(fs.readFileSync(paths.version, "utf8").trim(), "v0.1.40");

    fs.writeFileSync(source, "// older\n");
    const kept = [];
    const launcher = installHookRunner({ ...OPTIONS, source, version: "v0.1.35", onKeptNewer: (installed, incoming) => kept.push([installed, incoming]) });

    assert.equal(launcher, paths.launcher, "the hooks file still names the launcher");
    assert.deepEqual(kept, [["v0.1.40", "v0.1.35"]]);
    assert.equal(fs.readFileSync(paths.bundle, "utf8"), "// newer\n");
    assert.equal(fs.readFileSync(paths.version, "utf8").trim(), "v0.1.40");
    fs.rmSync(source);
  });
});

test("the same or a newer release replaces the bundle and records its version", { skip: process.platform === "win32" }, () => {
  withHome(() => {
    const paths = hookRunnerPaths(OPTIONS.binaryName);
    const source = path.join(os.tmpdir(), `ascenda-source-${process.pid}.mjs`);
    fs.writeFileSync(source, "// one\n");
    installHookRunner({ ...OPTIONS, source, version: "v0.1.35" });
    fs.writeFileSync(source, "// two\n");
    installHookRunner({ ...OPTIONS, source, version: "v0.1.36" });
    assert.equal(fs.readFileSync(paths.bundle, "utf8"), "// two\n");
    assert.equal(fs.readFileSync(paths.version, "utf8").trim(), "v0.1.36");
    // An install from before versions were recorded has nothing to compare against.
    fs.rmSync(paths.version);
    fs.writeFileSync(source, "// three\n");
    installHookRunner({ ...OPTIONS, source, version: "v0.1.30" });
    assert.equal(fs.readFileSync(paths.bundle, "utf8"), "// three\n");
    fs.rmSync(source);
  });
});

// cmd.exe's /c rule: a line that starts with a quote and holds more than two
// has its first quote and its last quote removed before it is run.
function afterCmdStripsQuotes(line) {
  const quotes = (line.match(/"/g) ?? []).length;
  if (!line.startsWith('"') || quotes === 2) return line;
  const last = line.lastIndexOf('"');
  return line.slice(1, last) + line.slice(last + 1);
}

test("the Windows hook command is the Node and the launcher, each quoted, then the event", () => {
  const command = `${hookRunnerCommand("C:\\Users\\Jo Doe\\.ascenda\\bin\\ascenda-codex-hook", "win32")} PreToolUse`;
  assert.equal(command, `"${process.execPath}" "C:\\Users\\Jo Doe\\.ascenda\\bin\\ascenda-codex-hook" PreToolUse`);
  assert.equal(hookRunnerCommand("/home/dev/.ascenda/bin/x", "linux"), '"/home/dev/.ascenda/bin/x"');
});

test("the Windows command survives a runner that wraps the line in quotes, and the rule that breaks a bare one is pinned", () => {
  const command = `${hookRunnerCommand("C:\\Users\\Jo Doe\\.ascenda\\bin\\ascenda-codex-hook", "win32")} Stop`;
  // Codex runs `cmd /C "<line>"`, which is the safe shape, and so does Node's
  // shell spawn (`/d /s /c "<line>"`). Both leave the command as built.
  assert.equal(afterCmdStripsQuotes(`"${command}"`), command);
  // Handed to cmd bare, four quotes lose the first and last, which is why a
  // runner that doesn't wrap would run a mangled path.
  assert.notEqual(afterCmdStripsQuotes(command), command);
});
