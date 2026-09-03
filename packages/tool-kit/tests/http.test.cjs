const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseIngestResponse, isRetryableStatus } = require("../out/index.js");

// parseIngestResponse is the single place that decides how every producer reacts
// to a rejected event: give up, re-pair, drop, or surface. Getting a branch wrong
// is silent — the tool keeps running and the events stop arriving — so each
// status the API contract defines is pinned here.
//
// It now returns a verdict *and* its evidence rather than a bare string, and it
// no longer throws. A thrown error on the hook path unwound to a top-level catch
// that wrote to a stderr the host discards, which is indistinguishable from
// success; a returned `transport_error` can be journalled, retried and reported.

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("2xx is accepted", async () => {
  assert.equal((await parseIngestResponse(new Response("", { status: 200 }))).result, "accepted");
  assert.equal((await parseIngestResponse(new Response("", { status: 202 }))).result, "accepted");
});

test("401 is auth_failed — token invalid or revoked, re-pair", async () => {
  const outcome = await parseIngestResponse(json(401, { error: "unauthorized" }));
  assert.equal(outcome.result, "auth_failed");
  assert.equal(outcome.httpStatus, 401);
  assert.equal(outcome.errorCode, "unauthorized");
});

test("403 + consent_missing_or_expired is consent_missing, not a hard failure", async () => {
  assert.equal((await parseIngestResponse(json(403, { error: "consent_missing_or_expired" }))).result, "consent_missing");
});

test("403 with any other error code is a transport_error, never mistaken for consent", async () => {
  // A forbidden-for-some-other-reason must not be swallowed as a consent lapse,
  // which producers treat as recoverable. It stays distinct — and now carries
  // the code that says which it was.
  const outcome = await parseIngestResponse(json(403, { error: "forbidden" }));
  assert.equal(outcome.result, "transport_error");
  assert.equal(outcome.errorCode, "forbidden");
});

test("400 and 422 are validation_failed — the payload is wrong, retrying will not help", async () => {
  assert.equal((await parseIngestResponse(json(400, { error: "bad_request" }))).result, "validation_failed");
  assert.equal((await parseIngestResponse(json(422, { error: "unprocessable" }))).result, "validation_failed");
});

test("5xx is a transport_error carrying the status, not an exception", async () => {
  const outcome = await parseIngestResponse(json(500, { error: "server_error" }));
  assert.equal(outcome.result, "transport_error");
  assert.equal(outcome.httpStatus, 500);
  assert.equal(outcome.errorCode, "server_error");
});

test("a non-JSON error body does not crash the parser", async () => {
  // Gateways and proxies return HTML, not JSON. The errorCode lookup must fail
  // soft, and status-based branches must still work.
  const html = new Response("<html>502 Bad Gateway</html>", { status: 401 });
  assert.equal((await parseIngestResponse(html)).result, "auth_failed");

  const gateway = await parseIngestResponse(new Response("<html>oops</html>", { status: 502 }));
  assert.equal(gateway.result, "transport_error");
  assert.equal(gateway.httpStatus, 502);
  assert.equal(gateway.errorCode, undefined);
});

test("isRetryableStatus covers the no-verdict statuses only", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, `${status} should be retried`);
  }
  // A rejection with a verdict must not be retried: replaying it cannot change
  // the answer and would double every failing event.
  for (const status of [200, 400, 401, 403, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} should not be retried`);
  }
});

// --- idempotencyKey replays (issues #50 / #51) ---
//
// A replayed event is answered `status: "duplicate"` — the whole response on
// the single door, per item (with `reason: "already_delivered"`) on the batch
// door. It is a success with nothing to do: the same verdict as `accepted`
// for eviction, for the journal, and for "do not retry". These pin that the
// parser collapses the two, and that it branches on `status` alone.

test("single door: status duplicate is accepted, with the replay counted", async () => {
  const outcome = await parseIngestResponse(json(200, { status: "duplicate" }));
  assert.equal(outcome.result, "accepted");
  assert.equal(outcome.httpStatus, 200);
  assert.equal(outcome.duplicates, 1);
});

test("single door: status accepted carries no duplicate count", async () => {
  const outcome = await parseIngestResponse(json(200, { status: "accepted" }));
  assert.equal(outcome.result, "accepted");
  assert.equal(outcome.duplicates, undefined);
});

test("batch door: every item duplicate is accepted, counted per item", async () => {
  const outcome = await parseIngestResponse(
    json(200, {
      accepted: 0,
      duplicate: 2,
      rejected: 0,
      results: [
        { index: 0, status: "duplicate", reason: "already_delivered" },
        { index: 1, status: "duplicate", reason: "already_delivered" }
      ]
    })
  );
  assert.equal(outcome.result, "accepted");
  assert.equal(outcome.duplicates, 2);
});

test("batch door: a mix of accepted and duplicate is accepted", async () => {
  const outcome = await parseIngestResponse(
    json(200, {
      accepted: 1,
      duplicate: 1,
      rejected: 0,
      results: [
        { index: 0, status: "accepted" },
        { index: 1, status: "duplicate", reason: "already_delivered" }
      ]
    })
  );
  assert.equal(outcome.result, "accepted");
  assert.equal(outcome.duplicates, 1);
});

test("the branch is on status, never on reason", async () => {
  // `reason` is for a person reading their logs (already_delivered vs
  // already_imported). An unknown reason on a duplicate is still a duplicate;
  // a familiar reason on an accepted item does not make it one.
  const imported = await parseIngestResponse(
    json(200, { results: [{ index: 0, status: "duplicate", reason: "already_imported" }] })
  );
  assert.equal(imported.result, "accepted");
  assert.equal(imported.duplicates, 1);

  const oddReason = await parseIngestResponse(
    json(200, { results: [{ index: 0, status: "duplicate", reason: "something_new" }] })
  );
  assert.equal(oddReason.duplicates, 1);

  const reasonOnAccepted = await parseIngestResponse(
    json(200, { results: [{ index: 0, status: "accepted", reason: "already_delivered" }] })
  );
  assert.equal(reasonOnAccepted.result, "accepted");
  assert.equal(reasonOnAccepted.duplicates, undefined);
});

test("a 2xx with an empty, non-JSON or unfamiliar body is still accepted", async () => {
  assert.equal((await parseIngestResponse(new Response("", { status: 200 }))).result, "accepted");
  assert.equal((await parseIngestResponse(new Response("<html>ok</html>", { status: 200 }))).result, "accepted");
  const unfamiliar = await parseIngestResponse(json(200, { status: "queued" }));
  assert.equal(unfamiliar.result, "accepted");
  assert.equal(unfamiliar.duplicates, undefined);
});
