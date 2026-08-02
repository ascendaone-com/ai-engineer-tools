import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The context-injection stdout path is new I/O behaviour this package never
// had before (every other hook stays silent on stdout), so it's worth
// verifying end-to-end against the actual built CLI rather than only the
// pure mapping function — a bundling mistake or a stray console.log
// elsewhere would only show up here.

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function runHook(hookName, input, env = {}) {
  return spawnSync("node", [cliPath, hookName], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      // Deliberately unset/invalid: proves the context injection does not
      // depend on a working pairing, and proves the process still exits 0
      // even when telemetry sending fails right after.
      ASCENDA_TOOL_INSTALLATION_ID: "",
      ASCENDA_EVENT_WRITE_TOKEN: "",
      ...env
    }
  });
}

test("SessionStart (startup) writes the additionalContext hook output to stdout and exits 0", () => {
  const result = runHook("SessionStart", { source: "startup" });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /what would make this session count/);
});

test("SessionStart (resume) also writes the hook output", () => {
  const result = runHook("SessionStart", { source: "resume" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /additionalContext/);
});

test("SessionStart (clear) writes nothing to stdout", () => {
  const result = runHook("SessionStart", { source: "clear" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("SessionStart (compact) writes nothing to stdout", () => {
  const result = runHook("SessionStart", { source: "compact" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("ASCENDA_DISABLE_INTENTION_INVITE=true silences the injection even on startup", () => {
  const result = runHook("SessionStart", { source: "startup" }, { ASCENDA_DISABLE_INTENTION_INVITE: "true" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("a non-SessionStart hook never writes to stdout, pairing or not", () => {
  const result = runHook("PostToolUse", { tool_name: "Grep", tool_response: { exitCode: 0 } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("a broken pairing still exits 0 (telemetry failure is swallowed to stderr, never blocks the turn)", () => {
  const result = runHook("SessionStart", { source: "startup" });
  assert.equal(result.status, 0);
  // The injection still happened despite the pairing being unusable.
  assert.match(result.stdout, /additionalContext/);
});
