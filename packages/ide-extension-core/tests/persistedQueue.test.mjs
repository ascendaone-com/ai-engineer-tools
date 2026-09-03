import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * The disk-backed queue (issue #51). Before it, three paths lost telemetry
 * silently: a reload or crash while the backend was unreachable, a `stop()`
 * whose final flush failed and was ignored, and a `dispose()` that never went
 * through `stop()` at all.
 *
 * The storage backend is a fake — an in-memory string with write and remove
 * counters — so each test can read back exactly what would be on disk and
 * prove when the disk was, and was not, touched. The transport is the real
 * one from tool-kit with `fetch` replaced, so `accepted` and `duplicate`
 * replies reach the queue the way the server sends them.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The env var would route every payload to a file on the developer's machine.
delete process.env.ASCENDA_EVENT_LOG_FILE;

const vscodeStub = {
  env: { appName: "Visual Studio Code", uriScheme: "vscode" },
  workspace: {
    name: undefined,
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (key, fallback) => {
        // A zero-length after-hours window disables the after-hours twin, so
        // the queue holds exactly what the test tracked.
        if (key === "telemetry.afterHoursStart" || key === "telemetry.afterHoursEnd") return "00:00";
        if (key === "eventLogFile") return "";
        // Every new setting takes its default: the drain gate stays OFF.
        return fallback;
      }
    })
  },
  window: { showWarningMessage: () => undefined }
};

function loadCore() {
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
    const queueStore = require("../out/queueStore.js");
    return { TelemetryService, AscendaApi, queueStore };
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

/** What `FileQueueStorage` would do, minus the disk. */
function fakeStorage(initialText) {
  const storage = {
    text: initialText,
    writes: 0,
    removes: 0,
    read: () => storage.text,
    write: (text) => {
      storage.writes += 1;
      storage.text = text;
    },
    remove: () => {
      storage.removes += 1;
      storage.text = undefined;
    }
  };
  return storage;
}

const onDisk = (storage) => (storage.text === undefined ? undefined : JSON.parse(storage.text));

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
const failing = async () => {
  throw new TypeError("fetch failed");
};
const acceptedAll = (count) => json(200, { accepted: count, duplicate: 0, rejected: 0, results: Array.from({ length: count }, (_, index) => ({ index, status: "accepted" })) });

function service({ pairingOverrides = {}, ...options } = {}) {
  const { TelemetryService, AscendaApi } = loadCore();
  const lines = [];
  const svc = new TelemetryService(new AscendaApi(), pairing(pairingOverrides), { log: (line) => lines.push(line), ...options });
  return { svc, lines };
}

/** A file exactly as a previous session would have left it: a failed flush, then the host went away. */
async function leftBehind(count) {
  const store = fakeStorage();
  const { svc } = service({ store });
  for (let i = 0; i < count; i++) svc.track("ai_file_edit", "low", { activity: "edit", index: i });
  await withFetch(failing, () => svc.flush());
  return { text: store.text, keys: onDisk(store).events.map((e) => e.idempotencyKey) };
}

test("a failed batch is persisted: the payloads exactly as they sit in the queue, keys included", async () => {
  const store = fakeStorage();
  const { svc } = service({ store });
  svc.track("ai_file_edit", "low", { activity: "edit" });
  svc.track("editor_verification_activity", "low", { activity: "test" });

  await withFetch(failing, () => svc.flush());

  assert.equal(store.writes, 1);
  const file = onDisk(store);
  assert.equal(file.version, 1);
  assert.deepEqual(file.events, JSON.parse(JSON.stringify(svc.queue)), "persisted as-is, in queue order");
  for (const event of file.events) assert.match(event.idempotencyKey, UUID_V4);
});

test("the common path never touches disk", async () => {
  const store = fakeStorage();
  const { svc } = service({ store });
  svc.track("ai_file_edit", "low", { activity: "edit" });
  svc.track("editor_verification_activity", "low", { activity: "test" });

  await withFetch(async () => acceptedAll(2), () => svc.flush());

  assert.equal(svc.queue.length, 0);
  assert.equal(store.writes, 0);
  assert.equal(store.text, undefined);
});

test("a delivery confirmed after a failure clears the disk copy, and only then", async () => {
  const store = fakeStorage();
  const { svc } = service({ store });
  svc.track("ai_file_edit", "low", { activity: "edit" });
  svc.track("editor_verification_activity", "low", { activity: "test" });

  await withFetch(failing, () => svc.flush());
  assert.equal(onDisk(store).events.length, 2);

  // A second failure leaves it in place.
  await withFetch(async () => json(503, { error: "unavailable" }), () => svc.flush());
  assert.equal(onDisk(store).events.length, 2);

  await withFetch(async () => acceptedAll(2), () => svc.flush());
  assert.equal(svc.queue.length, 0);
  assert.equal(store.text, undefined, "nothing left to hold, nothing to report: the file is gone");
  assert.equal(store.removes, 1);
});

test("restore then drain: accepted evicts, through the normal flush, and clears the disk copy", async () => {
  const { text, keys } = await leftBehind(2);
  const store = fakeStorage(text);
  const { svc } = service({ store, drainPersistedQueue: true });

  let sent;
  await withFetch(
    async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) };
      return acceptedAll(2);
    },
    () => svc.restore()
  );

  assert.ok(sent.url.endsWith("/v1/tool-events/batch"));
  assert.deepEqual(sent.body.events.map((e) => e.idempotencyKey), keys, "the keys minted in the previous session reach the wire");
  assert.equal(svc.queue.length, 0);
  assert.equal(store.text, undefined);
});

