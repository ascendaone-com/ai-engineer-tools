// Imported first by every test file in this package, so it runs however the
// suite is started: npm test, a bare `node --test`, or one file on its own.
// A preload in the test script used to be the only thing doing this, and a
// bare `node --test` skipped it: the setup tests then ran `uninstall` against
// the developer's real ~/.ascenda and removed an installed hook.
// scripts/tests/testIsolation.test.mjs fails if a test file loses the import.
//
// Points HOME at a
// throwaway directory so anything that resolves ~/.ascenda — the machine
// salt, the turn-timing state this adapter writes on UserPromptSubmit — reads
// and writes test state, never this machine's real identity files. The mapper
// tests below are pure, but the package's own CLI is not, and a test that
// grows into calling it should not silently start writing to a developer's
// real home. Same file, same reason, as ascenda-claude-code-hooks.
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

// Codex reads its user files from here when it is set, and so does setup.
// Cleared so a run on a machine that sets it still writes under the
// throwaway HOME; tests that need it set it.
delete process.env.CODEX_HOME;

// Hooks deliver from a detached flusher by default. Tests that read what one
// hook process sent before it exited run the inline path.
process.env.ASCENDA_HOOK_DELIVERY = "inline";

// A release-stamped bundle's flusher checks GitHub for a newer release. CI
// stamps the bundles these tests run, so the check is off here; releaseCheck
// has its own tests in tool-kit.
process.env.ASCENDA_DISABLE_UPDATE_CHECK = "true";
