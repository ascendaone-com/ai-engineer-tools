import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "../dist/server.js";
// Same discipline as contract-flow.test.mjs: drive the real kit client (what
// `join` itself calls) against the mock server, end to end.
import kit from "@ascenda-one/tool-kit";
const { createPairingSession, getPairingStatus, startStudyJoin, getStudyJoinStatus, AscendaApiError } = kit;

let base;
let devServer;
let token;
const silent = () => {};

before(async () => {
  // Pairing auto-confirms (the easy setup every suite here uses); study-join
  // sessions do not, so `confirmed` / `expired` / `refused` can each be
  // driven deliberately rather than racing a timer.
  devServer = createDevServer({ autoConfirm: true, autoConfirmJoins: false, log: silent });
  await new Promise((resolve) => devServer.server.listen(0, resolve));
  base = `http://localhost:${devServer.server.address().port}`;

  const session = await createPairingSession(base, "cli_agent:study-join-test", "cli_agent", "Integration Test");
  token = (await getPairingStatus(base, session.pairingSessionId)).eventWriteToken;
});

after(() => devServer.server.close());

test("start returns the organisation, the study and every grant Report mode carries", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  assert.equal(start.organisationName, "Northview Health");
  assert.equal(start.studyKind, "Autonomy at Work");
  assert.ok(Date.parse(start.windowStartUtc) < Date.parse(start.windowEndUtc));
  assert.ok(Array.isArray(start.grants) && start.grants.length === 2);
  for (const grant of start.grants) {
    assert.equal(typeof grant.code, "number");
    assert.equal(typeof grant.name, "string");
  }
  assert.match(start.joinSessionId, /^[0-9a-f-]{36}$/);
  assert.match(start.deviceCode, /^\d{6}$/);
  assert.ok(Date.parse(start.expiresAt) > Date.now());

  // Nothing is granted yet — autoConfirmJoins is off, so the session sits
  // pending until something confirms it, exactly as a real backend's session
  // would sit unconfirmed until a person acts on a signed-in surface.
  const pending = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(pending.status, "pending");
  assert.equal(pending.granted, null);
  assert.equal(pending.refusedReason, null);
});

test("confirming (standing in for the app) grants exactly what start named", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  const res = await fetch(`${base}/v1/org-study-join-sessions/confirm-device-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer irrelevant-here" },
    body: JSON.stringify({ deviceCode: start.deviceCode })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "confirmed");
  assert.deepEqual(body.granted, start.grants);

  const confirmed = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(confirmed.status, "confirmed");
  assert.deepEqual(confirmed.granted, start.grants);
  assert.equal(confirmed.refusedReason, null);
});

test("confirming an unrecognised device code is invalid_or_expired, not a crash", async () => {
  const res = await fetch(`${base}/v1/org-study-join-sessions/confirm-device-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer irrelevant-here" },
    body: JSON.stringify({ deviceCode: "000000" })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_or_expired");
});

test("refusal carries the enum reason the status poll reports back", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  const res = await fetch(`${base}/_dev/org-study-join-sessions/${start.joinSessionId}/refuse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "wrong_user" })
  });
  assert.equal(res.status, 200);

  const refused = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(refused.status, "refused");
  assert.equal(refused.granted, null);
  assert.equal(refused.refusedReason, "wrong_user");
});

test("refusal defaults to study_no_longer_live when no reason is given", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  await fetch(`${base}/_dev/org-study-join-sessions/${start.joinSessionId}/refuse`, { method: "POST" });
  const refused = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(refused.refusedReason, "study_no_longer_live");
});

test("an unconfirmed session expires lazily, with no reason of its own", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  // The mock has no time-travel knob; back-date the session directly rather
  // than waiting out the real 10-minute window.
  devServer.state.studyJoins.get(start.joinSessionId).expiresAt = new Date(Date.now() - 1000).toISOString();

  const expired = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(expired.status, "expired");
  assert.equal(expired.granted, null);
  assert.equal(expired.refusedReason, null);
});

test("an unknown join code is refused before any session exists", async () => {
  await assert.rejects(
    () => startStudyJoin(base, token, "NOT-A-REAL-CODE", "report"),
    (error) => error instanceof AscendaApiError && error.status === 404 && error.errorCode === "join_code_not_found"
  );
});

test("a mode other than report is refused — it is the only one this door accepts", async () => {
  await assert.rejects(
    () => startStudyJoin(base, token, "NORTHVIEW-2026", "study"),
    (error) => error instanceof AscendaApiError && error.status === 400 && error.errorCode === "unknown_mode"
  );
});

test("a revoked or unpaired tool cannot start a join", async () => {
  await assert.rejects(
    () => startStudyJoin(base, "not-a-real-token", "NORTHVIEW-2026", "report"),
    (error) => error instanceof AscendaApiError && error.status === 401
  );
});

test("status on an unknown session is not_found, not a crash", async () => {
  await assert.rejects(
    () => getStudyJoinStatus(base, token, "00000000-0000-0000-0000-000000000000"),
    (error) => error instanceof AscendaApiError && error.status === 404
  );
});
