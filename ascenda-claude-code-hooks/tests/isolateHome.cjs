// Imported first by every test file in this package, so it runs however the
// suite is started: npm test, a bare `node --test`, or one file on its own.
// A preload in the test script used to be the only thing doing this, and a
// bare `node --test` skipped it: the setup tests then ran `uninstall` against
// the developer's real ~/.ascenda and removed an installed hook.
// scripts/tests/testIsolation.test.mjs fails if a test file loses the import.
//
// Points HOME at a
// throwaway directory so anything that resolves ~/.ascenda — the machine
// salt, the work-context registry — reads and writes test state, never this
// machine's real identity files. Before this, every test that built a wire
// payload was silently exercising the developer's own salt; with the
// context registry recording labels as a side effect of payload building,
// that graduated from untidy to polluting.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-test-home-"));

// Every ASCENDA_ variable is cleared too. A developer's shell can export ones
// that name real files by absolute path, ASCENDA_EVENT_LOG_FILE most often, and
// those win over HOME. What the suite needs is set below; tests that need
// others set them.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("ASCENDA_")) delete process.env[key];
}

// Hosted Claude Code sessions set this, and it changes what the mapper stamps
// and whether the sender may rotate a token. Cleared so a suite run inside one
// sees the same defaults as a run on a laptop; tests that need it set it.
delete process.env.CLAUDE_CODE_REMOTE;

// A CI checkout has a github.com remote, so the repository key would appear on
// every event a test maps and change what a deep comparison sees. Off here, so
// a run in CI matches a run on a laptop; forgeKeys.test.mjs turns it on.
process.env.ASCENDA_REPO_KEYS = "off";

// Hooks deliver from a detached flusher by default. Most tests here read what
// one hook process sent before it exited, so they run the inline path; the
// background path has its own tests, which clear this.
process.env.ASCENDA_HOOK_DELIVERY = "inline";

// Setup writes user settings here when it's set, so it's cleared to keep them under HOME.
delete process.env.CLAUDE_CONFIG_DIR;

// A release-stamped bundle's flusher checks GitHub for a newer release. CI
// stamps the bundles these tests run, so the check is off here; releaseCheck
// has its own tests in tool-kit.
process.env.ASCENDA_DISABLE_UPDATE_CHECK = "true";
