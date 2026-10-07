const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AGENT_PROCESS, findAgentPid, psLookup } = require("../out/index.js");

/** A fake process table: pid → [ppid, executable, args?]. */
function table(rows) {
  return {
    lookup: (pid) => (rows[pid] ? { ppid: rows[pid][0], command: rows[pid][1] } : undefined),
    argsLookup: (pid) => rows[pid]?.[2] ?? rows[pid]?.[1]
  };
}

const DESKTOP_CLAUDE =
  "/Users/me/Library/Application Support/Claude/claude-code/2.1.293/8433d0d9cd0d/claude.app/Contents/MacOS/claude";
const NATIVE_CLAUDE = "/Users/me/.local/share/claude/versions/2.1.293";

test("walks past the hook's shell to the claude process", () => {
  const t = table({
    300: [200, "/bin/sh"],
    200: [100, DESKTOP_CLAUDE],
    100: [1, "/Applications/Claude.app/Contents/MacOS/Claude"]
  });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...t }), 200);
});

test("the native installer's versioned binary counts as claude", () => {
  const t = table({ 300: [200, "/bin/zsh"], 200: [1, NATIVE_CLAUDE] });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...t }), 200);
});

test("the hook's own command line mentioning claude is not a match", () => {
  // `grep claude` on the args would stop here, at the hook's parent shell.
  const t = table({
    300: [200, "/bin/sh", "/bin/sh -c node /x/ascenda-claude-code-hooks/out/cli.js PreToolUse"],
    200: [100, "/usr/local/bin/node", "node /x/ascenda-claude-code-hooks/out/cli.js"],
    100: [1, "/bin/zsh"]
  });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...t }), undefined);
});

test("an npm install running under node is not named", () => {
  const t = table({ 300: [200, "/bin/sh"], 200: [100, "/opt/homebrew/bin/node"], 100: [1, "/bin/zsh"] });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...t }), undefined);
});

test("the nearest claude wins when one runs inside another's shell", () => {
  const t = table({
    400: [300, "/bin/sh"],
    300: [250, NATIVE_CLAUDE],
    250: [200, "/bin/zsh"],
    200: [1, DESKTOP_CLAUDE]
  });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 400, platform: "darwin", ...t }), 300);
});

test("codex's TUI is named and its app-server is not", () => {
  const tui = table({ 300: [200, "/bin/sh"], 200: [1, "/opt/homebrew/bin/codex", "codex --model o4"] });
  assert.equal(findAgentPid(AGENT_PROCESS.codex, { startPid: 300, platform: "darwin", ...tui }), 200);

  const brew = table({ 300: [200, "/bin/sh"], 200: [1, "/opt/homebrew/Caskroom/codex/0.50.0/codex-aarch64-apple-darwin", "codex"] });
  assert.equal(findAgentPid(AGENT_PROCESS.codex, { startPid: 300, platform: "darwin", ...brew }), 200);

  const sandbox = table({ 300: [200, "/bin/sh"], 200: [1, "/x/codex-linux-sandbox", "codex-linux-sandbox"] });
  assert.equal(findAgentPid(AGENT_PROCESS.codex, { startPid: 300, platform: "darwin", ...sandbox }), undefined);

  const server = table({
    300: [200, "/bin/sh"],
    200: [100, "/x/bin/macos-aarch64/codex", "/x/bin/macos-aarch64/codex -c features.y=true app-server --analytics"],
    100: [1, "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"]
  });
  assert.equal(findAgentPid(AGENT_PROCESS.codex, { startPid: 300, platform: "darwin", ...server }), undefined);
});

test("codex with unreadable arguments is not named", () => {
  const t = {
    lookup: (pid) => (pid === 200 ? { ppid: 1, command: "/opt/homebrew/bin/codex" } : { ppid: 200, command: "/bin/sh" }),
    argsLookup: () => undefined
  };
  assert.equal(findAgentPid(AGENT_PROCESS.codex, { startPid: 300, platform: "darwin", ...t }), undefined);
});

test("a vanished ancestor, a deep tree, another platform or no rule all give nothing", () => {
  const gone = table({ 300: [200, "/bin/sh"] });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...gone }), undefined);

  const rows = {};
  for (let pid = 20; pid > 2; pid--) rows[pid] = [pid - 1, "/bin/sh"];
  rows[2] = [1, DESKTOP_CLAUDE];
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 20, platform: "darwin", ...table(rows) }), undefined);

  const near = table({ 300: [200, "/bin/sh"], 200: [1, DESKTOP_CLAUDE] });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 300, platform: "linux", ...near }), undefined);
  assert.equal(findAgentPid(AGENT_PROCESS.cursor, { startPid: 300, platform: "darwin", ...near }), undefined);
});

test("psLookup reads a real process, path and all", { skip: process.platform !== "darwin" }, () => {
  const self = psLookup(process.pid);
  assert.equal(self.ppid, process.ppid);
  assert.match(self.command, /node/);
  assert.equal(psLookup(2 ** 22 + 12345), undefined);
});
