/**
 * Stopping when the backend has already said no.
 *
 * On 25 August 2026 a real run sent 28,158 backdated events, one full batch at
 * a time, and reported `accepted=0 rejected=28158 consent_missing_or_expired`
 * at the end. Every refusal was correct and the first one already contained the
 * whole answer: this account has no `HistoricalImport` lease, and no lease is
 * going to appear while somebody watches a progress bar in a terminal.
 *
 * The existing abort only catches a 401/403, and the batch door answers neither
 * — it returns 200 with per-item rejections. So these tests pin the shape of
 * the stop, and, just as importantly, pin that a *mixed* batch does not trigger
 * it: an off-catalog type or a missing importKey is a per-event problem, and
 * the events that are fine must still land.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shipEvents } from "../dist/ship.js";

const CONFIG = {
  apiBaseUrl: "https://api.example.test",
  toolInstallationId: "claude_code:test",
  eventWriteToken: "token"
};

function events(n) {
  return Array.from({ length: n }, (_, i) => ({
    occurredAt: new Date(Date.UTC(2026, 4, 1, 9, 0, i % 60)).toISOString(),
    store: "claude_code",
    sourceVersion: "1.0",
    sessionRef: `session-${i}`,
    repoRef: "/Users/dev/repo",
    eventKind: "ai_prompt_submitted",
    metrics: { promptCount: 1 },
    provenance: "historical_direct",
    extractionId: "run-1"
  }));
}

/** Counts calls so "did it stop" is a fact, not an inference from totals. */
function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.events.length);
    return responder(body.events.length, calls.length);
  };
  return calls;
}

function batchResponse(items) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      accepted: items.filter((i) => i.status === "accepted").length,
      duplicate: items.filter((i) => i.status === "duplicate").length,
      rejected: items.filter((i) => i.status === "rejected").length,
      results: items
    })
  };
}

const refused = (n, reason = "consent_missing_or_expired") =>
  batchResponse(Array.from({ length: n }, () => ({ status: "rejected", reason })));

test("a batch refused entirely for consent stops the run", async () => {
  const original = globalThis.fetch;
  try {
    const calls = stubFetch((n) => refused(n));
    const result = await shipEvents(events(2500), CONFIG);

    assert.equal(calls.length, 1, "kept sending after the answer was already in");
    assert.equal(result.consentBlocked, true);
    assert.equal(result.accepted, 0);
    assert.ok(result.sent < 2500, "sent everything it had despite being refused");
  } finally {
    globalThis.fetch = original;
  }
});

test("an unknown consent scope stops the run for the same reason", async () => {
  // No grant the user could make would admit these either, so walking the rest
  // of the list is the same wasted afternoon under a different heading.
  const original = globalThis.fetch;
  try {
    const calls = stubFetch((n) => refused(n, "unknown_consent_scope"));
    const result = await shipEvents(events(2500), CONFIG);

    assert.equal(calls.length, 1);
    assert.equal(result.consentBlocked, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("a mixed batch keeps going — per-event problems are not a wall", async () => {
  const original = globalThis.fetch;
  try {
    const calls = stubFetch((n) =>
      batchResponse(
        Array.from({ length: n }, (_, i) =>
          i === 0
            ? { status: "rejected", reason: "unknown_event_type" }
            : { status: "accepted" }
        )
      )
    );
    const result = await shipEvents(events(2500), CONFIG);

    assert.ok(calls.length > 1, "one bad event stopped a run that was working");
    assert.notEqual(result.consentBlocked, true);
    assert.ok(result.accepted > 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("a fully-accepted run is never mistaken for a wall", async () => {
  const original = globalThis.fetch;
  try {
    const calls = stubFetch((n) =>
      batchResponse(Array.from({ length: n }, () => ({ status: "accepted" })))
    );
    const result = await shipEvents(events(2500), CONFIG);

    assert.ok(calls.length > 1);
    assert.notEqual(result.consentBlocked, true);
    assert.equal(result.rejected, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("a duplicate re-run is not a wall either", async () => {
  // The second run over the same records is the success case, not a refusal.
  const original = globalThis.fetch;
  try {
    const calls = stubFetch((n) =>
      batchResponse(
        Array.from({ length: n }, () => ({ status: "duplicate", reason: "already_imported" }))
      )
    );
    const result = await shipEvents(events(2500), CONFIG);

    assert.ok(calls.length > 1);
    assert.notEqual(result.consentBlocked, true);
    assert.equal(result.duplicate, 2500);
  } finally {
    globalThis.fetch = original;
  }
});
