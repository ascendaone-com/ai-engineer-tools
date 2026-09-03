const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// The journal and outbox default to ~/.ascenda/state; redirect before anything
// is constructed so a test run can never fabricate a pairing on this machine.
process.env.ASCENDA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-outbox-state-"));
delete process.env.ASCENDA_OUTBOX_DRAIN;

const assert = require("node:assert/strict");
const kit = require("../out/index.js");
const {
  AscendaEventSender,
  appendToOutbox,
  readOutboxSummary,
  readCollectorState,
  recordOutboxDiscard,
  recordSendOutcome,
  parseIngestResponse,
  outboxDrainEnabled
} = kit;

// The gap this closes: the live send retries once after 250 ms and then the
// payload went out of scope. Anything longer than a blip — sleep, VPN, a
// restarting instance — lost the event with no copy anywhere. The outbox is
// where a refused event now waits, and these pin the four properties the
// issue asks for: it is written unconditionally, drained on the next
// invocation on `status` alone, bounded with every eviction journaled, and
// safe under overlapping hook processes.

const ID = "claude_code:outbox-test";

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-outbox-"));
  return {
    dir,
    state: path.join(dir, "state.json"),
    outbox: path.join(dir, "outbox.jsonl"),
    token: path.join(dir, "token"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const status = (code, body = "") => new Response(body, { status: code });

/**
 * A fetch stub routed by door. Records every request so a test can say which
 * door was knocked on, how often, and with what.
 */
function stubFetch(routes) {
  const calls = { single: [], batch: [], renew: [] };
  const impl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (String(url).endsWith("/v1/tool-events/batch")) {
      calls.batch.push(body);
      return routes.batch ? routes.batch(body, calls.batch.length) : status(500, "no batch route");
    }
    if (String(url).endsWith("/v1/tool-events/renew-token")) {
      calls.renew.push(body);
      return routes.renew ? routes.renew() : status(401);
    }
    calls.single.push(body);
    return routes.single ? routes.single(body, calls.single.length) : status(500, "no single route");
  };
  return { impl, calls };
}

function makeSender(fetchImpl, files, overrides = {}) {
  const original = global.fetch;
  global.fetch = fetchImpl;
  const instance = new AscendaEventSender({
    apiBaseUrl: "https://api.example.test",
    toolInstallationId: ID,
    source: "claude_code",
    eventWriteToken: "tok_1",
    tokenFilePath: files.token,
    stateFilePath: files.state,
    outboxFilePath: files.outbox,
    eventLogFile: null,
    timeoutMs: 2_000,
    outboxDrain: false,
    ...overrides
  });
  return { instance, restore: () => (global.fetch = original) };
}

function payload(key, queuedAt = new Date().toISOString()) {
  return {
    queuedAt,
    payload: {
      toolInstallationId: ID,
      source: "claude_code",
      eventType: "ai_tool_call_completed",
      occurredAt: queuedAt,
      idempotencyKey: key,
      severity: "low",
      consentScope: "ide_telemetry",
      provenance: "ai_work_telemetry",
      privacyMode: "metadata_only",
      metadata: {}
    }
  };
}

function seed(outboxFile, entries) {
  fs.mkdirSync(path.dirname(outboxFile), { recursive: true });
  fs.appendFileSync(outboxFile, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

function readOutbox(outboxFile) {
  if (!fs.existsSync(outboxFile)) return [];
  return fs.readFileSync(outboxFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a refused event lands in the outbox carrying the key it was sent with", async () => {
  const files = scratch();
  const { impl, calls } = stubFetch({ single: () => status(503, "upstream restarting") });
  const { instance, restore } = makeSender(impl, files);
  try {
    const result = await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.equal(result, "transport_error", "the verdict is unchanged: the caller still learns it did not go");
    assert.equal(calls.single.length, 2, "one retry, as before — anything longer is the outbox's job");

    const queued = readOutbox(files.outbox);
    assert.equal(queued.length, 1, "the payload must be on disk, not out of scope");
    assert.equal(queued[0].payload.idempotencyKey, calls.single[0].idempotencyKey, "the same key both attempts carried");
    assert.equal(queued[0].payload.idempotencyKey, calls.single[1].idempotencyKey);
    assert.ok(queued[0].queuedAt, "the age bound needs to know when it was queued");

    const journal = readCollectorState(files.state);
    assert.equal(journal.lastOutcome, "transport_error");
    assert.match(journal.detail, /queued in outbox/, "the journal says the event was kept, not lost");
    if (process.platform !== "win32") assert.equal(fs.statSync(files.outbox).mode & 0o777, 0o600, "owner-only, like the journal");
  } finally {
    restore();
    files.cleanup();
  }
});

test("a network-level failure (fetch throws) is queued too", async () => {
  const files = scratch();
  const { instance, restore } = makeSender(async () => { throw new TypeError("fetch failed"); }, files);
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.equal(readOutbox(files.outbox).length, 1);
  } finally {
    restore();
    files.cleanup();
  }
});

test("a verdict is never queued — replaying it cannot change the answer", async () => {
  const files = scratch();
  const { impl } = stubFetch({ single: () => status(400, JSON.stringify({ error: "bad_request" })) });
  const { instance, restore } = makeSender(impl, files);
  try {
    assert.equal(await instance.send({ eventType: "ai_tool_call_completed", severity: "low" }), "validation_failed");
    assert.equal(fs.existsSync(files.outbox), false);
  } finally {
    restore();
    files.cleanup();
  }
});

test("the outbox is written whether or not an event log is configured", async () => {
  // The two sinks answer different questions. The event log is an opt-in
  // debugging aid; the outbox is not, and must not inherit its gate.
  const files = scratch();
  const previous = process.env.ASCENDA_EVENT_LOG_FILE;
  delete process.env.ASCENDA_EVENT_LOG_FILE;
  const { impl } = stubFetch({ single: () => status(503) });
  const { instance, restore } = makeSender(impl, files, { eventLogFile: undefined });
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.equal(readOutbox(files.outbox).length, 1);
  } finally {
    restore();
    if (previous !== undefined) process.env.ASCENDA_EVENT_LOG_FILE = previous;
    files.cleanup();
  }
});

test("drain deletes on accepted and on duplicate, deciding on status alone", async () => {
  const files = scratch();
  const t0 = "2026-09-01T00:00:00.000Z";
  const t1 = "2026-09-01T00:00:01.000Z";
  seed(files.outbox, [payload("key-old", t0), payload("key-new", t1)]);

  const { impl, calls } = stubFetch({
    batch: () => ok({
      accepted: 1,
      duplicate: 1,
      rejected: 0,
      results: [
        { index: 0, status: "accepted" },
        // `reason` deliberately unfamiliar: the branch must be on status.
        { index: 1, status: "duplicate", reason: "something_the_server_made_up" }
      ]
    }),
    single: () => ok({ status: "accepted" })
  });
  const { instance, restore } = makeSender(impl, files, { outboxDrain: true });
  try {
    assert.equal(await instance.send({ eventType: "ai_tool_call_completed", severity: "low" }), "accepted");

    assert.equal(calls.batch.length, 1, "exactly one batch per invocation");
    assert.deepEqual(calls.batch[0].events.map((e) => e.idempotencyKey), ["key-old", "key-new"], "oldest first, keys intact");
    assert.equal(readOutbox(files.outbox).length, 0, "both confirmed on the server, both gone from disk");
    assert.equal(fs.readdirSync(files.dir).filter((n) => n.includes(".draining")).length, 0, "no claim file left behind");
    assert.equal(instance.drain.delivered, 2);
    assert.equal(instance.drain.remaining, 0);
    assert.equal(calls.single.length, 1, "the live event still went through its own door");
  } finally {
    restore();
    files.cleanup();
  }
});

test("drain halts on a retryable failure, keeps the remainder, and the live event joins the queue without a second knock", async () => {
  const files = scratch();
  seed(files.outbox, [payload("a"), payload("b"), payload("c")]);
  const { impl, calls } = stubFetch({ batch: () => status(503, "still down") });
  const { instance, restore } = makeSender(impl, files, { outboxDrain: true });
  try {
    assert.equal(await instance.send({ eventType: "ai_tool_call_completed", severity: "low" }), "transport_error");

    assert.equal(calls.batch.length, 1, "no backoff loop");
    assert.equal(calls.single.length, 0, "the door just refused; knocking again buys latency, not delivery");
    const queued = readOutbox(files.outbox).map((e) => e.payload.idempotencyKey);
    assert.equal(queued.length, 4, "the three that were there plus the live event");
    assert.ok(["a", "b", "c"].every((k) => queued.includes(k)), "nothing deleted before the server confirmed it");
    assert.equal(instance.drain.halted, "transport_error");
    assert.equal(instance.drain.remaining, 3);

    const journal = readCollectorState(files.state);
    assert.equal(journal.consecutiveFailures, 1, "one outage costs one failure per hook, not two");
    assert.match(journal.detail, /queued in outbox/);
  } finally {
    restore();
    files.cleanup();
  }
});

test("drain sends one bounded batch per invocation and leaves the rest for next time", async () => {
  const files = scratch();
  seed(files.outbox, ["a", "b", "c", "d", "e"].map((k, i) => payload(k, `2026-09-01T00:00:0${i}.000Z`)));
  const { impl, calls } = stubFetch({
    batch: (body) => ok({ results: body.events.map((_, index) => ({ index, status: "accepted" })) }),
    single: () => ok({ status: "accepted" })
  });
  const { instance, restore } = makeSender(impl, files, { outboxDrain: true, outboxDrainBatchSize: 2 });
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.deepEqual(calls.batch[0].events.map((e) => e.idempotencyKey), ["a", "b"], "the two oldest");
    assert.deepEqual(readOutbox(files.outbox).map((e) => e.payload.idempotencyKey).sort(), ["c", "d", "e"]);

    // A second send on the same sender does not drain again: one pass per process.
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.equal(calls.batch.length, 1);
  } finally {
    restore();
    files.cleanup();
  }
});

