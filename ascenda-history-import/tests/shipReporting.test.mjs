import { test } from "node:test";
import assert from "node:assert/strict";
import { shipEvents } from "../dist/ship.js";

/**
 * `--ship` has to close with something a caller can read.
 *
 * The 25 Aug run printed no summary at all, so the only signal available to
 * anything calling it was the exit code. Per-source counts are the other half:
 * "9,741 accepted" across three stores does not tell you that one of them
 * contributed zero.
 */

const CONFIG = { apiBaseUrl: "https://example.invalid", toolInstallationId: "t", eventWriteToken: "k" };

function event(store, i) {
  return {
    occurredAt: `2026-08-0${(i % 9) + 1}T10:00:00.000Z`,
    store,
    sourceVersion: null,
    sessionRef: `${store}-s${i}`,
    repoRef: null,
    eventKind: "ai_prompt_submitted",
    metrics: {},
    provenance: "historical_direct",
    extractionId: "e1"
  };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test("ship results are attributed back to the source that produced them", async () => {
  const events = [event("claude_code", 1), event("cursor", 2), event("vscode", 3), event("vscode", 4)];
  const restore = stubFetch(async (_url, init) => {
    const sent = JSON.parse(init.body).events;
    return jsonResponse({
      accepted: 3,
      duplicate: 1,
      rejected: 0,
      results: sent.map((_, i) => ({ status: i === 3 ? "duplicate" : "accepted" }))
    });
  });
  try {
    const result = await shipEvents(events, CONFIG);
    assert.equal(result.attributionComplete, true);
    assert.deepEqual(result.perStore.claude_code, { sent: 1, accepted: 1, duplicate: 0, rejected: 0 });
    assert.deepEqual(result.perStore.cursor, { sent: 1, accepted: 1, duplicate: 0, rejected: 0 });
    assert.deepEqual(result.perStore.vscode, { sent: 2, accepted: 1, duplicate: 1, rejected: 0 });
  } finally {
    restore();
  }
});

test("a response that cannot be attributed is declared, never spread across stores by guess", async () => {
  const events = [event("claude_code", 1), event("vscode", 2)];
  const restore = stubFetch(async () => jsonResponse({ accepted: 2, duplicate: 0, rejected: 0 }));
  try {
    const result = await shipEvents(events, CONFIG);
    assert.equal(result.accepted, 2, "the total is still exact");
    assert.equal(result.attributionComplete, false, "the per-store split is not, and must say so");
    assert.equal(result.perStore.claude_code.sent, 1, "what we SENT per store is always known");
    assert.equal(result.perStore.claude_code.accepted, 0, "what was accepted per store is not invented");
  } finally {
    restore();
  }
});

test("a transport failure marks attribution incomplete rather than reporting a clean split", async () => {
  const restore = stubFetch(async () => {
    throw new Error("socket hang up");
  });
  try {
    const result = await shipEvents([event("vscode", 1)], CONFIG);
    assert.equal(result.httpFailures, 1);
    assert.equal(result.attributionComplete, false);
    assert.equal(result.sent, 0, "a chunk that never left is not 'sent'");
  } finally {
    restore();
  }
});

test("a non-OK response is an http failure, and the run must be able to see it", async () => {
  const restore = stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    const result = await shipEvents([event("vscode", 1)], CONFIG);
    assert.equal(result.httpFailures, 1);
    assert.equal(result.accepted, 0);
    assert.equal(result.attributionComplete, false);
  } finally {
    restore();
  }
});

test("event order — and therefore every importKey — is unchanged by per-store bookkeeping", async () => {
  // `importKey` hashes the event's ordinal in the whole shipped array. If
  // attribution had been implemented by shipping each store separately, every
  // ordinal would shift and the backend would treat a re-import as entirely
  // new data. This pins that the wire order is still one flat sequence.
  const events = [event("claude_code", 1), event("vscode", 2), event("cursor", 3)];
  const seen = [];
  const restore = stubFetch(async (_url, init) => {
    const sent = JSON.parse(init.body).events;
    seen.push(...sent.map((e) => e.sessionId));
    return jsonResponse({ accepted: sent.length, results: sent.map(() => ({ status: "accepted" })) });
  });
  try {
    await shipEvents(events, CONFIG);
    assert.deepEqual(seen, ["claude_code-s1", "vscode-s2", "cursor-s3"]);
  } finally {
    restore();
  }
});
