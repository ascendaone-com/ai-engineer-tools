import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfigFromEnv } from "../dist/config.js";

// The one rule this file exists to enforce: this server never mints a tool
// type of its own. A bare id would silently pair as a *third* tool even
// when the same physical installation already paired through a hook or an
// IDE extension — the whole point of reusing pairing is defeated if this
// slips.

const ENV_KEYS = [
  "ASCENDA_API_BASE_URL",
  "ASCENDA_TOOL_INSTALLATION_ID",
  "ASCENDA_EVENT_WRITE_TOKEN",
  "ASCENDA_EVENT_WRITE_TOKEN_FILE",
  "ASCENDA_SESSION_ID",
  "ASCENDA_WORKSPACE_HASH"
];

function withEnv(vars, run) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return run();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function tempTokenFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-agent-mcp-test-"));
  return path.join(dir, "token");
}

test("a bare (unqualified) tool installation id is refused", () => {
  withEnv(
    { ASCENDA_TOOL_INSTALLATION_ID: "abc123", ASCENDA_EVENT_WRITE_TOKEN: "tok" },
    () => {
      assert.throws(() => loadConfigFromEnv(), /fully-qualified id/);
    }
  );
});

test("a missing tool installation id is refused", () => {
  withEnv({ ASCENDA_EVENT_WRITE_TOKEN: "tok" }, () => {
    assert.throws(() => loadConfigFromEnv(), /Missing ASCENDA_TOOL_INSTALLATION_ID/);
  });
});

test("a fully-qualified id with no token anywhere is refused", () => {
  const file = tempTokenFile();
  withEnv(
    { ASCENDA_TOOL_INSTALLATION_ID: "claude_code:abc123", ASCENDA_EVENT_WRITE_TOKEN_FILE: file },
    () => {
      assert.throws(() => loadConfigFromEnv(), /Missing ASCENDA_EVENT_WRITE_TOKEN/);
    }
  );
});

test("a fully-qualified id round-trips as-is, and the token seeds the file", () => {
  const file = tempTokenFile();
  withEnv(
    {
      ASCENDA_TOOL_INSTALLATION_ID: "claude_code:abc123",
      ASCENDA_EVENT_WRITE_TOKEN: "tok_first",
      ASCENDA_EVENT_WRITE_TOKEN_FILE: file
    },
    () => {
      const config = loadConfigFromEnv();
      assert.equal(config.toolInstallationId, "claude_code:abc123");
      assert.equal(config.eventWriteToken, "tok_first");
      assert.equal(fs.readFileSync(file, "utf8"), "tok_first");
    }
  );
});

test("a token already on disk wins over the env var", () => {
  const file = tempTokenFile();
  fs.writeFileSync(file, "tok_on_disk");
  withEnv(
    {
      ASCENDA_TOOL_INSTALLATION_ID: "cursor_mcp:abc123",
      ASCENDA_EVENT_WRITE_TOKEN: "tok_env_should_not_win",
      ASCENDA_EVENT_WRITE_TOKEN_FILE: file
    },
    () => {
      const config = loadConfigFromEnv();
      assert.equal(config.eventWriteToken, "tok_on_disk");
    }
  );
});

test("sessionId defaults to a generated id, not null, so one process shares it across calls", () => {
  const file = tempTokenFile();
  withEnv(
    { ASCENDA_TOOL_INSTALLATION_ID: "claude_code:abc123", ASCENDA_EVENT_WRITE_TOKEN: "tok", ASCENDA_EVENT_WRITE_TOKEN_FILE: file },
    () => {
      const config = loadConfigFromEnv();
      assert.equal(typeof config.sessionId, "string");
      assert.ok(config.sessionId.length > 0);
    }
  );
});

test("an explicit ASCENDA_SESSION_ID is honoured over the generated default", () => {
  const file = tempTokenFile();
  withEnv(
    {
      ASCENDA_TOOL_INSTALLATION_ID: "claude_code:abc123",
      ASCENDA_EVENT_WRITE_TOKEN: "tok",
      ASCENDA_EVENT_WRITE_TOKEN_FILE: file,
      ASCENDA_SESSION_ID: "session-from-host"
    },
    () => {
      assert.equal(loadConfigFromEnv().sessionId, "session-from-host");
    }
  );
});
