import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "../dist/server.js";
// The point of this suite: drive the REAL kit client (the code every tool
// ships) against the mock server, end to end - a local stand-in for the
// Azure Dev happy-path verification.
import kit from "@ascenda-one/tool-kit";
const { createPairingSession, getPairingStatus, postToolEvent, postToolEventsBatch, renewToolToken } = kit;

let base;
let devServer;
const silent = () => {};

before(async () => {
  devServer = createDevServer({ autoConfirm: true, log: silent });
  await new Promise((resolve) => devServer.server.listen(0, resolve));
  base = `http://localhost:${devServer.server.address().port}`;
});

after(() => devServer.server.close());

const event = (overrides = {}) => ({
  toolInstallationId: "cli_agent:it-test",
  source: "claude_code",
  eventType: "ai_prompt_submitted",
  occurredAt: new Date().toISOString(),
  severity: "low",
  consentScope: "ide_telemetry",
  provenance: "ai_work_telemetry",
  privacyMode: "metadata_only",
  metadata: {},
  ...overrides
});

test("full contract flow: pair -> ingest -> renew -> revoke -> 401", async () => {
  // pair (auto-confirm): token arrives on first status poll only
  const session = await createPairingSession(base, "cli_agent:it-test", "cli_agent", "Integration Test");
  assert.match(session.code, /^\d{6}$/);
  const status1 = await getPairingStatus(base, session.pairingSessionId);
  assert.equal(status1.status, "paired");
  assert.ok(status1.eventWriteToken, "first poll carries the token");
  const status2 = await getPairingStatus(base, session.pairingSessionId);
  assert.equal(status2.eventWriteToken, null, "second poll must not re-issue the token");

  const token = status1.eventWriteToken;

  // single + batch ingest
  assert.equal(await postToolEvent(base, token, event()), "accepted");
  assert.equal(await postToolEventsBatch(base, token, [event(), event({ eventType: "compile_error", severity: "medium" })]), "accepted");
  assert.equal(devServer.state.events.length, 3);
  assert.equal(devServer.state.events[2].category, "risk", "category derived from the contract map");

  // renew rotates; old token now rejected, new accepted
  const renewed = await renewToolToken(base, token);
  assert.ok(renewed.eventWriteToken.startsWith("devtok_"));
  assert.equal(await postToolEvent(base, token, event()), "auth_failed", "old token rejected after rotation");
  assert.equal(await postToolEvent(base, renewed.eventWriteToken, event()), "accepted");

  // revoke: ingest and renew both 401 (renewToolToken returns null per contract)
  const res = await fetch(`${base}/v1/connected-tools/${encodeURIComponent("cli_agent:it-test")}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(await postToolEvent(base, renewed.eventWriteToken, event()), "auth_failed");
  assert.equal(await renewToolToken(base, renewed.eventWriteToken), null);
});

test("consent lease: expiry pauses ingest with consent_missing, renewal resumes", async () => {
  const session = await createPairingSession(base, "cli_agent:consent-test", "cli_agent", null);
  const token = (await getPairingStatus(base, session.pairingSessionId)).eventWriteToken;

  await fetch(`${base}/_dev/consent`, { method: "POST", body: JSON.stringify({ active: false }) });
  assert.equal(await postToolEvent(base, token, event({ toolInstallationId: "cli_agent:consent-test" })), "consent_missing");
  await fetch(`${base}/_dev/consent`, { method: "POST", body: JSON.stringify({ active: true }) });
  assert.equal(await postToolEvent(base, token, event({ toolInstallationId: "cli_agent:consent-test" })), "accepted");
});

test("unknown event types are accepted but tagged unclassified", async () => {
  const session = await createPairingSession(base, "cli_agent:drift-test", "cli_agent", null);
  const token = (await getPairingStatus(base, session.pairingSessionId)).eventWriteToken;
  const before = devServer.state.unclassified;
  assert.equal(await postToolEvent(base, token, event({ toolInstallationId: "cli_agent:drift-test", eventType: "made_up_event" })), "accepted");
  assert.equal(devServer.state.unclassified, before + 1, "drift is visible, not rejected");
});

test("unknown toolType is rejected at pairing with 400", async () => {
  await assert.rejects(
    () => createPairingSession(base, "x:1", "not_a_tool", null),
    (error) => error.name === "AscendaApiError" && error.status === 400
  );
});