test("with the drain off, nothing is sent from the outbox and the queue is kept — but the bounds still apply", async () => {
  // The flag exists because a drain against an ingest door that does not
  // dedupe on idempotencyKey would land every queued event a second time.
  const files = scratch();
  seed(files.outbox, [payload("a"), payload("b"), payload("c")]);
  const { impl, calls } = stubFetch({ single: () => ok({ status: "accepted" }) });
  const { instance, restore } = makeSender(impl, files, { outboxDrain: false, outboxMaxEntries: 2 });
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.equal(calls.batch.length, 0, "gated");
    assert.equal(instance.drain.sendEnabled, false);
    assert.equal(readOutbox(files.outbox).length, 2, "the count bound evicted one even though nothing was sent");
    assert.equal(readCollectorState(files.state).outboxDiscarded.total, 1, "and said so");
  } finally {
    restore();
    files.cleanup();
  }
});

test("the flag defaults to off and reads the environment", () => {
  assert.equal(outboxDrainEnabled({}), false);
  assert.equal(outboxDrainEnabled({ ASCENDA_OUTBOX_DRAIN: "" }), false);
  assert.equal(outboxDrainEnabled({ ASCENDA_OUTBOX_DRAIN: "false" }), false);
  assert.equal(outboxDrainEnabled({ ASCENDA_OUTBOX_DRAIN: "true" }), true);
  assert.equal(outboxDrainEnabled({ ASCENDA_OUTBOX_DRAIN: "1" }), true);
});

