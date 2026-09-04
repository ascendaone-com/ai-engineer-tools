const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  credentialsFilePath,
  readHostCredentials,
  readMachineCredentials,
  removeHostCredentials,
  writeHostCredentials,
  writeTopLevelCredentials
} = require("../out/index.js");

// One credentials file, five setups. Claude Code's pairing is the top level;
// every CLI agent lives under tools.<host>. Each writer must leave the others
// exactly as it found them, or the last setup to run silently unpairs the rest.

function withHome(run) {
  const previous = process.env.ASCENDA_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-creds-"));
  process.env.ASCENDA_HOME = home;
  try {
    return run(home);
  } finally {
    if (previous === undefined) delete process.env.ASCENDA_HOME;
    else process.env.ASCENDA_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("host entries and the top level survive each other's writes", () => {
  withHome(() => {
    writeTopLevelCredentials({ apiBaseUrl: "http://localhost:4477", toolInstallationId: "claude_code:abc" });
    writeHostCredentials("cursor", { apiBaseUrl: "http://localhost:4477", toolInstallationId: "cli_agent:cu" });
    writeHostCredentials("gemini_cli", { toolInstallationId: "cli_agent:gm" });
    // A later Claude Code setup rewrites the top level only.
    writeTopLevelCredentials({ apiBaseUrl: "https://api.ascenda.one", toolInstallationId: "claude_code:def" });

    assert.deepEqual(readMachineCredentials(), {
      apiBaseUrl: "https://api.ascenda.one",
      toolInstallationId: "claude_code:def",
      tools: {
        cursor: { apiBaseUrl: "http://localhost:4477", toolInstallationId: "cli_agent:cu" },
        gemini_cli: { toolInstallationId: "cli_agent:gm" }
      }
    });
    assert.equal(readHostCredentials("cursor").toolInstallationId, "cli_agent:cu");
    assert.equal(readHostCredentials("windsurf"), undefined);
    if (process.platform !== "win32") assert.equal(fs.statSync(credentialsFilePath()).mode & 0o777, 0o600);
  });
});

test("removing one host leaves the rest, and drops the section when it empties", () => {
  withHome(() => {
    writeTopLevelCredentials({ toolInstallationId: "claude_code:abc" });
    writeHostCredentials("cursor", { toolInstallationId: "cli_agent:cu" });
    writeHostCredentials("windsurf", { toolInstallationId: "cli_agent:ws" });

    removeHostCredentials("cursor");
    assert.deepEqual(readMachineCredentials().tools, { windsurf: { toolInstallationId: "cli_agent:ws" } });
    removeHostCredentials("windsurf");
    assert.deepEqual(readMachineCredentials(), { toolInstallationId: "claude_code:abc" });
    removeHostCredentials("never-there");
  });
});

test("a malformed file reads as unconfigured, and a host entry of the wrong shape as absent", () => {
  withHome(() => {
    fs.mkdirSync(path.dirname(credentialsFilePath()), { recursive: true });
    fs.writeFileSync(credentialsFilePath(), "{ not json");
    assert.equal(readMachineCredentials(), undefined);
    assert.equal(readHostCredentials("cursor"), undefined);
    fs.writeFileSync(credentialsFilePath(), JSON.stringify({ tools: { cursor: "cli_agent:cu" } }));
    assert.equal(readHostCredentials("cursor"), undefined);
  });
});
