const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { findStaleHookCommands, isCliAgentManagementCommand, writeHookSettings } = require("../out/index.js");

// The settings write is the highest-blast-radius thing setup does: it edits a
// file the agent reads on every event. These pin the merge-don't-clobber
// rules against the two entry shapes in use — a flat { command } (Cursor,
// Windsurf) and Gemini's nested { hooks: [{ type, command }] } — so an
// adapter only has to prove its spec produces the shape its agent reads.

const BINARY = "/home/dev/.ascenda/bin/ascenda-flat-hook";

const flat = {
  host: "flat", displayName: "Flat", toolType: "cli_agent", packageName: "@ascenda-one/flat-hooks",
  binaryName: "ascenda-flat-hook", hookEvents: ["start", "stop"], restartHint: "",
  settings: {
    settingsPath: (scope, dir) => path.join(dir, "hooks.json"),
    scaffold: { version: 1 },
    entry: (command, event) => ({ command: `${command} ${event}` }),
    commandOf: (entry) => entry?.command
  }
};

const nested = {
  ...flat,
  host: "nested", binaryName: "ascenda-nested-hook",
  settings: {
    settingsPath: (scope, dir) => path.join(dir, "settings.json"),
    entry: (command) => ({ hooks: [{ type: "command", command, timeout: 5 }] }),
    commandOf: (entry) => entry?.hooks?.find((h) => typeof h?.command === "string")?.command
  }
};

function tempFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-setup-"));
  const file = path.join(dir, name);
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("registers every hook event in the spec's shape, with the scaffold on a new file", () => {
  const file = tempFile("hooks.json");
  assert.equal(writeHookSettings(file, BINARY, flat, false), true);
  const settings = read(file);
  assert.equal(settings.version, 1, "Cursor's file is versioned");
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["start", "stop"]);
  assert.match(settings.hooks.stop[0].command, /^".*node[^"]*" "\/home\/dev\/\.ascenda\/bin\/ascenda-flat-hook" stop$/);

  const nestedFile = tempFile("settings.json");
  writeHookSettings(nestedFile, "/x/ascenda-nested-hook", nested, false);
  const group = read(nestedFile).hooks.start[0];
  assert.equal(group.hooks[0].type, "command");
  assert.equal(group.hooks[0].timeout, 5);
  assert.match(group.hooks[0].command, /ascenda-nested-hook"$/, "one command serves every event when the name travels on stdin");
});

test("preserves unrelated settings and other people's hooks, foreign entry first", () => {
  const file = tempFile("hooks.json", JSON.stringify({
    version: 1, theme: "dark",
    hooks: { start: [{ command: "/usr/local/bin/my-own-guard" }], other: [{ command: "/usr/local/bin/cleanup" }] }
  }));
  writeHookSettings(file, BINARY, flat, false);
  const settings = read(file);
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.hooks.other, [{ command: "/usr/local/bin/cleanup" }]);
  assert.equal(settings.hooks.start.length, 2);
  assert.equal(settings.hooks.start[0].command, "/usr/local/bin/my-own-guard");
});

test("re-running replaces our entry instead of appending, and a moved binary is still ours", () => {
  const file = tempFile("hooks.json");
  writeHookSettings(file, BINARY, flat, false);
  assert.equal(writeHookSettings(file, BINARY, flat, false), false, "second run reports no change");
  assert.equal(read(file).hooks.stop.length, 1);
  assert.equal(writeHookSettings(file, "/elsewhere/ascenda-flat-hook", flat, false), true);
  assert.equal(read(file).hooks.stop.length, 1);
  assert.match(read(file).hooks.stop[0].command, /\/elsewhere\//);
});

test("backs up before the first write, refuses what it cannot parse, and a dry run writes nothing", () => {
  const original = JSON.stringify({ version: 1 });
  const file = tempFile("hooks.json", original);
  writeHookSettings(file, BINARY, flat, false);
  assert.equal(fs.readFileSync(`${file}.ascenda-backup`, "utf8"), original);

  const corrupt = tempFile("hooks.json", '{ "hooks": { unclosed');
  assert.equal(writeHookSettings(corrupt, BINARY, flat, false), null);
  assert.equal(fs.readFileSync(corrupt, "utf8"), '{ "hooks": { unclosed');

  const dry = tempFile("hooks.json");
  assert.equal(writeHookSettings(dry, BINARY, flat, true), true);
  assert.equal(fs.existsSync(dry), false);

  const empty = tempFile("hooks.json", "  \n");
  assert.equal(writeHookSettings(empty, BINARY, flat, false), true, "an empty file is no settings, not corruption");
});

test("stale ascenda-looking commands are named once each; a healthy install reports none", () => {
  const settings = {
    hooks: {
      start: [{ command: "/old/.ascenda/hook.sh start" }, { command: `"/usr/bin/node" "${BINARY}" start` }],
      stop: [{ command: "/old/.ascenda/hook.sh start" }, { command: "/usr/local/bin/my-own-guard" }]
    }
  };
  assert.deepEqual(findStaleHookCommands(settings, BINARY, flat), ["/old/.ascenda/hook.sh start"]);
  const file = tempFile("hooks.json");
  writeHookSettings(file, BINARY, flat, false);
  assert.deepEqual(findStaleHookCommands(read(file), BINARY, flat), []);
});

test("management words are recognised; hook names are not", () => {
  for (const word of ["setup", "install", "status", "uninstall", "--help", "-h"]) assert.ok(isCliAgentManagementCommand(word), word);
  for (const word of ["stop", "Stop", "sessionStart", "post_cascade_response", "SessionStart", undefined]) assert.equal(isCliAgentManagementCommand(word), false, String(word));
});