test("bound eviction by count is journaled with its own outcome, never a silent truncation", async () => {
  const files = scratch();
  seed(files.outbox, ["a", "b", "c", "d", "e"].map((k, i) => payload(k, `2026-09-01T00:00:0${i}.000Z`)));
  const { impl } = stubFetch({ single: () => status(503) });
  const { instance, restore } = makeSender(impl, files, { outboxMaxEntries: 3 });
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });

    const kept = readOutbox(files.outbox).map((e) => e.payload.idempotencyKey);
    assert.ok(!kept.includes("a") && !kept.includes("b"), "the two oldest were evicted");
    assert.equal(kept.length, 4, "three kept plus the live event that just failed");

    const journal = readCollectorState(files.state);
    assert.equal(journal.outboxDiscarded.total, 2);
    assert.equal(journal.outboxDiscarded.lastCount, 2);
    assert.deepEqual(journal.outboxDiscarded.lastReasons, { count: 2 });
    assert.equal(journal.outboxDiscarded.lastOldestQueuedAt, "2026-09-01T00:00:00.000Z", "how far back the loss reaches");
    assert.equal(instance.drain.discarded, 2);
  } finally {
    restore();
    files.cleanup();
  }
});

test("bound eviction by age is journaled too", async () => {
  const files = scratch();
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
  seed(files.outbox, [payload("stale", eightDaysAgo), payload("fresh")]);
  const { impl } = stubFetch({ single: () => ok({ status: "accepted" }) });
  const { instance, restore } = makeSender(impl, files);
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.deepEqual(readOutbox(files.outbox).map((e) => e.payload.idempotencyKey), ["fresh"]);
    const journal = readCollectorState(files.state);
    assert.deepEqual(journal.outboxDiscarded.lastReasons, { age: 1 });
    assert.equal(journal.outboxDiscarded.lastOldestQueuedAt, eightDaysAgo);
    // The live send succeeded after the discard: the record must survive it.
    assert.equal(journal.lastOutcome, "accepted");
    assert.equal(journal.outboxDiscarded.total, 1);
  } finally {
    restore();
    files.cleanup();
  }
});

