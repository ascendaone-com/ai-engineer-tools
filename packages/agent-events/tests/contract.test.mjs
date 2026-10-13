import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AGENT_EVENT_KINDS, AGENT_EVENT_SCHEMA, isAgentEventV0, normaliseKind, parseEventLogLine } = require("../out/index.js");
const schema = JSON.parse(fs.readFileSync(new URL("../schema/agent-event.v0.schema.json", import.meta.url), "utf8"));

// The schema and the types are two copies of one shape. These pin the parts a
// consumer depends on, so a kind added to one and not the other fails here.

test("the schema's kinds are exactly the exported kinds, in order", () => {
  assert.deepEqual(schema.properties.kind.enum, [...AGENT_EVENT_KINDS]);
});

test("the schema's const is the exported schema name", () => {
  assert.equal(schema.properties.schema.const, AGENT_EVENT_SCHEMA);
  assert.equal(AGENT_EVENT_SCHEMA, "agent-event/v0");
});

test("the schema requires what isAgentEventV0 checks", () => {
  assert.deepEqual([...schema.required].sort(), ["agent", "id", "kind", "schema", "time"]);
});

test("the schema stays open to added fields, which v0 allows", () => {
  assert.equal(schema.additionalProperties, true);
});

const EVENT = { schema: "agent-event/v0", id: "e1", time: "2026-10-10T01:02:03.000Z", agent: "codex", kind: "tool.started", tool: "shell" };

test("isAgentEventV0 accepts an event with extra fields and rejects one missing a required field", () => {
  assert.ok(isAgentEventV0(EVENT));
  assert.ok(isAgentEventV0({ ...EVENT, somethingNew: 1 }));
  for (const field of ["schema", "id", "time", "agent", "kind"]) {
    const { [field]: _dropped, ...rest } = EVENT;
    assert.equal(isAgentEventV0(rest), false, `missing ${field}`);
  }
  assert.equal(isAgentEventV0({ ...EVENT, schema: "agent-event/v1" }), false);
  assert.equal(isAgentEventV0({ ...EVENT, time: "yesterday" }), false);
});

test("parseEventLogLine reads the event and skips what it can't use", () => {
  assert.deepEqual(parseEventLogLine(JSON.stringify({ loggedAt: "x", payload: {}, event: EVENT })), EVENT);
  assert.equal(parseEventLogLine(""), undefined);
  assert.equal(parseEventLogLine('{"loggedAt":"x","payl'), undefined, "a half-written line");
  assert.equal(parseEventLogLine(JSON.stringify({ loggedAt: "x", payload: { eventType: "ai_prompt_submitted" } })), undefined, "a line from before v0");
});

test("an unknown kind reads as other", () => {
  assert.equal(normaliseKind("tool.started"), "tool.started");
  assert.equal(normaliseKind("tool.retried"), "other");
});

// The fields added after the first v0 release. Each is optional, so an event
// without them still passes and an older reader just never sees them.

test("the join and detail fields are optional and typed in the schema", () => {
  for (const field of ["repoKey", "branchKey", "promptId", "vcsAction", "reason", "model", "permissionMode"]) {
    assert.equal(schema.properties[field]?.type, "string", field);
    assert.ok(!schema.required.includes(field), `${field} must stay optional`);
  }
  assert.equal(new RegExp(schema.properties.repoKey.pattern).test("a1b2c3d4"), true);
  assert.equal(new RegExp(schema.properties.repoKey.pattern).test("a1b2c3d4e5f60718"), false);
  assert.equal(new RegExp(schema.properties.branchKey.pattern).test("a1b2c3d4e5f60718"), true);
});

test("the exported value lists name what the schema's descriptions promise", () => {
  const { VCS_ACTIONS, WAIT_REASONS } = require("../out/index.js");
  for (const value of VCS_ACTIONS) assert.ok(schema.properties.vcsAction.description.includes(value), value);
  for (const value of WAIT_REASONS) assert.ok(schema.properties.reason.description.includes(value), value);
});

test("an event with the new fields is still an event", () => {
  assert.ok(isAgentEventV0({ ...EVENT, repoKey: "a1b2c3d4", branchKey: "a1b2c3d4e5f60718", promptId: "p1", vcsAction: "push", reason: "idle", model: "m", permissionMode: "auto" }));
});
