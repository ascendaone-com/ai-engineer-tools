import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mapCodexEvent } from "../dist/mapCodexEvent.js";
import { HOOK_EVENTS } from "../dist/setup.js";

/**
 * Codex's half of the interruption leg. Same rule as the Claude Code adapter:
 * count that the agent reached a gate and stopped, never what it was asking
 * for. The event rides the `ide_telemetry` scope, and that only holds while
 * producing it requires reading no content — see the Claude-side guard for the
 * full reasoning.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

const BANNED = ["command", "toolInput", "arguments", "args", "reason", "request", "prompt", "content", "path", "filePath"];

test("PermissionRequest maps to supervision_interruption", () => {
  const [event] = mapCodexEvent("PermissionRequest", {
    session_id: "s1",
    tool_name: "shell",
    command: "rm -rf /tmp/acme-secret-project"
  });

  assert.equal(event.eventType, "supervision_interruption");
  assert.equal(event.severity, "low");
  assert.equal(event.metadata.interruptionKind, "permission_request");
});

test("nothing about what was being approved reaches the event", () => {
  const [event] = mapCodexEvent("PermissionRequest", {
    session_id: "s1",
    tool_name: "shell",
    command: "deploy --target AcmeCorp",
    cwd: "/Users/someone/AcmeCorp"
  });

  const serialised = JSON.stringify(event);
  assert.ok(!serialised.includes("AcmeCorp"), `the request leaked into the event: ${serialised}`);
  assert.ok(!serialised.includes("deploy"), `the command leaked into the event: ${serialised}`);
});

test("the subagent lifecycle stays unmapped", () => {
  // Out of scope deliberately: a subagent starting is not an interruption of
  // the person. Pinned so it is not swept in alongside this change.
  assert.deepEqual(mapCodexEvent("SubagentStart", { session_id: "s1" }), []);
  assert.deepEqual(mapCodexEvent("SubagentStop", { session_id: "s1" }), []);
});

test("PermissionRequest is registered, not just mapped", () => {
  // The half that has been wrong before: mapped and unregistered means the
  // hook never fires and the count is silently zero, which looks exactly like
  // never being interrupted.
  assert.ok(HOOK_EVENTS.includes("PermissionRequest"));
  assert.ok(!HOOK_EVENTS.includes("SubagentStart"));
  assert.ok(!HOOK_EVENTS.includes("SubagentStop"));
});

test("no banned content field is named in the PermissionRequest mapping", () => {
  const source = fs.readFileSync(path.join(SRC, "mapCodexEvent.ts"), "utf8");
  const start = source.indexOf('case "PermissionRequest":');
  const region = source.slice(start, source.indexOf('case "SubagentStart":', start));
  assert.ok(start >= 0 && region.length > 0, "could not locate the PermissionRequest mapping");

  for (const field of BANNED) {
    assert.ok(
      !new RegExp(`\\b${field}\\s*:`).test(region),
      `'${field}' is being put on the wire by the PermissionRequest mapping. This event rides ` +
        `the ide_telemetry scope, which is only honest while it carries no content.`
    );
  }
});