test("a line that does not parse is discarded and counted, not allowed to poison the queue", async () => {
  const files = scratch();
  seed(files.outbox, [payload("good")]);
  fs.appendFileSync(files.outbox, "{this is not json\n");
  const { impl } = stubFetch({ single: () => ok({ status: "accepted" }) });
  const { instance, restore } = makeSender(impl, files);
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.deepEqual(readOutbox(files.outbox).map((e) => e.payload.idempotencyKey), ["good"]);
    assert.deepEqual(readCollectorState(files.state).outboxDiscarded.lastReasons, { unreadable: 1 });
  } finally {
    restore();
    files.cleanup();
  }
});

test("a per-item rejected verdict is discarded and journaled rather than retried forever", async () => {
  const files = scratch();
  seed(files.outbox, [payload("fine"), payload("broken")]);
  const { impl } = stubFetch({
    batch: () => ok({ results: [{ index: 0, status: "accepted" }, { index: 1, status: "rejected", reason: "malformed" }] }),
    single: () => ok({ status: "accepted" })
  });
  const { instance, restore } = makeSender(impl, files, { outboxDrain: true });
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.equal(readOutbox(files.outbox).length, 0);
    const journal = readCollectorState(files.state);
    assert.deepEqual(journal.outboxDiscarded.lastReasons, { rejected: 1 });
    assert.equal(journal.lastOutcome, "accepted", "the live send came after and is the latest word");
  } finally {
    restore();
    files.cleanup();
  }
});

test("a whole-batch validation_failed is a verdict on every item: discarded, journaled, not kept", async () => {
  const files = scratch();
  seed(files.outbox, [payload("x"), payload("y")]);
  const { impl } = stubFetch({
    batch: () => status(400, JSON.stringify({ error: "bad_request" })),
    single: () => ok({ status: "accepted" })
  });
  const { instance, restore } = makeSender(impl, files, { outboxDrain: true });
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.equal(readOutbox(files.outbox).length, 0);
    assert.deepEqual(readCollectorState(files.state).outboxDiscarded.lastReasons, { rejected: 2 });
  } finally {
    restore();
    files.cleanup();
  }
});

