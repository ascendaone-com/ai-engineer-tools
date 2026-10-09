const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { emitLiveSignal, deliverLine, holdForSaver, heldForSaver, probeSocket, readSaverStatuses, saverReplayPath } = require("../out/index.js");

/** A saver container with or without the saver's own folder in it. */
function container({ saverRan = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-saver-"));
  if (saverRan) fs.mkdirSync(path.join(dir, "Library", "Application Support", "AscendaWaterlineSaver", "status"), { recursive: true });
  process.env.ASCENDA_SAVER_CONTAINER = dir;
  return dir;
}

function held() {
  return JSON.parse(fs.readFileSync(saverReplayPath(), "utf8"));
}

test.afterEach(() => {
  delete process.env.ASCENDA_SAVER_CONTAINER;
  delete process.env.ASCENDA_LIVE_BUS_SOCKET;
});

test("a signal nobody takes is held for the saver, one entry per session", () => {
  container();
  holdForSaver({ tool: "claude_code", session: "a", event: "prompt_submitted", sizeBucket: "m", pid: 42, pidMatch: "path" }, 1000);
  holdForSaver({ tool: "claude_code", session: "a", event: "awaiting", pid: 42 }, 2000);
  holdForSaver({ tool: "claude_code", session: "b", event: "tool_call" }, 3000);
  const file = held();
  assert.equal(file.schema, 1);
  assert.deepEqual(file.signals, [
    { tool: "claude_code", session: "a", event: "awaiting", pid: 42, at: 2000 },
    { tool: "claude_code", session: "b", event: "tool_call", at: 3000 }
  ], "the latest word per session, oldest first, keeping the process id the stream is keyed by");
});

test("held signals older than the replay window are dropped on the next write", () => {
  container();
  holdForSaver({ tool: "claude_code", session: "old", event: "tool_call" }, 0);
  holdForSaver({ tool: "claude_code", session: "new", event: "tool_call" }, 31 * 60 * 1000);
  assert.deepEqual(held().signals.map((s) => s.session), ["new"]);
  assert.deepEqual(heldForSaver(31 * 60 * 1000), { count: 1, newestAgeMs: 0 });
});

test("nothing is written where the saver has never run", () => {
  const dir = container({ saverRan: false });
  holdForSaver({ tool: "claude_code", session: "a", event: "tool_call" });
  assert.deepEqual(fs.readdirSync(dir), [], "no file appears inside a container the saver never used");
});

test("emit holds the signal when no listener answers, and not when one does", async () => {
  container();
  const sock = path.join(fs.mkdtempSync("/tmp/asc-sh-"), "l.sock");
  process.env.ASCENDA_LIVE_BUS_SOCKET = sock;
  // Nothing at the socket path: held.
  await emitLiveSignal({ tool: "claude_code", session: "s1", event: "tool_call" });
  assert.deepEqual(held().signals.map((s) => s.event), ["tool_call"]);

  fs.rmSync(saverReplayPath());
  const server = net.createServer((c) => c.resume());
  await new Promise((r) => server.listen(sock, r));
  try {
    const accepted = await deliverLine('{"tool":"doctor","session":"d","event":"ping"}\n');
    assert.equal(accepted, sock, "deliverLine names the listener that took it");
    await emitLiveSignal({ tool: "claude_code", session: "s1", event: "tool_call" });
    assert.equal(fs.existsSync(saverReplayPath()), false, "a delivered signal is not held");
    assert.equal(await probeSocket(sock), "listening");
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(await probeSocket(sock), "absent");
});

test("saver heartbeats are read with whether their process is still running", () => {
  const dir = container();
  const statusDir = path.join(dir, "Library", "Application Support", "AscendaWaterlineSaver", "status");
  const now = Date.parse("2026-10-09T08:00:10Z");
  fs.writeFileSync(path.join(statusDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, updatedAt: "2026-10-09T08:00:08Z", previewViews: 0, saverViews: 1, ownsBus: true, signals: 3, unknownEvents: 0, replayed: 0 }));
  fs.writeFileSync(path.join(statusDir, "999999.json"), JSON.stringify({ pid: 999999, updatedAt: "2026-10-09T07:00:00Z", previewViews: 1, saverViews: 0, ownsBus: false, signals: 0, unknownEvents: 0, replayed: 0 }));
  fs.writeFileSync(path.join(statusDir, "junk.json"), "{");
  const readings = readSaverStatuses(now);
  assert.equal(readings.length, 2);
  assert.equal(readings[0].pid, process.pid);
  assert.equal(readings[0].alive, true);
  assert.equal(readings[0].ageMs, 2000);
  assert.equal(readings[1].alive, false);
});
