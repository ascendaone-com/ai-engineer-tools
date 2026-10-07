const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { emitLiveSignal, bucketPromptSize, liveBusSocketPath, liveBusSocketCandidates } = require("../out/index.js");

const sockPath = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-live-")), "live.sock");

/** A stand-in for the desktop app: collects newline-delimited JSON lines. */
function listen(socketPath) {
  const lines = [];
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) lines.push(JSON.parse(line));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({ server, lines }));
  });
}

test("a signal reaches a listening app", async () => {
  const p = sockPath();
  const { server, lines } = await listen(p);
  process.env.ASCENDA_LIVE_BUS_SOCKET = p;
  try {
    await emitLiveSignal({ tool: "claude_code", session: "s1", event: "prompt_submitted", sizeBucket: "m" });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(lines, [
      { tool: "claude_code", session: "s1", event: "prompt_submitted", sizeBucket: "m" }
    ]);
  } finally {
    server.close();
    delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  }
});

// The whole contract in one test: a hook must never fail, stall, or say
// anything because the desktop app isn't running. That is the ordinary case
// for everyone who doesn't use the app, not an error.
test("no listener is silent, fast, and never throws", async () => {
  process.env.ASCENDA_LIVE_BUS_SOCKET = path.join(os.tmpdir(), "ascenda-nonexistent-xyz.sock");
  try {
    const started = Date.now();
    await emitLiveSignal({ tool: "claude_code", session: "s1", event: "stop" });
    assert.ok(Date.now() - started < 500, "must not hang waiting on a dead socket");
  } finally {
    delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  }
});

test("a garbage socket path is swallowed too", async () => {
  process.env.ASCENDA_LIVE_BUS_SOCKET = "\u0000not/a/valid/path";
  try {
    await emitLiveSignal({ tool: "claude_code", session: "s1", event: "tool_call" });
  } finally {
    delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  }
});

test("~/.ascenda is the preferred home, and an override wins", () => {
  delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  // Asserted on the candidate list, not the resolved path: resolution
  // probes the filesystem, so on a machine with the app actually running
  // it correctly returns whichever socket is bound.
  assert.equal(liveBusSocketCandidates()[0], path.join(os.homedir(), ".ascenda", "live.sock"));
  process.env.ASCENDA_LIVE_BUS_SOCKET = "/tmp/custom.sock";
  assert.equal(liveBusSocketPath(), "/tmp/custom.sock");
  delete process.env.ASCENDA_LIVE_BUS_SOCKET;
});

test("resolution picks a bound socket over an unbound preferred path", async () => {
  delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  const p = sockPath();
  const { server } = await listen(p);
  try {
    // Nothing is bound at this candidate, so it must fall through...
    assert.ok(!require("node:fs").existsSync("/tmp/ascenda-definitely-absent.sock"));
    // ...which is exactly the sandbox case: prefer the one that exists.
    process.env.ASCENDA_LIVE_BUS_SOCKET = p;
    assert.equal(liveBusSocketPath(), p);
  } finally {
    server.close();
    delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  }
});

// The macOS app is sandboxed, so it physically cannot bind at the real
// ~/.ascenda — its HOME is redirected into its container. Hooks are
// unsandboxed and see the true home, so without this fallback they look in
// a place the app can never be and the gauges stay dark forever.
test("falls back to the sandbox container when that is where the app is", () => {
  delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  const candidates = liveBusSocketCandidates();
  assert.equal(candidates.length, 3);
  assert.ok(candidates[1].includes("Library/Containers/one.ascenda.ascendaMissionControl/Data"),
    `expected a container fallback, got ${candidates[1]}`);
});

test("an explicit override wins outright, no probing", () => {
  process.env.ASCENDA_LIVE_BUS_SOCKET = "/tmp/only-this.sock";
  try {
    assert.deepEqual(liveBusSocketCandidates(), ["/tmp/only-this.sock"]);
  } finally {
    delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  }
});

test("a bound socket is preferred over a merely-plausible path", async () => {
  delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  // A regular file at a candidate path must not be mistaken for a listener.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-probe-"));
  const notASocket = path.join(dir, "live.sock");
  fs.writeFileSync(notASocket, "");
  process.env.ASCENDA_LIVE_BUS_SOCKET = notASocket;
  try {
    // Resolves to it (explicit override), but emitting must still not throw.
    await emitLiveSignal({ tool: "claude_code", session: "s", event: "stop" });
  } finally {
    delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  }
});

