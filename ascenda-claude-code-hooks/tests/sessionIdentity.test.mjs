import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end against the built CLI: a hook payload names the session it came
// from, and that identity has to reach the wire.
//
// Before this, `sessionId` was read from ASCENDA_SESSION_ID and nowhere else —
// a variable nothing sets — so every shipped row carried a null session. The
// consequence was not cosmetic: a reader cannot union what it cannot group,
// and asc-core-be#185 found its per-day active-time figures resting entirely
// on duration-bucket midpoints for the days whose rows had no session, because
// a session-less row gap-splits to a zero-length span.
//
// The unpaired+log path is used because it exercises the same
// buildEventPayload identity as a real send, without a network — the same
// technique workContext.test.mjs uses, and for the same reason.

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function runHook(input, env = {}) {
  return spawnSync("node", [cliPath, "PreToolUse"], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      ASCENDA_TOOL_INSTALLATION_ID: "",
      ASCENDA_EVENT_WRITE_TOKEN: "",
      ASCENDA_SESSION_ID: "",
      ...env
    }
  });
}

function loggedPayload(logFile) {
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  return JSON.parse(lines[0]).payload;
}

test("the payload's session_id reaches the event, with no environment variable set", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-session-"));
  const logFile = path.join(root, "events.jsonl");

  const result = runHook(
    { tool_name: "Bash", cwd: root, session_id: "sess-abc-123" },
    { ASCENDA_EVENT_LOG_FILE: logFile }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loggedPayload(logFile).sessionId, "sess-abc-123");
});

test("the environment variable still wins, so an override stays an override", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-session-"));
  const logFile = path.join(root, "events.jsonl");

  const result = runHook(
    { tool_name: "Bash", cwd: root, session_id: "sess-from-payload" },
    { ASCENDA_EVENT_LOG_FILE: logFile, ASCENDA_SESSION_ID: "sess-from-env" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loggedPayload(logFile).sessionId, "sess-from-env");
});

test("a payload with no session leaves the field absent, never a stand-in", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-session-"));
  const logFile = path.join(root, "events.jsonl");

  const result = runHook({ tool_name: "Bash", cwd: root }, { ASCENDA_EVENT_LOG_FILE: logFile });
  assert.equal(result.status, 0, result.stderr);
  // Absent, not the parent pid the local gauge falls back to: that fallback is
  // right for a display cue on this machine and wrong for a stored row, where
  // a pid would group unrelated sessions together under a number that means
  // nothing after the process exits.
  assert.equal(loggedPayload(logFile).sessionId, undefined);
});
