import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { writeSettings, findStaleHookCommands } = await import("../dist/setup.js");

const BINARY = "/home/dev/.ascenda/bin/ascenda-claude-hook";
// Written out rather than imported from setup.js: this is the independent
// statement of what should be registered, so a change to the source list has
// to be a deliberate change here too. SessionStart earns its place twice —
// it maps to create_focus_session, and it is the hook that carries the
// intention invite.
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact", "Stop", "Notification", "SessionEnd"];

function tempSettings(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-settings-"));
  const file = path.join(dir, "settings.local.json");
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("registers every hook event, and none we do not map", () => {
  const file = tempSettings();
  assert.equal(writeSettings(file, BINARY, false), true);

  const { hooks } = read(file);
  assert.deepEqual(Object.keys(hooks).sort(), [...EVENTS].sort());
  // Notification is registered now that it maps to supervision_interruption —
  // the agent stopping to wait on the person. It was absent for as long as it
  // mapped to nothing, and the two halves moved together.
  assert.ok(hooks.Notification, "Notification must be registered or the interruption count is silently zero");
  assert.match(hooks.Notification[0].hooks[0].command, /ascenda-claude-hook" Notification$/);
  assert.match(hooks.PostToolUse[0].hooks[0].command, /ascenda-claude-hook" PostToolUse$/);
  assert.equal(hooks.PostToolUse[0].hooks[0].timeout, 5, "must not inherit the 600s default");
  // SessionEnd closes what SessionStart opened. Its 5s timeout matters more
  // than most: without one, Claude Code gives SessionEnd hooks 1.5s in total.
  assert.match(hooks.SessionEnd[0].hooks[0].command, /ascenda-claude-hook" SessionEnd$/);
  assert.equal(hooks.SessionEnd[0].hooks[0].timeout, 5);
});

test("the example settings register the same hooks, each with a timeout", () => {
  // Copied by hand into a settings file, so it has to be right on its own. A
  // hook with no timeout waits up to 600s, and SessionEnd hooks without one
  // share 1.5s between them.
  const example = read(new URL("../examples/settings.local.json", import.meta.url));
  assert.deepEqual(Object.keys(example.hooks).sort(), [...EVENTS].sort());
  for (const [event, groups] of Object.entries(example.hooks)) {
    assert.equal(groups[0].hooks[0].command, `npx -y @ascenda-one/claude-code-hooks ${event}`);
    assert.equal(groups[0].hooks[0].timeout, 5, event);
  }
});

test("registers every event the mapper turns into telemetry", async () => {
  // The list above is hand-written, which is how PostToolUseFailure went
  // missing while the mapper already handled it. Cross-check against the
  // mapper itself: any hook event that yields an event must be registered.
  const { CLAUDE_HOOK_EVENT_NAMES } = await import("../dist/types.js");
  const { mapClaudeEvent } = await import("../dist/mapClaudeEvent.js");
  const file = tempSettings();
  writeSettings(file, BINARY, false);
  const registered = Object.keys(read(file).hooks);

  const probe = { session_id: "s1", source: "startup", tool_name: "Bash", tool_input: { command: "npm test" }, prompt: "hi", trigger: "manual" };
  for (const name of CLAUDE_HOOK_EVENT_NAMES) {
    if (mapClaudeEvent(name, probe).length === 0) continue;
    assert.ok(registered.includes(name), `${name} maps to telemetry but setup does not register it`);
  }
  assert.ok(registered.includes("PostToolUseFailure"));
});

test("preserves unrelated settings and other people's hooks", () => {
  const file = tempSettings(JSON.stringify({
    model: "opus",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/my-own-guard" }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "/usr/local/bin/cleanup" }] }]
    }
  }));

  writeSettings(file, BINARY, false);
  const settings = read(file);

  assert.equal(settings.model, "opus", "unrelated keys survive");
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, "/usr/local/bin/cleanup", "events we do not touch survive");
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "/usr/local/bin/my-own-guard", "foreign hook kept, and kept first");
});

test("re-running replaces our entry instead of appending duplicates", () => {
  const file = tempSettings();
  writeSettings(file, BINARY, false);
  assert.equal(writeSettings(file, BINARY, false), false, "second run reports no change");
  assert.equal(read(file).hooks.Stop.length, 1);

  // A moved binary is still our entry: it is replaced, not duplicated.
  assert.equal(writeSettings(file, "/elsewhere/ascenda-claude-hook", false), true);
  const groups = read(file).hooks.Stop;
  assert.equal(groups.length, 1);
  assert.match(groups[0].hooks[0].command, /\/elsewhere\//);
});

test("backs the file up before the first write", () => {
  const original = JSON.stringify({ model: "opus" });
  const file = tempSettings(original);
  writeSettings(file, BINARY, false);
  assert.equal(fs.readFileSync(`${file}.ascenda-backup`, "utf8"), original);
});

test("refuses to overwrite settings it cannot parse", () => {
  const corrupt = '{ "hooks": { unclosed';
  const file = tempSettings(corrupt);
  assert.equal(writeSettings(file, BINARY, false), null, "signals failure rather than clobbering");
  assert.equal(fs.readFileSync(file, "utf8"), corrupt, "user's file is untouched");
});

test("dry run writes nothing", () => {
  const file = tempSettings();
  assert.equal(writeSettings(file, BINARY, true), true);
  assert.equal(fs.existsSync(file), false);
});

test("an empty file is treated as no settings, not as corruption", () => {
  const file = tempSettings("   \n");
  assert.equal(writeSettings(file, BINARY, false), true);
  assert.equal(Object.keys(read(file).hooks).length, EVENTS.length);
});

test("spots ascenda-looking hooks that do not run the installed binary", () => {
  // An abandoned wrapper: setup preserves it (it cannot prove it is ours), so
  // it spawns a failing process per event until status names it.
  const settings = {
    hooks: {
      PostToolUse: [
        { hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.ascenda/hook.sh PostToolUse' }] },
        { hooks: [{ type: "command", command: `"/usr/bin/node" "${BINARY}" PostToolUse` }] }
      ],
      Stop: [{ hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.ascenda/hook.sh Stop' }] }]
    }
  };

  const stale = findStaleHookCommands(settings, BINARY);
  assert.equal(stale.length, 2, "both wrapper entries, and not the live one");
  assert.ok(stale.every((command) => command.includes("hook.sh")));
});

test("a healthy install and unrelated hooks report nothing stale", () => {
  const file = tempSettings(JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/my-own-guard" }] }] }
  }));
  writeSettings(file, BINARY, false);

  assert.deepEqual(findStaleHookCommands(read(file), BINARY), [], "a foreign hook with no ascenda in it is not our problem");
});

test("the same stale command across events is reported once", () => {
  const shared = '"$CLAUDE_PROJECT_DIR"/.ascenda/hook.sh';
  const settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: shared }] }], PreCompact: [{ hooks: [{ type: "command", command: shared }] }] } };

  assert.deepEqual(findStaleHookCommands(settings, BINARY), [shared]);
});
