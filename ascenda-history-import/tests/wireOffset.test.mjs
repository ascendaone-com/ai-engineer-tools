import { test } from "node:test";
import assert from "node:assert/strict";
import { shippableEvents, toWirePayload } from "../dist/ship.js";

// `occurredAt` is UTC and carries no offset, so a consumer cannot recover the
// person's own clock — which is how the backend came to read UTC hours as
// local, flagging a UTC+10 working day as after-hours.
test("every shipped event carries the offset its instant was in", () => {
  // Without this the backend has only a UTC hour and must guess whether it is
  // the person's. A backfill spans DST, so the offset is per event, not per
  // run: stamping today's on nine months of history shifts a whole season.
  const events = [
    {
      occurredAt: "2026-01-15T03:00:00.000Z",
      store: "claude_code",
      sourceVersion: "2.1.0",
      sessionRef: "s-jan",
      repoRef: null,
      eventKind: "ai_prompt_submitted",
      metrics: {},
      provenance: "historical_direct",
      extractionId: "e-1"
    },
    {
      occurredAt: "2026-07-15T03:00:00.000Z",
      store: "claude_code",
      sourceVersion: "2.1.0",
      sessionRef: "s-jul",
      repoRef: null,
      eventKind: "ai_prompt_submitted",
      metrics: {},
      provenance: "historical_direct",
      extractionId: "e-1"
    }
  ];

  const [jan, jul] = shippableEvents(events).map((e, i) =>
    toWirePayload(e, i, "claude_code:test")
  );

  assert.equal(typeof jan.utcOffsetMinutes, "number");
  assert.equal(typeof jul.utcOffsetMinutes, "number");
  assert.equal(
    jan.utcOffsetMinutes,
    -new Date("2026-01-15T03:00:00.000Z").getTimezoneOffset(),
    "the offset in force in January, not the one at import time"
  );
  assert.equal(
    jul.utcOffsetMinutes,
    -new Date("2026-07-15T03:00:00.000Z").getTimezoneOffset()
  );
});