test("candidate order: real home, then app container, then saver container", () => {
  delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  const home = os.homedir();
  assert.deepEqual(liveBusSocketCandidates(), [
    path.join(home, ".ascenda", "live.sock"),
    path.join(home, "Library", "Containers", "one.ascenda.ascendaMissionControl", "Data", ".ascenda", "live.sock"),
    // A listener inside Apple's screen saver host: its sandbox redirects
    // HOME here, so this is where its socket really is — spelled `l.sock`
    // at the container root because sockaddr_un's ~104-byte cap cannot fit
    // `.ascenda/live.sock` under the container prefix. Order matters — the
    // app, when present, always outranks it.
    path.join(home, "Library", "Containers", "com.apple.ScreenSaver.Engine.legacyScreenSaver", "Data", "l.sock")
  ]);
});

test("a live saver-container socket is found when it is the only listener", async () => {
  // Simulates hooks + a screen-saver listener and no desktop app: the
  // third candidate is the only one that exists, and a signal emitted
  // with no override reaches it. Candidate paths are faked via HOME so no real container is
  // touched. mkdtemp under /tmp directly, NOT os.tmpdir(): the container
  // prefix is ~80 bytes on its own and a macOS /var/folders tmpdir pushes
  // the socket path past sockaddr_un's ~104-byte cap — the exact failure
  // this layout exists to dodge.
  const fakeHome = fs.mkdtempSync("/tmp/as-");
  const saverSock = path.join(
    fakeHome, "Library", "Containers",
    "com.apple.ScreenSaver.Engine.legacyScreenSaver", "Data", "l.sock");
  fs.mkdirSync(path.dirname(saverSock), { recursive: true });
  const { server, lines } = await listen(saverSock);
  delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  const realHomedir = os.homedir;
  os.homedir = () => fakeHome;
  try {
    assert.equal(liveBusSocketPath(), saverSock);
    await emitLiveSignal({ tool: "claude_code", session: "s2", event: "tool_call" });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(lines, [{ tool: "claude_code", session: "s2", event: "tool_call" }]);
  } finally {
    os.homedir = realHomedir;
    server.close();
  }
});

// --- Stale sockets -------------------------------------------------------
//
// A socket file outlives its listener when the listener is killed or
// uninstalled without unlinking it. The file still stats as a socket, so
// existence alone would pick it and every signal would vanish into it.

/** A fake HOME with all three candidate directories, under /tmp for sockaddr_un's cap. */
function fakeCandidateHome() {
  const home = fs.mkdtempSync("/tmp/as-");
  const [real, app, saver] = [
    path.join(home, ".ascenda", "live.sock"),
    path.join(home, "Library", "Containers", "one.ascenda.ascendaMissionControl", "Data", ".ascenda", "live.sock"),
    path.join(home, "Library", "Containers", "com.apple.ScreenSaver.Engine.legacyScreenSaver", "Data", "l.sock")
  ];
  for (const p of [real, app, saver]) fs.mkdirSync(path.dirname(p), { recursive: true });
  return { home, real, app, saver };
}

/**
 * Leaves a real socket file at `socketPath` with nothing listening on it —
 * what a crashed listener leaves behind. Bound elsewhere and renamed into
 * place, so closing the server cannot unlink it.
 */
async function staleSocket(socketPath) {
  const bound = `${socketPath}.b`;
  const server = net.createServer();
  await new Promise((resolve) => server.listen(bound, resolve));
  fs.renameSync(bound, socketPath);
  await new Promise((resolve) => server.close(resolve));
  assert.ok(fs.statSync(socketPath).isSocket(), "the stale file must still read as a socket");
  await assert.rejects(new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.on("connect", () => { probe.destroy(); resolve(); });
    probe.on("error", reject);
  }), { code: "ECONNREFUSED" });
}

async function withFakeHome(home, body) {
  delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  const realHomedir = os.homedir;
  os.homedir = () => home;
  try {
    await body();
  } finally {
    os.homedir = realHomedir;
  }
}

test("a stale socket at the preferred path does not swallow the signal", async () => {
  const { home, real, saver } = fakeCandidateHome();
  await staleSocket(real);
  const { server, lines } = await listen(saver);
  try {
    await withFakeHome(home, async () => {
      // The file check alone still names the stale one...
      assert.equal(liveBusSocketPath(), real);
      // ...but the emit falls through to the listener that answers.
      await emitLiveSignal({ tool: "claude_code", session: "s3", event: "tool_call" });
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(lines, [{ tool: "claude_code", session: "s3", event: "tool_call" }]);
    });
  } finally {
    server.close();
  }
});

