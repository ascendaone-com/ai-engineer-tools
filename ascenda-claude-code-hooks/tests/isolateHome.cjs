// Preloaded by the test script (node --test --require). Points HOME at a
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

// Hosted Claude Code sessions set this, and it changes what the mapper stamps
// and whether the sender may rotate a token. Cleared so a suite run inside one
// sees the same defaults as a run on a laptop; tests that need it set it.
delete process.env.CLAUDE_CODE_REMOTE;
