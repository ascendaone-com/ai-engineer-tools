import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mapClaudeEvent } from "../dist/mapClaudeEvent.js";

/**
 * The interruption leg counts THAT the agent stopped and waited, never WHAT it
 * asked.
 *
 * This is the condition the event's consent position rests on. It rides the
 * existing `ide_telemetry` scope — the scope a person already granted for
 * lifecycle events — and that is only defensible because producing it requires
 * reading no content. `semantic_work_signals` is a separate scope precisely
 * because its classifications ARE content-derived; the moment a question's
 * text, its options or the person's answer reach the wire, this event has
 * crossed that line and is being sent under a consent nobody gave for it.
 *
 * So the ban is enforced here, at source, rather than left to review. The
 * pattern is borrowed from the workspace's workout-presence guard, which bans
 * its own content fields from a sync payload the same way: a reviewer who
 * knows the rule still has to notice the diff, and across enough releases
 * someone will not.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** Fields that would make this event content-derived. */
const BANNED = [
  "message",
  "notificationMessage",
  "questionText",
  "question",
  "options",
  "answer",
  "selectedOption",
  "response",
  "prompt"
];

function notification(message) {
  return { hook_event_name: "Notification", session_id: "s1", cwd: process.cwd(), message };
}

test("a Notification maps to supervision_interruption carrying only a kind", () => {
  const [event] = mapClaudeEvent("Notification", notification("Claude needs your permission to use Bash"));

  assert.equal(event.eventType, "supervision_interruption");
  assert.equal(event.metadata.interruptionKind, "permission_request");
  // host and branchHash are stamped on every event by the adapter; the only
  // thing this mapping contributes is the kind.
  const contributed = Object.keys(event.metadata).filter((k) => k !== "host" && k !== "branchHash");
  assert.deepEqual(contributed, ["interruptionKind"]);
});

test("the notification's own words never appear anywhere in the event", () => {
  // A distinctive string: if any part of the message is carried through, in any
  // field, under any spelling, this finds it.
  const secret = "refactor the billing adapter for AcmeCorp";
  const [event] = mapClaudeEvent("Notification", notification(`Claude needs your permission to ${secret}`));

  assert.ok(
    !JSON.stringify(event).includes("AcmeCorp"),
    `the message leaked into the event: ${JSON.stringify(event)}`
  );
});

test("interruptionKind is one of three constant labels, never derived text", () => {
  const allowed = new Set(["permission_request", "idle_prompt", "other"]);
  for (const message of [
    "Claude needs your permission to use Bash",
    "Claude is waiting for your input",
    "Some wording nobody has seen before",
    undefined
  ]) {
    const [event] = mapClaudeEvent("Notification", notification(message));
    assert.ok(
      allowed.has(event.metadata.interruptionKind),
      `unexpected kind '${event.metadata.interruptionKind}' for message ${JSON.stringify(message)}`
    );
  }
});

test("an unrecognised notification is 'other', not silently a permission request", () => {
  // Claude Code can reword these at any release. A reworded prompt becoming
  // `other` moves a number we watch; a reworded prompt being guessed at would
  // quietly mislabel the distribution this whole measurement exists to find.
  const [event] = mapClaudeEvent("Notification", notification("Something entirely new"));
  assert.equal(event.metadata.interruptionKind, "other");
});

test("no banned content field is named anywhere in the interruption mapping source", () => {
  // The behavioural tests above prove today's mapping is clean. This one is
  // aimed at the next edit: it fails when someone adds a content field, even if
  // no existing assertion happens to cover the path that emits it.
  const source = fs.readFileSync(path.join(SRC, "mapClaudeEvent.ts"), "utf8");
  // The emitting function only. `notificationKind` below it legitimately takes
  // a `message:` PARAMETER — reading the message to pick a label is the whole
  // point; the ban is on a message-shaped value being put on the wire, so the
  // region stops before that signature rather than flagging it.
  const start = source.indexOf("function mapNotification");
  const region = source.slice(start, source.indexOf("function notificationKind", start));
  assert.ok(start >= 0 && region.length > 0, "could not locate the interruption mapping — did it get renamed?");

  for (const field of BANNED) {
    assert.ok(
      !new RegExp(`\\b${field}\\s*:`).test(region),
      `'${field}' is being put on the wire by the interruption mapping. This event rides the ` +
        `ide_telemetry scope, which is only honest while it carries no content. If this field is ` +
        `genuinely needed, the event belongs under semantic_work_signals instead — that is a ` +
        `consent decision, not a code-review one.`
    );
  }
});
