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
  assert.equal(start.studyKind, "Report30");
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
  assert.equal((await res.json()).error, "invalid_or_expired");
});

test("refusal carries the enum reason the status poll reports back", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  const res = await fetch(`${base}/_dev/org-study-join-sessions/${start.joinSessionId}/refuse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "withdrawn" })
  });
  assert.equal(res.status, 200);

  const refused = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(refused.status, "refused");
  assert.equal(refused.granted, null);
  assert.equal(refused.refusedReason, "withdrawn");
});

test("declined and not_enrolled are both distinct, real refusal reasons", async () => {
  for (const reason of ["declined", "not_enrolled"]) {
    const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
    await fetch(`${base}/_dev/org-study-join-sessions/${start.joinSessionId}/refuse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason })
    });
    const refused = await getStudyJoinStatus(base, token, start.joinSessionId);
    assert.equal(refused.status, "refused");
    assert.equal(refused.granted, null);
    assert.equal(refused.refusedReason, reason);
  }
});

test("refusal defaults to study_no_longer_live when no reason is given", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  await fetch(`${base}/_dev/org-study-join-sessions/${start.joinSessionId}/refuse`, { method: "POST" });
  const refused = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(refused.refusedReason, "study_no_longer_live");
});

test("grant_failed carries whatever partial grant list actually landed", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  const historicalImport = start.grants.find((g) => g.name === "HistoricalImport");
  await fetch(`${base}/_dev/org-study-join-sessions/${start.joinSessionId}/refuse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "grant_failed", grantedCodes: [historicalImport.code] })
  });

  const status = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(status.status, "refused");
  assert.equal(status.refusedReason, "grant_failed");
  assert.deepEqual(status.granted, [historicalImport]);
});

test("grant_failed with nothing landed carries a null granted list", async () => {
  const start = await startStudyJoin(base, token, "NORTHVIEW-2026", "report");
  await fetch(`${base}/_dev/org-study-join-sessions/${start.joinSessionId}/refuse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "grant_failed" })
  });

  const status = await getStudyJoinStatus(base, token, start.joinSessionId);
  assert.equal(status.refusedReason, "grant_failed");
  assert.equal(status.granted, null, "nothing landing is null, not an empty array");
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

test("a code with nothing live to join (e.g. department-scoped) is a distinct 404", async () => {
  await assert.rejects(
    () => startStudyJoin(base, token, "DEPT-ONLY-2026", "report"),
    (error) => error instanceof AscendaApiError && error.status === 404 && error.errorCode === "no_live_study"
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

test("git: offered unticked on start, chosen on confirm, reported in importStores, and enforced at ingest", async () => {
  // Its own server: the git grant is account-wide state the tests above shouldn't see.
  const dev = createDevServer({ autoConfirm: true, autoConfirmJoins: false, historicalImportLease: false, log: silent });
  await new Promise((resolve) => dev.server.listen(0, resolve));
  const url = `http://localhost:${dev.server.address().port}`;
  try {
    const session = await createPairingSession(url, "claude_code:git-offer", "claude_code", "Git Offer Test");
    const tool = (await getPairingStatus(url, session.pairingSessionId)).eventWriteToken;
    const confirm = (deviceCode, includeGit) =>
      fetch(`${url}/v1/org-study-join-sessions/confirm-device-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer person" },
        body: JSON.stringify({ deviceCode, ...(includeGit === undefined ? {} : { includeGit }) })
      });
    const commit = { eventType: "editor_activity", source: "code_forge", provenance: "historical_direct", severity: "info", occurredAt: "2026-10-01T09:00:00.000Z", metadata: { importKey: "c1" } };
    const ship = async () => (await (await fetch(`${url}/v1/tool-events/batch`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tool}` }, body: JSON.stringify({ events: [commit] }) })).json()).results[0];

    const first = await startStudyJoin(url, tool, "NORTHVIEW-2026", "report");
    assert.deepEqual(first.optionalImportStores, ["git"]);
    assert.equal((await getStudyJoinStatus(url, tool, first.joinSessionId)).importStores, null, "nothing granted while pending");

    // Left unticked: the import is granted, git isn't, and ingest says so.
    await confirm(first.deviceCode);
    const without = await getStudyJoinStatus(url, tool, first.joinSessionId);
    assert.ok(Array.isArray(without.importStores) && !without.importStores.includes("git"));
    assert.deepEqual(await ship(), { index: 0, status: "rejected", reason: "consent_source_not_granted" });

    // Ticked on a second join: the grant is the account's, so the first session reads it too.
    const second = await startStudyJoin(url, tool, "NORTHVIEW-2026", "report");
    await confirm(second.deviceCode, true);
    assert.ok((await getStudyJoinStatus(url, tool, second.joinSessionId)).importStores.includes("git"));
    assert.ok((await getStudyJoinStatus(url, tool, first.joinSessionId)).importStores.includes("git"));
    assert.equal((await ship()).status, "accepted");
  } finally {
    dev.server.close();
  }
});
