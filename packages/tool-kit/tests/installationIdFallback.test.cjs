const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  defaultTokenFilePath,
  listPersistedToolInstallationIds,
  persistEventWriteToken,
  readCollectorState,
  recordSendOutcome,
  unresolvedStateFilePath,
  unresolvedToolInstallationId
} = require("../out/index.js");

// The fallback for issue #48: a GUI-launched editor never sees a shell rc
// file, so the installation id has to be recoverable from the token store,
// where it is the filename. Each test gets its own ASCENDA_HOME so nothing
// here can read or write the developer's real ~/.ascenda.

function withHome(run) {
  const previous = process.env.ASCENDA_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-home-"));
  process.env.ASCENDA_HOME = home;
  try {
    return run(home);
  } finally {
    if (previous === undefined) delete process.env.ASCENDA_HOME;
    else process.env.ASCENDA_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("exactly one token file: the id is the filename with the ':' put back", () => {
  withHome(() => {
    persistEventWriteToken(defaultTokenFilePath("claude_code:0d7b1e2a-5f3c-4a8e-9b1d-2c3e4f5a6b7c"), "tok_a");
    assert.deepEqual(
      listPersistedToolInstallationIds("claude_code"),
      ["claude_code:0d7b1e2a-5f3c-4a8e-9b1d-2c3e4f5a6b7c"]
    );
  });
});

test("no token directory, or no matching file, is an empty list rather than an error", () => {
  withHome((home) => {
    assert.deepEqual(listPersistedToolInstallationIds("claude_code"), [], "tokens/ does not exist yet");
    fs.mkdirSync(path.join(home, "tokens"), { recursive: true });
    assert.deepEqual(listPersistedToolInstallationIds("claude_code"), [], "tokens/ is empty");
  });
});

test("several token files of the tool type are all reported, sorted, so the caller can refuse to guess", () => {
  withHome(() => {
    persistEventWriteToken(defaultTokenFilePath("claude_code:bbb"), "tok_b");
    persistEventWriteToken(defaultTokenFilePath("claude_code:aaa"), "tok_a");
    assert.deepEqual(listPersistedToolInstallationIds("claude_code"), ["claude_code:aaa", "claude_code:bbb"]);
  });
});

test("other tool types, empty tokens, and stray entries do not count as candidates", () => {
  withHome((home) => {
    persistEventWriteToken(defaultTokenFilePath("claude_code:real"), "tok_real");
    // The Codex adapter pairs under its own type in the same directory.
    persistEventWriteToken(defaultTokenFilePath("cli_agent:other"), "tok_other");
    // An empty token could not be used to send even if it were chosen.
    fs.writeFileSync(defaultTokenFilePath("claude_code:empty"), "  \n");
    // A bare prefix names nothing; a directory is not a token.
    fs.writeFileSync(path.join(home, "tokens", "claude_code_"), "tok_nameless");
    fs.mkdirSync(path.join(home, "tokens", "claude_code_dir"));

    assert.deepEqual(listPersistedToolInstallationIds("claude_code"), ["claude_code:real"]);
    assert.deepEqual(listPersistedToolInstallationIds("cli_agent"), ["cli_agent:other"]);
  });
});

test("a skipped send is journalled under the tool type's placeholder id, with no installation id needed", () => {
  const previous = process.env.ASCENDA_STATE_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-state-dir-"));
  process.env.ASCENDA_STATE_DIR = dir;
  try {
    const file = unresolvedStateFilePath("claude_code");
    assert.equal(file, path.join(dir, "claude_code_unresolved.json"));

    const first = recordSendOutcome(file, unresolvedToolInstallationId("claude_code"), "skipped_no_installation_id", {
      detail: "no ASCENDA_TOOL_INSTALLATION_ID"
    });
    const second = recordSendOutcome(file, unresolvedToolInstallationId("claude_code"), "skipped_no_installation_id");

    assert.equal(second.lastOutcome, "skipped_no_installation_id");
    assert.equal(second.toolInstallationId, "claude_code:unresolved");
    assert.equal(second.consecutiveFailures, 2, "counts how many attempts were skipped");
    assert.equal(second.failingSince, first.failingSince, "and since when");
    assert.equal(second.lastSuccessAt, undefined, "a skip is never a success");
    // JSON drops the explicit `lastSuccessAt: undefined`; compare what disk can hold.
    assert.deepEqual(readCollectorState(file), JSON.parse(JSON.stringify(second)), "round-trips through disk");
  } finally {
    if (previous === undefined) delete process.env.ASCENDA_STATE_DIR;
    else process.env.ASCENDA_STATE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
