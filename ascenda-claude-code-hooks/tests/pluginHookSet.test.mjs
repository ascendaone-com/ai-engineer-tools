import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pendingPluginHookSetNotice } from "../dist/pluginHookSet.js";

// The plugin's code follows npm; its hooks.json follows plugin updates. The
// note fires when the two drift, from the hook's own argv.

const PLUGIN = { CLAUDE_PLUGIN_ROOT: "/plugins/ascenda" };

function stateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-plugin-set-")), "plugin-hook-set.json");
}

test("a plugin registering an older set is told to update, once", () => {
  const file = stateFile();
  const argv = ["node", "cli.js", "SessionStart", "--hook-set", "4"];
  const first = pendingPluginHookSetNotice({ currentSet: 5, argv, env: PLUGIN, file });
  assert.match(first.text, /registers hook set 4, and the code it runs expects set 5/);
  assert.match(first.text, /claude plugin update ascenda@ascenda-one/);
  first.markShown();
  assert.equal(pendingPluginHookSetNotice({ currentSet: 5, argv, env: PLUGIN, file }), undefined);
  // The next gap is a new note.
  assert.ok(pendingPluginHookSetNotice({ currentSet: 6, argv, env: PLUGIN, file }));
});

test("no note for a current plugin, a setup install, a bare run, or with the switch off", () => {
  const file = stateFile();
  const argv = ["node", "cli.js", "SessionStart", "--hook-set", "4"];
  assert.equal(pendingPluginHookSetNotice({ currentSet: 4, argv, env: PLUGIN, file }), undefined);
  assert.equal(pendingPluginHookSetNotice({ currentSet: 5, argv, env: {}, file }), undefined);
  assert.equal(pendingPluginHookSetNotice({ currentSet: 5, argv: ["node", "cli.js", "SessionStart"], env: PLUGIN, file }), undefined);
  assert.equal(pendingPluginHookSetNotice({ currentSet: 5, argv, env: { ...PLUGIN, ASCENDA_DISABLE_UPDATE_CHECK: "true" }, file }), undefined);
});
