const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AGENT_PROCESS, findAgentPid, findAgentProcess, livePidFields, psLookup, scriptMarkerIn } = require("../out/index.js");

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

test("a node process with no install path in its arguments is not named", () => {
  const t = table({ 300: [200, "/bin/sh"], 200: [100, "/opt/homebrew/bin/node"], 100: [1, "/bin/zsh"] });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...t }), undefined);
});

const NPM_CLAUDE_JS = "node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume";
const NPM_GEMINI =
  "/Users/me/.nvm/versions/node/v22.12.0/bin/node --max-old-space-size=8192 /Users/me/.nvm/versions/node/v22.12.0/lib/node_modules/@google/gemini-cli/bundle/gemini.js";

test("an npm Claude Code under node is named by its install path", () => {
  const t = table({
    300: [200, "/bin/sh"],
    200: [100, "/opt/homebrew/Cellar/node/24.1.0/bin/node", NPM_CLAUDE_JS],
    100: [1, "/bin/zsh"]
  });
  assert.deepEqual(findAgentProcess(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...t }), {
    pid: 200,
    match: "path",
    marker: "@anthropic-ai/claude-code"
  });
});

test("bun and deno count as runtimes too, and nothing else does", () => {
  for (const runtime of ["/Users/me/.bun/bin/bun", "/opt/homebrew/bin/deno"]) {
    const t = table({ 300: [200, "/bin/sh"], 200: [1, runtime, `${runtime} run /x/node_modules/@anthropic-ai/claude-code/cli.js`] });
    assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...t }), 200, runtime);
  }
  // A shell running the same script path is the hook's parent, not the agent.
  const sh = table({ 300: [200, "/bin/sh", "/bin/sh -c /x/node_modules/@anthropic-ai/claude-code/cli.js"], 200: [1, "/bin/zsh"] });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...sh }), undefined);
});

test("npm's native Claude Code binary is named by its executable", () => {
  const t = table({
    300: [200, "/bin/sh"],
    200: [1, "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"]
  });
  assert.deepEqual(findAgentProcess(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...t }), {
    pid: 200,
    match: "executable"
  });
});

test("the marker must sit between slashes", () => {
  assert.equal(scriptMarkerIn(NPM_CLAUDE_JS, ["@anthropic-ai/claude-code"]), "@anthropic-ai/claude-code");
  for (const args of [
    "node /x/node_modules/@ascenda-one/claude-code-hooks/out/cli.js",
    "node /x/ascenda-claude-code-hooks/out/cli.js",
    "node /x/node_modules/@anthropic-ai/claude-code-darwin-arm64/wrapper.js",
    "npm exec @anthropic-ai/claude-code"
  ]) {
    assert.equal(scriptMarkerIn(args, ["@anthropic-ai/claude-code"]), undefined, args);
  }
});

test("a node wrapper running something else is walked past", () => {
  // e.g. a task runner that started the agent.
  const t = table({
    400: [300, "/bin/sh"],
    300: [200, "/usr/local/bin/node", NPM_CLAUDE_JS],
    200: [100, "/usr/local/bin/node", "node /x/node_modules/.bin/concurrently claude"],
    100: [1, "/bin/zsh"]
  });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 400, platform: "darwin", ...t }), 300);

  const wrapperFirst = table({
    400: [300, "/bin/sh"],
    300: [200, "/usr/local/bin/node", "node /x/node_modules/.bin/concurrently claude"],
    200: [1, "/usr/local/bin/node", NPM_CLAUDE_JS]
  });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 400, platform: "darwin", ...wrapperFirst }), 200);
});

test("a runtime whose arguments can't be read is walked past, not named", () => {
  const t = {
    lookup: (pid) => ({ 300: { ppid: 200, command: "/bin/sh" }, 200: { ppid: 1, command: "/usr/local/bin/node" } })[pid],
    argsLookup: () => undefined
  };
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...t }), undefined);
});

test("the hook's own process is never a candidate", () => {
  const t = table({
    [process.pid]: [200, "/usr/local/bin/node", "node /x/node_modules/@anthropic-ai/claude-code/cli.js"],
    200: [1, "/bin/zsh"]
  });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: process.pid, platform: "darwin", ...t }), undefined);
});

test("Gemini CLI is named through its relaunched child, and not in ACP mode", () => {
  const t = table({
    400: [300, "/bin/sh"],
    300: [200, "/Users/me/.nvm/versions/node/v22.12.0/bin/node", NPM_GEMINI],
    200: [100, "/Users/me/.nvm/versions/node/v22.12.0/bin/node", NPM_GEMINI.replace(" --max-old-space-size=8192", "")],
    100: [1, "/bin/zsh"]
  });
  assert.deepEqual(findAgentProcess(AGENT_PROCESS.gemini_cli, { startPid: 400, platform: "darwin", ...t }), {
    pid: 300,
    match: "path",
    marker: "@google/gemini-cli"
  });

  const brew = table({
    300: [200, "/bin/sh"],
    200: [1, "/opt/homebrew/bin/node", "node /opt/homebrew/Cellar/gemini-cli/0.63.0/libexec/lib/node_modules/@google/gemini-cli/bundle/gemini.js"]
  });
  assert.equal(findAgentPid(AGENT_PROCESS.gemini_cli, { startPid: 300, platform: "darwin", ...brew }), 200);

  for (const flag of ["--acp", "--experimental-acp", "--acp=true"]) {
    const acp = table({ 300: [200, "/bin/sh"], 200: [1, "/opt/homebrew/bin/node", `${NPM_GEMINI} ${flag}`] });
    assert.equal(findAgentPid(AGENT_PROCESS.gemini_cli, { startPid: 300, platform: "darwin", ...acp }), undefined, flag);
  }

  // Gemini's rule doesn't name Claude Code, and the reverse.
  const claude = table({ 300: [200, "/bin/sh"], 200: [1, "/usr/local/bin/node", NPM_CLAUDE_JS] });
  assert.equal(findAgentPid(AGENT_PROCESS.gemini_cli, { startPid: 300, platform: "darwin", ...claude }), undefined);
  const gemini = table({ 300: [200, "/bin/sh"], 200: [1, "/usr/local/bin/node", NPM_GEMINI] });
  assert.equal(findAgentPid(AGENT_PROCESS.claude_code, { startPid: 300, platform: "darwin", ...gemini }), undefined);
});

test("multi-conversation hosts stay pid-less", () => {
  for (const tool of ["cursor", "windsurf", "cursor_mcp", "vscode_extension"]) {
    assert.equal(AGENT_PROCESS[tool], undefined, tool);
  }
});

test("livePidFields describes how the pid was found", () => {
  assert.deepEqual(livePidFields(undefined), {});
  assert.deepEqual(livePidFields({ pid: 7, match: "executable" }), { pid: 7 });
  assert.deepEqual(livePidFields({ pid: 7, match: "path", marker: "@google/gemini-cli" }), {
    pid: 7,
    pidMatch: "path",
    pidMarker: "@google/gemini-cli"
  });
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
