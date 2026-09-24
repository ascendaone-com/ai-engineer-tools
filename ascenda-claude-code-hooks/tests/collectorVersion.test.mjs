import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End to end against the built CLI, unpaired, reading the opt-in event log:
// the log holds byte for byte what a send would have put on the wire, so this
// is the bundle's own answer to "which build sent this event".

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

// The release in CI, where release.yml sets the tag, and "unreleased" from a
// checkout. Never the 0.1.0 an unstamped package.json carries.
const EXPECTED = process.env.ASCENDA_COLLECTOR_VERSION?.trim().replace(/^v/, "") || "unreleased";

test("every payload the built CLI writes names the collector version", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-version-"));
  const logFile = path.join(home, "events.jsonl");
  try {
    const result = spawnSync("node", [CLI, "PreToolUse"], {
      input: JSON.stringify({ tool_name: "Bash", cwd: home, session_id: "s1" }),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        ASCENDA_HOME: home,
        ASCENDA_STATE_DIR: path.join(home, "state"),
        ASCENDA_EVENT_LOG_FILE: logFile,
        ASCENDA_TOOL_INSTALLATION_ID: "",
        ASCENDA_EVENT_WRITE_TOKEN: ""
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.length >= 1, "the CLI logged nothing");
    for (const { payload } of lines) assert.equal(payload.metadata.collectorVersion, EXPECTED, payload.eventType);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