test("the first live listener wins, and nothing fans out", async () => {
  const { home, real, saver } = fakeCandidateHome();
  const first = await listen(real);
  const third = await listen(saver);
  try {
    await withFakeHome(home, async () => {
      await emitLiveSignal({ tool: "claude_code", session: "s4", event: "stop" });
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(first.lines, [{ tool: "claude_code", session: "s4", event: "stop" }]);
      assert.deepEqual(third.lines, []);
    });
  } finally {
    first.server.close();
    third.server.close();
  }
});

test("stale sockets everywhere resolve inside the budget and never throw", async () => {
  const { home, real, app, saver } = fakeCandidateHome();
  for (const p of [real, app, saver]) await staleSocket(p);
  await withFakeHome(home, async () => {
    const started = Date.now();
    await emitLiveSignal({ tool: "claude_code", session: "s5", event: "prompt_submitted", sizeBucket: "s" });
    // Refusals are immediate; well inside the 50 ms budget with room for a slow runner.
    assert.ok(Date.now() - started < 100, `took ${Date.now() - started} ms`);
  });
});

test("the 50 ms budget covers the whole emit, not each candidate", async () => {
  // A refusal that arrives late (40 ms) followed by a connect that never
  // completes. A per-candidate timer would take 90 ms; the shared one ends
  // the emit at 50. Stubbed at the net layer because a real Unix socket
  // refuses or connects at once.
  const { EventEmitter } = require("node:events");
  const { home, real, saver } = fakeCandidateHome();
  await staleSocket(real);
  await staleSocket(saver);
  const realCreate = net.createConnection;
  const attempts = [];
  net.createConnection = (target) => {
    const fake = new EventEmitter();
    fake.destroy = () => {};
    fake.unref = () => {};
    fake.write = () => { throw new Error("nothing should be written"); };
    attempts.push(target);
    if (attempts.length === 1) {
      setTimeout(() => fake.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })), 40);
    }
    return fake;
  };
  // Both sockets here are stubs, and the emit's own deadline is unref'd so a
  // hook can never hold a process open. With no real handle anywhere, the
  // loop has nothing to keep it alive and Node may drain it while the emit
  // is still pending. A real socket would have held it; this stands in.
  const keepAlive = setInterval(() => {}, 10);
  try {
    await withFakeHome(home, async () => {
      const started = Date.now();
      await emitLiveSignal({ tool: "claude_code", session: "s6", event: "stop" });
      const took = Date.now() - started;
      assert.deepEqual(attempts, [real, saver]);
      assert.ok(took >= 45 && took < 85, `took ${took} ms`);
    });
  } finally {
    clearInterval(keepAlive);
    net.createConnection = realCreate;
  }
});

test("prompt size buckets by length, and never throws on absent text", () => {
  assert.equal(bucketPromptSize("hi"), "s");
  assert.equal(bucketPromptSize("x".repeat(280)), "s");
  assert.equal(bucketPromptSize("x".repeat(281)), "m");
  assert.equal(bucketPromptSize("x".repeat(2000)), "m");
  assert.equal(bucketPromptSize("x".repeat(2001)), "l");
  assert.equal(bucketPromptSize("x".repeat(8001)), "xl");
  // A hook may be handed a payload with no prompt at all.
  assert.equal(bucketPromptSize(undefined), "s");
  assert.equal(bucketPromptSize(null), "s");
});

// A stop with work still running, and a stop on an API error, cross the
// socket with the fields the app reads to tell them from a finished turn.
test("stop carries a background count and stop_failure an error kind", async () => {
  const p = sockPath();
  const { server, lines } = await listen(p);
  process.env.ASCENDA_LIVE_BUS_SOCKET = p;
  try {
    await emitLiveSignal({ tool: "claude_code", session: "s1", event: "stop", backgroundTasks: 2 });
    await emitLiveSignal({ tool: "claude_code", session: "s1", event: "stop_failure", errorKind: "rate_limit" });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(lines, [
      { tool: "claude_code", session: "s1", event: "stop", backgroundTasks: 2 },
      { tool: "claude_code", session: "s1", event: "stop_failure", errorKind: "rate_limit" }
    ]);
  } finally {
    server.close();
    delete process.env.ASCENDA_LIVE_BUS_SOCKET;
  }
});

test("the background trust window is an hour", () => {
  const { LIVE_BUS_BACKGROUND_TRUST_MS } = require("../out/index.js");
  assert.equal(LIVE_BUS_BACKGROUND_TRUST_MS, 60 * 60 * 1000);
});
