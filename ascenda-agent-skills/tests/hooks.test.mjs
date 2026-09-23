import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The plugin registers its hooks from a static file, while `setup` registers
// the same events from a list in code. Two lists, one contract, and nothing
// held them together: `PostToolUseFailure` sat in this file from the day the
// mapper learned it while `setup` left it out for six weeks, so every install
// from that path reported no failed tool calls at all. Neither list is wrong
// on its own — they only fail by drifting apart, which is what this pins.

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const hooks = JSON.parse(readFileSync(here("../hooks/hooks.json"), "utf8")).hooks;

/** The `HOOK_EVENTS` tuple `setup` writes into settings.json. */
function setupHookEvents() {
  const source = readFileSync(
    here("../../ascenda-claude-code-hooks/src/setup.ts"),
    "utf8"
  );
  const match = source.match(/const HOOK_EVENTS = \[([^\]]*)\]/);
  assert.ok(
    match,
    "HOOK_EVENTS not found in setup.ts — if its shape changed, this guard needs to change with it rather than be deleted"
  );
  return match[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
}

test("the plugin registers exactly the events `setup` does", () => {
  assert.deepEqual([...Object.keys(hooks)].sort(), [...setupHookEvents()].sort());
});

test("every plugin hook carries a timeout", () => {
  // Claude Code's default for a command hook is 600s, and each of these
  // resolves `@ascenda-one/claude-code-hooks` through npx before it runs.
  // Telemetry that cannot finish in a few seconds is not worth a person's
  // turn waiting on it — the same 5s `setup` writes (HOOK_TIMEOUT_SECONDS).
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const entry of group.hooks) {
        assert.equal(entry.timeout, 5, `${event} has no 5s timeout`);
      }
    }
  }
});
