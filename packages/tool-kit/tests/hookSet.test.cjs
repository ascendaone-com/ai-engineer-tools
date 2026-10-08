const { test } = require("node:test");
const assert = require("node:assert/strict");
const { describeHookSetChanges, hookSetArgument, hookSetChanges, hookSetOfCommand, readHookSet } = require("../out/index.js");

// The registration names its own hook set, and the live signal repeats it,
// because nothing else can tell the app an install is older than the hooks
// this release registers.

test("the set rides argv after the hook name, and anything malformed reads as absent", () => {
  assert.equal(readHookSet(["node", "cli.js", "Stop", "--hook-set", "2"]), 2);
  assert.equal(readHookSet(["node", "cli.js", "Stop"]), undefined, "an unflagged registration says nothing");
  assert.equal(readHookSet(["node", "cli.js", "--hook-set"]), undefined);
  assert.equal(readHookSet(["node", "cli.js", "--hook-set", "two"]), undefined);
  assert.equal(readHookSet(["node", "cli.js", "--hook-set", "0"]), undefined);
  assert.equal(readHookSet(["node", "cli.js", "--hook-set", "1.5"]), undefined);
});

test("a registered command reads as set 1 until it carries the flag", () => {
  assert.equal(hookSetOfCommand('"/usr/bin/node" "/h/.ascenda/bin/ascenda-claude-hook" Stop'), 1);
  assert.equal(hookSetOfCommand('"/usr/bin/node" "/h/.ascenda/bin/ascenda-claude-hook" Stop --hook-set 2'), 2);
  assert.equal(hookSetArgument(2), " --hook-set 2");
  assert.equal(hookSetArgument(undefined), "", "an adapter with no set registers exactly what it did before");
});

test("setup reports the events an upgrade added, and nothing on a first install or a no-op", () => {
  const events = ["Stop", "StopFailure", "Notification"];
  const upgrade = hookSetChanges(new Map([["Stop", 1], ["Notification", 1]]), events);
  assert.deepEqual(upgrade, { added: ["StopFailure"], previousSet: 1 });
  assert.equal(describeHookSetChanges(upgrade, 2), "upgraded: added StopFailure; hook set 1 → 2");

  assert.equal(describeHookSetChanges(hookSetChanges(new Map(), events), 2), undefined);
  const current = hookSetChanges(new Map(events.map((e) => [e, 2])), events);
  assert.equal(describeHookSetChanges(current, 2), undefined);
});
