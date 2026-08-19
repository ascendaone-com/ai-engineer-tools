import { test } from "node:test";
import assert from "node:assert/strict";
import { importOrdinals, importKeyOf, shippableEvents } from "../dist/ship.js";

// The backend dedups a replay on importKey alone, so the key has to name the
// source record and nothing about the run that read it. The ordinal used to
// be the event's index in the whole shipped array, which meant it named the
// run: extract a different set — Claude Code's 30-day purge having eaten the
// oldest days between runs — and every subsequent ordinal shifted, so
// unchanged records re-keyed and dedup stopped working on precisely the
// re-run it exists for. These fixtures are that scenario.

function event({ store = "claude_code", sessionRef, eventKind = "ai_prompt_submitted", occurredAt }) {
  return {
    store,
    sessionRef,
    eventKind,
    occurredAt,
    metrics: {},
    provenance: "historical_direct",
    extractionId: "extraction-1"
  };
}

function keysOf(events) {
  const wire = shippableEvents(events);
  const ordinals = importOrdinals(wire);
  return wire.map((e, i) => importKeyOf(e, ordinals[i]));
}

const AUG = (day, min) => `2026-08-${String(day).padStart(2, "0")}T09:${String(min).padStart(2, "0")}:00.000Z`;

test("a purge between runs does not re-key the records that survived", () => {
  const first = [
    event({ sessionRef: "s-old-1", occurredAt: AUG(1, 0) }),
    event({ sessionRef: "s-old-2", occurredAt: AUG(2, 0) }),
    event({ sessionRef: "s-kept-1", occurredAt: AUG(9, 0) }),
    event({ sessionRef: "s-kept-2", occurredAt: AUG(9, 5) })
  ];
  // The same store 30 days later: the two oldest sessions are gone.
  const second = first.slice(2);

  const firstKeys = keysOf(first);
  const secondKeys = keysOf(second);

  assert.deepEqual(
    secondKeys,
    firstKeys.slice(2),
    "surviving records keep the keys they shipped under"
  );
});

test("a run that gained days does not re-key the earlier ones either", () => {
  const first = [
    event({ sessionRef: "s-1", occurredAt: AUG(9, 0) }),
    event({ sessionRef: "s-2", occurredAt: AUG(9, 5) })
  ];
  const second = [
    ...first,
    event({ sessionRef: "s-3", occurredAt: AUG(10, 0) })
  ];

  const firstKeys = keysOf(first);
  const secondKeys = keysOf(second);
  assert.deepEqual(secondKeys.slice(0, 2), firstKeys);
  assert.equal(new Set(secondKeys).size, 3, "the new day gets a key of its own");
});

test("dropping one store leaves the other store's keys alone", () => {
  const both = [
    event({ store: "cursor", sessionRef: "c-1", occurredAt: AUG(9, 0) }),
    event({ store: "claude_code", sessionRef: "s-1", occurredAt: AUG(9, 0) }),
    event({ store: "cursor", sessionRef: "c-2", occurredAt: AUG(9, 1) })
  ];
  const claudeOnly = both.filter((e) => e.store === "claude_code");

  assert.deepEqual(keysOf(claudeOnly), [keysOf(both)[1]]);
});

test("events identical on the wire still get distinct keys", () => {
  // One prompt can drive several events inside the same millisecond. Without
  // a tiebreak these collapse to one key and the backend dedups away real
  // records — which is the reason an ordinal exists at all.
  const sameInstant = [
    event({ sessionRef: "s-1", occurredAt: AUG(9, 0) }),
    event({ sessionRef: "s-1", occurredAt: AUG(9, 0) }),
    event({ sessionRef: "s-1", occurredAt: AUG(9, 0) })
  ];

  assert.deepEqual(importOrdinals(sameInstant), [0, 1, 2]);
  assert.equal(new Set(keysOf(sameInstant)).size, 3);
});

test("a collision group is numbered independently of what surrounds it", () => {
  const collision = [
    event({ sessionRef: "s-1", occurredAt: AUG(9, 0) }),
    event({ sessionRef: "s-1", occurredAt: AUG(9, 0) })
  ];
  const surrounded = [
    event({ sessionRef: "s-earlier", occurredAt: AUG(1, 0) }),
    collision[0],
    event({ sessionRef: "s-between", occurredAt: AUG(5, 0) }),
    collision[1]
  ];

  const alone = keysOf(collision);
  const withNeighbours = keysOf(surrounded);
  assert.deepEqual([withNeighbours[1], withNeighbours[3]], alone);
});

test("kind and session are part of the identity, not just the instant", () => {
  const sameInstant = [
    event({ sessionRef: "s-1", eventKind: "ai_prompt_submitted", occurredAt: AUG(9, 0) }),
    event({ sessionRef: "s-1", eventKind: "create_focus_session", occurredAt: AUG(9, 0) }),
    event({ sessionRef: "s-2", eventKind: "ai_prompt_submitted", occurredAt: AUG(9, 0) })
  ];
  assert.deepEqual(importOrdinals(sameInstant), [0, 0, 0], "different identities never share a group");
  assert.equal(new Set(keysOf(sameInstant)).size, 3);
});

test("an event with no session still keys stably", () => {
  const first = [
    event({ sessionRef: undefined, eventKind: "editor_activity", occurredAt: AUG(1, 0) }),
    event({ sessionRef: undefined, eventKind: "editor_activity", occurredAt: AUG(9, 0) })
  ];
  assert.deepEqual(keysOf(first.slice(1)), [keysOf(first)[1]]);
});
