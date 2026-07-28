const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseIngestResponse, AscendaApiError } = require("../out/index.js");

// parseIngestResponse is the single place that decides how every producer reacts
// to a rejected event: give up, re-pair, drop, or surface. Getting a branch wrong
// is silent — the tool keeps running and the events stop arriving — so each
// status the API contract defines is pinned here.

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("2xx is accepted", async () => {
  assert.equal(await parseIngestResponse(new Response("", { status: 200 })), "accepted");
  assert.equal(await parseIngestResponse(new Response("", { status: 202 })), "accepted");
});

test("401 is auth_failed — token invalid or revoked, re-pair", async () => {
  assert.equal(await parseIngestResponse(json(401, { error: "unauthorized" })), "auth_failed");
});

test("403 + consent_missing_or_expired is consent_missing, not a hard failure", async () => {
  const r = json(403, { error: "consent_missing_or_expired" });
  assert.equal(await parseIngestResponse(r), "consent_missing");
});

test("403 with any other error code throws rather than being mistaken for consent", async () => {
  // A forbidden-for-some-other-reason must not be swallowed as a consent lapse,
  // which producers treat as recoverable.
  await assert.rejects(() => parseIngestResponse(json(403, { error: "forbidden" })), AscendaApiError);
});

test("400 and 422 are validation_failed — the payload is wrong, retrying will not help", async () => {
  assert.equal(await parseIngestResponse(json(400, { error: "bad_request" })), "validation_failed");
  assert.equal(await parseIngestResponse(json(422, { error: "unprocessable" })), "validation_failed");
});

test("5xx throws AscendaApiError carrying the status", async () => {
  await assert.rejects(
    () => parseIngestResponse(json(500, { error: "server_error" })),
    (e) => e instanceof AscendaApiError && e.status === 500
  );
});

test("a non-JSON error body does not crash the parser", async () => {
  // Gateways and proxies return HTML, not JSON. The errorCode lookup must fail
  // soft, and status-based branches must still work.
  const html = new Response("<html>502 Bad Gateway</html>", { status: 401 });
  assert.equal(await parseIngestResponse(html), "auth_failed");
  await assert.rejects(
    () => parseIngestResponse(new Response("<html>oops</html>", { status: 502 })),
    AscendaApiError
  );
});
