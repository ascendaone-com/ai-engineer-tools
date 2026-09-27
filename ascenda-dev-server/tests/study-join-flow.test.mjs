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
  assert.equal(start.studyTitle, "Autonomy at Work");
  assert.ok(start.studyWindow.length > 0);
  assert.ok(Array.isArray(start.grants) && start.grants.length > 0);
  assert.match(start.joinSessionId, /^[0-9a-f-]{36}$/);
  assert.match(start.shortCode, /^\d{6}$/);
  assert.ok(Date.parse(start.expiresAt) > Date.now());

  // Nothing is granted yet — autoConfirmJoins is off, so the session sits
  // pending until something confirms it, exactly as a real backend's session
  // would sit unconfirmed until a person acts on a signed-in surface.
  const pending = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(pending.status, "pending");
  assert.equal(pending.grants, null);
  assert.equal(pending.reason, null);
});

test("confirming (standing in for the app or the pairing page) grants what start named", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  const res = await fetch(`${base}/v1/org-study-joins/${start.joinSessionId}/confirm`, {
    method: "POST",
    headers: { Authorization: "Bearer irrelevant-here" }
  });
  assert.equal(res.status, 200);

  const confirmed = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(confirmed.status, "confirmed");
  assert.deepEqual(confirmed.grants, start.grants);
  assert.equal(confirmed.reason, null);
});

test("refusal (a person declining on the confirming device) carries a plain-words reason", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  const res = await fetch(`${base}/_dev/org-study-joins/${start.joinSessionId}/refuse`, { method: "POST" });
  assert.equal(res.status, 200);

  const refused = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(refused.status, "refused");
  assert.equal(refused.grants, null);
  assert.ok(refused.reason && !/error|code/i.test(refused.reason), "a person-facing sentence, not a wire code");
});

test("an unconfirmed session expires lazily, with its own plain-words reason", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  // The mock has no time-travel knob; back-date the session directly rather
  // than waiting out the real 10-minute window.
  devServer.state.studyJoins.get(start.joinSessionId).expiresAt = new Date(Date.now() - 1000).toISOString();

  const expired = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(expired.status, "expired");
  assert.equal(expired.grants, null);
  assert.ok(expired.reason && expired.reason.length > 0);
});

test("an unknown join code is refused before any session exists", async () => {
  await assert.rejects(
    () => startStudyJoin(base, token, "NOT-A-REAL-CODE", "report"),
    (error) => error instanceof AscendaApiError && error.status === 404 && error.errorCode === "unknown_join_code"
  );
});

test("a mode other than report is refused — it is the only one this door accepts", async () => {
  await assert.rejects(
    () => startStudyJoin(base, token, "NORTHVIEW-2026", "study"),
    (error) => error instanceof AscendaApiError && error.status === 400 && error.errorCode === "unsupported_mode"
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
