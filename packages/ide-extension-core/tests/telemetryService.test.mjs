import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * TelemetryService is the IDE's queue, and the idempotencyKey (issues #50 /
 * #51; backend asc-core-be#141) only works for that queue if it is minted in
 * track() — when the payload enters `queue` — and never in flush(). Every
 * failure path in flush() unshifts the same objects back, so a key minted at
 * track time survives every re-queue unchanged; a key minted at flush time
 * would be re-invented per attempt and dedupe nothing.
 *
 * `vscode` only exists inside an extension host, so it is stubbed. The
 * transport is the real one from tool-kit with `fetch` replaced, so a
 * `duplicate` reply is exercised end to end: server body -> parser ->
 * AscendaApi -> flush() eviction.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The env var would route every payload to a file on the developer's machine.
delete process.env.ASCENDA_EVENT_LOG_FILE;

const vscodeStub = {
  env: { appName: "Visual Studio Code", uriScheme: "vscode" },
  workspace: {
    // Undefined name and folders: no salt file is read or created, and no
    // filesystem walk happens for a project hash.
    name: undefined,
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (key, fallback) => {
        // A zero-length after-hours window disables the after-hours twin, so
        // the queue holds exactly what the test tracked.
        if (key === "telemetry.afterHoursStart" || key === "telemetry.afterHoursEnd") return "00:00";
        if (key === "eventLogFile") return "";
        return fallback;
      }
    })
  },
  window: { showWarningMessage: () => undefined }
};

function loadTelemetryService() {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return vscodeStub;
    return original.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes("ide-extension-core")) delete require.cache[key];
    }
    const { TelemetryService } = require("../out/telemetryService.js");
    const { AscendaApi } = require("../out/ascendaApi.js");
    return { TelemetryService, AscendaApi };
  } finally {
    Module._load = original;
  }
}

function pairing(overrides = {}) {
  return {
    getToolInstallationId: () => "vscode_extension:test-install",
    isPaired: () => true,
    ensureEventWriteToken: async () => "token-1",
    handleAuthFailure: async () => null,
    ...overrides
  };
}

function withFetch(fetchImpl, run) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      global.fetch = originalFetch;
    });
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function service(overrides) {
  const { TelemetryService, AscendaApi } = loadTelemetryService();
  return new TelemetryService(new AscendaApi(), pairing(overrides));
}

test("track() mints a top-level idempotencyKey as the event enters the queue", () => {
  const svc = service();
  svc.track("ai_file_edit", "low", { activity: "edit" });
  svc.track("editor_verification_activity", "low", { activity: "test" });

  assert.equal(svc.queue.length, 2);
  for (const payload of svc.queue) {
    assert.match(payload.idempotencyKey, UUID_V4);
    assert.ok(payload.idempotencyKey.length <= 128);
    assert.equal(payload.metadata.idempotencyKey, undefined, "top-level, not in metadata");
  }
  assert.notEqual(svc.queue[0].idempotencyKey, svc.queue[1].idempotencyKey);
});

test("a re-queued batch keeps its keys: the same objects go back, and the next flush resends them", async () => {
  const svc = service();
  svc.track("ai_file_edit", "low", { activity: "edit" });
  svc.track("editor_verification_activity", "low", { activity: "test" });
  const before = svc.queue.map((p) => p);
  const keys = before.map((p) => p.idempotencyKey);

  // 1. A network failure — the transport returns transport_error, flush()
  //    unshifts the batch. Object identity and keys must survive.
  await withFetch(
    async () => {
      throw new TypeError("fetch failed");
    },
    () => svc.flush()
  );
  assert.equal(svc.queue.length, 2);
  assert.deepEqual(svc.queue.map((p) => p.idempotencyKey), keys);
  assert.ok(svc.queue.every((p, i) => p === before[i]), "the same payload objects, not copies");

  // 2. A 401 with no recoverable token — the auth_failed path unshifts too.
  await withFetch(async () => json(401, { error: "unauthorized" }), () => svc.flush());
  assert.equal(svc.queue.length, 2);
  assert.deepEqual(svc.queue.map((p) => p.idempotencyKey), keys);

  // 3. A 5xx — the "not accepted" path.
  await withFetch(async () => json(503, { error: "unavailable" }), () => svc.flush());
  assert.equal(svc.queue.length, 2);
  assert.deepEqual(svc.queue.map((p) => p.idempotencyKey), keys);

  // 4. Delivery. The keys that reach the wire are the ones minted in track(),
  //    three failed flushes ago.
  let sent;
  await withFetch(
    async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) };
      return json(200, { accepted: 2, duplicate: 0, rejected: 0, results: [{ index: 0, status: "accepted" }, { index: 1, status: "accepted" }] });
    },
    () => svc.flush()
  );
  assert.ok(sent.url.endsWith("/v1/tool-events/batch"));
  assert.deepEqual(sent.body.events.map((e) => e.idempotencyKey), keys);
  assert.equal(svc.queue.length, 0);
});

test("batch door: per-item status duplicate evicts the batch exactly like accepted", async () => {
  const svc = service();
  svc.track("ai_file_edit", "low", { activity: "edit" });
  svc.track("editor_verification_activity", "low", { activity: "test" });

  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return json(200, {
        accepted: 0,
        duplicate: 2,
        rejected: 0,
        results: [
          { index: 0, status: "duplicate", reason: "already_delivered" },
          { index: 1, status: "duplicate", reason: "already_delivered" }
        ]
      });
    },
    () => svc.flush()
  );
  assert.equal(calls, 1, "a duplicate is not retried");
  assert.equal(svc.queue.length, 0, "a duplicate is on the server — re-queuing it would make the backlog immortal");
});

test("single door: status duplicate evicts the event exactly like accepted", async () => {
  const svc = service();
  svc.track("ai_file_edit", "low", { activity: "edit" });

  let sent;
  await withFetch(
    async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) };
      return json(200, { status: "duplicate" });
    },
    () => svc.flush()
  );
  assert.ok(sent.url.endsWith("/v1/tool-events"));
  assert.match(sent.body.idempotencyKey, UUID_V4);
  assert.equal(svc.queue.length, 0);
});