test("a rejected token is renewed once during the drain, and the batch replayed with the same keys", async () => {
  const files = scratch();
  seed(files.outbox, [payload("k1")]);
  const { impl, calls } = stubFetch({
    batch: (body, n) => (n === 1 ? status(401, JSON.stringify({ error: "invalid_token" })) : ok({ results: [{ index: 0, status: "accepted" }] })),
    renew: () => ok({ eventWriteToken: "tok_2", expiresAt: "2027-01-01T00:00:00Z" }),
    single: () => ok({ status: "accepted" })
  });
  const { instance, restore } = makeSender(impl, files, { outboxDrain: true });
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.equal(calls.renew.length, 1);
    assert.equal(calls.batch.length, 2);
    assert.equal(calls.batch[1].events[0].idempotencyKey, "k1");
    assert.equal(readOutbox(files.outbox).length, 0);
  } finally {
    restore();
    files.cleanup();
  }
});

test("a claim file orphaned by a drainer that died is swept back in", async () => {
  const files = scratch();
  const orphan = `${files.outbox}.99999.draining`;
  seed(orphan, [payload("orphaned")]);
  const twoMinutesAgo = new Date(Date.now() - 120_000);
  fs.utimesSync(orphan, twoMinutesAgo, twoMinutesAgo);

  const { impl, calls } = stubFetch({
    batch: () => ok({ results: [{ index: 0, status: "accepted" }] }),
    single: () => ok({ status: "accepted" })
  });
  const { instance, restore } = makeSender(impl, files, { outboxDrain: true });
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.equal(calls.batch[0].events[0].idempotencyKey, "orphaned");
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.readdirSync(files.dir).filter((n) => n.includes(".draining")).length, 0);
  } finally {
    restore();
    files.cleanup();
  }
});

test("a fresh claim file belongs to a drainer that is still running and is left alone", async () => {
  const files = scratch();
  const live = `${files.outbox}.99998.draining`;
  seed(live, [payload("in-flight")]);
  const { impl, calls } = stubFetch({ single: () => ok({ status: "accepted" }) });
  const { instance, restore } = makeSender(impl, files, { outboxDrain: true });
  try {
    await instance.send({ eventType: "ai_tool_call_completed", severity: "low" });
    assert.equal(calls.batch.length, 0);
    assert.equal(fs.existsSync(live), true);
  } finally {
    restore();
    files.cleanup();
  }
});

test("readOutboxSummary counts depth across the file and any claim files, and reports the oldest", () => {
  const files = scratch();
  try {
    assert.equal(readOutboxSummary(files.outbox), undefined, "nothing on disk is distinguishable from an empty file");
    seed(files.outbox, [payload("b", "2026-09-02T00:00:00.000Z"), payload("a", "2026-09-01T00:00:00.000Z")]);
    seed(`${files.outbox}.1.draining`, [payload("c", "2026-09-03T00:00:00.000Z")]);
    fs.appendFileSync(files.outbox, "garbage\n");
    const summary = readOutboxSummary(files.outbox);
    assert.equal(summary.depth, 3);
    assert.equal(summary.oldestQueuedAt, "2026-09-01T00:00:00.000Z");
    assert.equal(summary.unreadableLines, 1);
  } finally {
    files.cleanup();
  }
});

test("an unwritable outbox path costs the event, and the journal says lost rather than queued", async () => {
  const files = scratch();
  const { impl } = stubFetch({ single: () => status(503) });
  const { instance, restore } = makeSender(impl, files, { outboxFilePath: path.join(os.devNull, "nope", "outbox.jsonl") });
  try {
    assert.equal(await instance.send({ eventType: "ai_tool_call_completed", severity: "low" }), "transport_error");
    assert.doesNotMatch(readCollectorState(files.state).detail ?? "", /queued in outbox/);
  } finally {
    restore();
    files.cleanup();
  }
});

test("recordOutboxDiscard is cumulative and survives the next accepted send", () => {
  const files = scratch();
  try {
    recordSendOutcome(files.state, ID, "transport_error", { httpStatus: 503 });
    const first = recordOutboxDiscard(files.state, ID, { count: 3, reasons: { count: 3 }, oldestQueuedAt: "2026-09-01T00:00:00.000Z" });
    assert.equal(first.lastOutcome, "outbox_discarded");
    assert.equal(first.consecutiveFailures, 1, "not a send attempt: the episode is untouched");
    assert.equal(first.httpStatus, 503, "the last send's evidence is kept");

    recordOutboxDiscard(files.state, ID, { count: 2, reasons: { age: 2 } });
    const recovered = recordSendOutcome(files.state, ID, "accepted", { httpStatus: 200 });
    assert.equal(recovered.consecutiveFailures, 0);
    assert.equal(recovered.outboxDiscarded.total, 5, "a success closes the episode but does not un-lose the events");
    assert.equal(recovered.outboxDiscarded.lastCount, 2);
    assert.deepEqual(readCollectorState(files.state).outboxDiscarded.lastReasons, { age: 2 });
  } finally {
    files.cleanup();
  }
});