test("restore then drain: batch-door duplicate evicts exactly like accepted", async () => {
  const { text } = await leftBehind(2);
  const store = fakeStorage(text);
  const { svc } = service({ store, drainPersistedQueue: true });

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
    () => svc.restore()
  );

  assert.equal(calls, 1, "a duplicate is not retried");
  assert.equal(svc.queue.length, 0, "the server has it — re-queuing would make the backlog immortal");
  assert.equal(store.text, undefined, "and the disk copy is cleared");
});

test("restore then drain: single-door duplicate evicts exactly like accepted", async () => {
  const { text } = await leftBehind(1);
  const store = fakeStorage(text);
  const { svc } = service({ store, drainPersistedQueue: true });

  let sent;
  await withFetch(
    async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) };
      return json(200, { status: "duplicate" });
    },
    () => svc.restore()
  );

  assert.ok(sent.url.endsWith("/v1/tool-events"));
  assert.match(sent.body.idempotencyKey, UUID_V4);
  assert.equal(svc.queue.length, 0);
  assert.equal(store.text, undefined);
});

test("a restored backlog that fails again stays on disk", async () => {
  const { text, keys } = await leftBehind(2);
  const store = fakeStorage(text);
  const { svc } = service({ store, drainPersistedQueue: true });

  await withFetch(failing, () => svc.restore());

  assert.equal(svc.queue.length, 2);
  assert.deepEqual(onDisk(store).events.map((e) => e.idempotencyKey), keys);
});

test("the drain is off by default: a restored backlog is held on disk, bounded, never sent", async () => {
  const { text, keys } = await leftBehind(2);
  const store = fakeStorage(text);
  const { svc, lines } = service({ store });

  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return acceptedAll(1);
    },
    () => svc.restore()
  );
  assert.equal(calls, 0, "nothing is sent while the gate is off");
  assert.equal(svc.queue.length, 0, "and nothing enters the live queue");
  assert.deepEqual(onDisk(store).events.map((e) => e.idempotencyKey), keys, "still on disk for a session that may send it");
  assert.ok(lines.some((line) => line.includes("Holding 2") && line.includes("drainPersistedQueue")), lines.join("\n"));

  // A failure in this session persists the held backlog ahead of the new one...
  svc.track("ai_file_edit", "low", { activity: "edit" });
  await withFetch(failing, () => svc.flush());
  assert.deepEqual(onDisk(store).events.slice(0, 2).map((e) => e.idempotencyKey), keys);
  assert.equal(onDisk(store).events.length, 3);

  // ...and a delivery of this session's own events leaves the held backlog behind.
  await withFetch(async () => acceptedAll(1), () => svc.flush());
  assert.equal(svc.queue.length, 0);
  assert.deepEqual(onDisk(store).events.map((e) => e.idempotencyKey), keys);
});

test("stop() with a failed final flush leaves the queue on disk instead of ignoring the failure", async () => {
  const store = fakeStorage();
  const { svc } = service({ store });
  svc.track("ai_file_edit", "low", { activity: "edit" });

  await withFetch(failing, () => svc.stop());

  const file = onDisk(store);
  assert.deepEqual(file.events.map((e) => e.eventType), ["ai_file_edit", "recovery_offline_period"], "the session-ended event that stop() itself tracks is kept too");
});

test("dispose() without stop() persists what is queued", () => {
  const store = fakeStorage();
  const { svc } = service({ store });
  svc.track("ai_file_edit", "low", { activity: "edit" });
  svc.track("editor_verification_activity", "low", { activity: "test" });

  svc.dispose();

  assert.equal(onDisk(store).events.length, 2);
});

