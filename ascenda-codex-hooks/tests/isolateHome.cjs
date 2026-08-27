// Preloaded by the test script (node --test --require). Points HOME at a
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