test("parseIngestResponse surfaces the batch door's per-item results, positionally", async () => {
  const batch = await parseIngestResponse(ok({
    accepted: 1, duplicate: 1, rejected: 1,
    results: [
      { index: 0, status: "accepted" },
      { index: 1, status: "duplicate", reason: "already_delivered" },
      { index: 2, status: "rejected", reason: "malformed" },
      { index: "not-a-number", status: "accepted" },
      "junk"
    ]
  }));
  assert.equal(batch.result, "accepted");
  assert.equal(batch.duplicates, 1);
  assert.deepEqual(batch.results, [
    { index: 0, status: "accepted" },
    { index: 1, status: "duplicate", reason: "already_delivered" },
    { index: 2, status: "rejected", reason: "malformed" }
  ]);

  const single = await parseIngestResponse(ok({ status: "duplicate" }));
  assert.equal(single.results, undefined, "the single door has no per-item shape");
  const bare = await parseIngestResponse(new Response("", { status: 200 }));
  assert.equal(bare.results, undefined);
});

test("concurrent appends from overlapping hook processes do not corrupt the file", async () => {
  // Claude Code fires PreToolUse and PostToolUse from separate processes and
  // they overlap. Each child appends through the real module; every line must
  // parse afterwards and every key must be present exactly once.
  const files = scratch();
  const kitPath = path.resolve(__dirname, "../out/index.js");
  const PROCESSES = 4;
  const PER_PROCESS = 150;
  const script = `
    const kit = require(process.argv[1]);
    const [file, tag, n] = process.argv.slice(2);
    for (let i = 0; i < Number(n); i++) {
      const okWrite = kit.appendToOutbox(file, {
        toolInstallationId: "${ID}", source: "claude_code", eventType: "ai_tool_call_completed",
        occurredAt: new Date().toISOString(), idempotencyKey: tag + "-" + i, severity: "low",
        consentScope: "ide_telemetry", provenance: "ai_work_telemetry", privacyMode: "metadata_only",
        metadata: { toolName: "Bash", commandClass: "test", outcome: "success", durationBucket: "0-1m" }
      });
      if (!okWrite) process.exit(3);
    }
  `;
  try {
    await Promise.all(Array.from({ length: PROCESSES }, (_, p) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script, kitPath, files.outbox, `p${p}`, String(PER_PROCESS)], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`child ${p} exited ${code}`))));
    })));

    const summary = readOutboxSummary(files.outbox);
    assert.equal(summary.unreadableLines, 0, "a torn line would mean two writes interleaved");
    assert.equal(summary.depth, PROCESSES * PER_PROCESS);
    const keys = readOutbox(files.outbox).map((e) => e.payload.idempotencyKey);
    assert.equal(new Set(keys).size, PROCESSES * PER_PROCESS, "every key exactly once");
  } finally {
    files.cleanup();
  }
});

test("concurrent drainers: exactly one claims the outbox, the other sees nothing to do", async () => {
  const files = scratch();
  seed(files.outbox, [payload("only")]);
  const first = kit.claimOutbox(files.outbox);
  const second = kit.claimOutbox(files.outbox);
  try {
    assert.ok(first, "the first rename wins");
    assert.equal(second, undefined, "the second finds no file: the rename is the lock");
    assert.equal(first.entries.length, 1);
    first.release(first.entries);
    assert.deepEqual(readOutbox(files.outbox).map((e) => e.payload.idempotencyKey), ["only"], "released back intact");
  } finally {
    files.cleanup();
  }
});
