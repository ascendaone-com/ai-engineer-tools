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

// The store paths answer to these too, so a developer who sets either would
// otherwise run the suite against their own stores.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.ASCENDA_ZSTD_DECODER;