test("dispose() mid-send persists the batch that was on the wire", async () => {
  const store = fakeStorage();
  const { svc } = service({ store });
  svc.track("ai_file_edit", "low", { activity: "edit" });

  const originalFetch = global.fetch;
  global.fetch = () => new Promise(() => undefined); // the host dies before the server answers
  try {
    const flushing = svc.flush();
    await new Promise((resolve) => setImmediate(resolve)); // let flush() take the batch off the queue
    assert.equal(svc.queue.length, 0, "the batch has left the queue");
    svc.dispose();
    void flushing;
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(onDisk(store).events.length, 1, "in flight is still undelivered");
});

test("a quiet dispose() writes nothing", () => {
  const store = fakeStorage();
  const { svc } = service({ store });
  svc.dispose();
  assert.equal(store.writes, 0);
  assert.equal(store.removes, 0);
});

test("the count bound evicts the oldest, trims the live queue, and writes the loss down", async () => {
  const store = fakeStorage();
  const { svc, lines } = service({ store, maxQueueEntries: 3 });
  for (let i = 0; i < 5; i++) svc.track("ai_file_edit", "low", { activity: "edit", index: i });
  const newest = svc.queue.slice(2).map((e) => e.idempotencyKey);

  await withFetch(failing, () => svc.flush());

  assert.deepEqual(svc.queue.map((e) => e.idempotencyKey), newest, "the live queue is bounded too");
  const file = onDisk(store);
  assert.deepEqual(file.events.map((e) => e.idempotencyKey), newest);
  assert.equal(file.discarded.total, 2);
  assert.equal(file.discarded.lastCount, 2);
  assert.deepEqual(file.discarded.lastReasons, { count: 2 });
  assert.ok(lines.some((line) => line.startsWith("Discarded 2 ") && line.includes("count: 2")), lines.join("\n"));

  // A later delivery keeps the record: the gap is still a gap in the data.
  await withFetch(async () => acceptedAll(3), () => svc.flush());
  assert.equal(svc.queue.length, 0);
  assert.deepEqual(onDisk(store).events, []);
  assert.equal(onDisk(store).discarded.total, 2);
});

test("the age bound on restore discards stale events, and the record accumulates across sessions", async () => {
  const { queueStore } = loadCore();
  const stale = { toolInstallationId: "vscode_extension:test-install", eventType: "ai_file_edit", occurredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), idempotencyKey: "stale-key" };
  const fresh = { ...stale, occurredAt: new Date().toISOString(), idempotencyKey: "fresh-key" };
  const store = fakeStorage(JSON.stringify({
    version: queueStore.PERSISTED_QUEUE_VERSION,
    savedAt: new Date().toISOString(),
    discarded: { total: 4, lastAt: new Date().toISOString(), lastCount: 4, lastReasons: { count: 4 } },
    events: [stale, fresh]
  }));
  const { svc, lines } = service({ store, drainPersistedQueue: true });

  let sent;
  await withFetch(
    async (url, init) => {
      sent = JSON.parse(init.body);
      return json(200, { status: "accepted" });
    },
    () => svc.restore()
  );

  assert.equal(sent.idempotencyKey, "fresh-key", "only the fresh event is re-sent");
  const file = onDisk(store);
  assert.deepEqual(file.events, []);
  assert.equal(file.discarded.total, 5, "4 from the previous session plus this one");
  assert.deepEqual(file.discarded.lastReasons, { age: 1 });
  assert.equal(file.discarded.lastOldestOccurredAt, stale.occurredAt);
  assert.ok(lines.some((line) => line.includes("age: 1") && line.includes("5 discarded in total")), lines.join("\n"));
});

test("an unreadable file is counted as a discard, not thrown", async () => {
  const store = fakeStorage("not json at all");
  const { svc, lines } = service({ store, drainPersistedQueue: true });

  await svc.restore();

  assert.equal(svc.queue.length, 0);
  const file = onDisk(store);
  assert.deepEqual(file.events, []);
  assert.deepEqual(file.discarded.lastReasons, { unreadable: 1 });
  assert.ok(lines.some((line) => line.includes("unreadable: 1")), lines.join("\n"));
});

test("a store that cannot write is logged and the in-memory queue carries on", async () => {
  const store = fakeStorage();
  store.write = () => {
    throw new Error("EROFS: read-only file system");
  };
  const { svc, lines } = service({ store });
  svc.track("ai_file_edit", "low", { activity: "edit" });

  await withFetch(failing, () => svc.flush());

  assert.equal(svc.queue.length, 1);
  assert.ok(lines.some((line) => line.includes("Could not persist 1") && line.includes("EROFS")), lines.join("\n"));
});

test("without a store the service is memory-only, exactly as before", async () => {
  const { svc } = service();
  svc.track("ai_file_edit", "low", { activity: "edit" });
  await withFetch(failing, () => svc.flush());
  assert.equal(svc.queue.length, 1);
  await svc.restore();
  svc.dispose();
});
