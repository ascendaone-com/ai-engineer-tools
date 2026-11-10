const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const {
  runSquadronJoin,
  normaliseBookingReference,
  callsignProblem,
  generateCallsign,
  describeSquadronRefusal
} = require("../out/index.js");

const API = "https://api.example.test";

const PREVIEW = {
  labId: "lab-1",
  labName: "Friday sortie",
  labRole: "Jam",
  joinCode: "FEFBDH",
  jam: {
    name: "Friday sortie",
    mission: "Ship the beta",
    status: "pending",
    isLocked: false,
    acceptsJoins: true,
    minParticipants: 3,
    activeParticipants: 1,
    durationMinutes: 90,
    quorumDeadline: "2026-11-10T10:00:00Z",
    aircraft: ["airliner", "fighter", "floatplane", "glider", "stealth", "trainer"],
    colours: ["orange", "yellow", "ivory", "charcoal", "grey", "red"]
  }
};

const START = { joinSessionId: "js-1", deviceCode: "654321", expiresAt: new Date(Date.now() + 600000).toISOString() };

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(routes) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [match, respond] of routes) if (match(String(url), init)) return respond();
    throw new Error(`unmocked fetch: ${url}`);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const previewRoute = (body = PREVIEW, status = 200) => [(u) => u.includes("/api/share/join/"), () => json(status, body)];
const startRoute = (body = START, status = 200) => [(u) => u.endsWith("/v1/org-study-join-sessions"), () => json(status, body)];
const statusRoute = (body) => [(u) => u.endsWith("/status"), () => json(200, body)];

function tty() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => { out += c.toString(); });
  stderr.on("data", (c) => { err += c.toString(); });
  return { stdin, stdout, stderr, out: () => out, err: () => err };
}

function waitFor(get, text, ms = 2000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (get().includes(text)) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting for ${JSON.stringify(text)} in:\n${get()}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function ctx(io, extra = {}) {
  return {
    apiBaseUrl: API,
    eventWriteToken: "tok",
    displayName: "Claude Code",
    bookingReference: "fefbdh",
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    pollIntervalMs: 1,
    generateCallsign: () => "Kestrel 27",
    ...extra
  };
}

test("no terminal: refused before any network call", async () => {
  const io = tty();
  io.stdin.isTTY = false;
  const fetch = mockFetch([]);
  try {
    assert.equal(await runSquadronJoin(ctx(io)), 0);
    assert.equal(fetch.calls.length, 0);
    assert.match(io.err(), /interactive terminal/);
  } finally {
    fetch.restore();
  }
});

test("a malformed booking reference is refused before any network call", async () => {
  const io = tty();
  const fetch = mockFetch([]);
  try {
    assert.equal(await runSquadronJoin(ctx(io, { bookingReference: "abc" })), 1);
    assert.equal(fetch.calls.length, 0);
  } finally {
    fetch.restore();
  }
});

test("a study code is sent to join, and nothing is started", async () => {
  const io = tty();
  const fetch = mockFetch([previewRoute({ ...PREVIEW, labRole: "Organisation", jam: undefined })]);
  try {
    assert.equal(await runSquadronJoin(ctx(io)), 1);
    assert.match(io.err(), /run join instead/);
    assert.equal(fetch.calls.length, 1);
  } finally {
    fetch.restore();
  }
});

test("defaults on Enter: shares are printed before the question, the seat is sent, and the server's date is printed", async () => {
  const io = tty();
  const fetch = mockFetch([
    previewRoute(),
    startRoute(),
    statusRoute({ status: "confirmed", granted: [], refusedReason: null, endUtc: "2026-11-17T11:30:00Z", jam: { status: "pending", activeParticipants: 2, minParticipants: 3 } })
  ]);
  try {
    const run = runSquadronJoin(ctx(io));
    await waitFor(io.out, "Callsign [Kestrel 27]");
    io.stdin.write("\n");
    await waitFor(io.out, "Aircraft [");
    io.stdin.write("glider\n");
    await waitFor(io.out, "Colour [dealt for you]");
    io.stdin.write("\n");
    await waitFor(io.out, "Choice [Not now]");
    const before = io.out();
    assert.match(before, /Squadron: Friday sortie/);
    assert.match(before, /Mission: Ship the beta/);
    assert.match(before, /1 of 3 pilots in/);
    assert.match(before, /with this squadron only/);
    assert.match(before, /activity counts from Claude Code/);
    assert.match(before, /Never your prompts, code, file names or project names/);
    assert.equal(fetch.calls.length, 1, "nothing but the preview before the answer");
    io.stdin.write("1\n");
    assert.equal(await run, 0);

    const startCall = fetch.calls.find((c) => c.url.endsWith("/v1/org-study-join-sessions"));
    assert.equal(startCall.init.headers.Authorization, "Bearer tok");
    assert.deepEqual(JSON.parse(startCall.init.body), { joinCode: "FEFBDH", mode: "report", handle: "Kestrel 27", aircraft: "glider" });
    assert.match(io.out(), /Open this link to confirm: https:\/\/api\.example\.test\/join\/654321/);
    assert.match(io.out(), /Joined as Kestrel 27\./);
    assert.match(io.out(), /shared with this squadron until (17 Nov 2026|Nov 17, 2026)/);
    assert.match(io.out(), /2 of 3 pilots in/);
  } finally {
    fetch.restore();
  }
});

test("flags skip their questions, and colour goes on the wire", async () => {
  const io = tty();
  const fetch = mockFetch([previewRoute(), startRoute(), statusRoute({ status: "confirmed", granted: [], refusedReason: null })]);
  try {
    const run = runSquadronJoin(ctx(io, { callsign: " Goose ", aircraft: "Fighter", colour: "red" }));
    await waitFor(io.out, "Choice [Not now]");
    assert.doesNotMatch(io.out(), /Callsign \[/);
    io.stdin.write("join\n");
    assert.equal(await run, 0);
    const body = JSON.parse(fetch.calls[1].init.body);
    assert.deepEqual(body, { joinCode: "FEFBDH", mode: "report", handle: "Goose", aircraft: "fighter", colour: "red" });
    assert.match(io.out(), /until the sortie's sharing ends\. The server didn't give a date\./);
  } finally {
    fetch.restore();
  }
});

test("an unknown aircraft flag is refused before the start call", async () => {
  const io = tty();
  const fetch = mockFetch([previewRoute()]);
  try {
    assert.equal(await runSquadronJoin(ctx(io, { aircraft: "zeppelin" })), 1);
    assert.match(io.err(), /--aircraft must be one of/);
    assert.equal(fetch.calls.length, 1);
  } finally {
    fetch.restore();
  }
});

test("Not now, Enter and EOF all stop before the start call", async () => {
  for (const ending of ["2\n", "\n", null]) {
    const io = tty();
    const fetch = mockFetch([previewRoute()]);
    try {
      const run = runSquadronJoin(ctx(io, { callsign: "Goose", aircraft: "glider", colour: "red" }));
      await waitFor(io.out, "Choice [Not now]");
      if (ending === null) io.stdin.end();
      else io.stdin.write(ending);
      assert.equal(await run, 0);
      assert.equal(fetch.calls.length, 1, `start was called after ${JSON.stringify(ending)}`);
      assert.match(io.out(), /Not now\./);
    } finally {
      fetch.restore();
    }
  }
});

test("a closed gate is said plainly and nothing is asked", async () => {
  const io = tty();
  const fetch = mockFetch([previewRoute({ ...PREVIEW, jam: { ...PREVIEW.jam, isLocked: true, acceptsJoins: false } })]);
  try {
    assert.equal(await runSquadronJoin(ctx(io)), 1);
    assert.match(io.err(), /gate is closed/);
  } finally {
    fetch.restore();
  }
});

test("a taken callsign from the start call reads as a sentence", async () => {
  const io = tty();
  const fetch = mockFetch([previewRoute(), startRoute({ error: "That callsign is taken.", code: "jam_handle_taken" }, 409)]);
  try {
    const run = runSquadronJoin(ctx(io, { callsign: "Goose", aircraft: "glider", colour: "red" }));
    await waitFor(io.out, "Choice [Not now]");
    io.stdin.write("1\n");
    assert.equal(await run, 1);
    assert.match(io.err(), /Another pilot has that callsign/);
  } finally {
    fetch.restore();
  }
});

test("a 404 from the join door after a good preview says the door can't seat sorties yet", async () => {
  const io = tty();
  const fetch = mockFetch([previewRoute(), startRoute({ error: "Join code not found or not an organisation study", code: "join_code_not_found" }, 404)]);
  try {
    const run = runSquadronJoin(ctx(io, { callsign: "Goose", aircraft: "glider" , colour: "red" }));
    await waitFor(io.out, "Choice [Not now]");
    io.stdin.write("1\n");
    assert.equal(await run, 1);
    assert.match(io.err(), /can't seat you in a sortie from the command line yet/);
  } finally {
    fetch.restore();
  }
});

test("an unknown booking reference reads as a sentence", async () => {
  const io = tty();
  const fetch = mockFetch([previewRoute({ error: "Join code not found." }, 404)]);
  try {
    assert.equal(await runSquadronJoin(ctx(io)), 1);
    assert.match(io.err(), /No sortie has that booking reference/);
  } finally {
    fetch.restore();
  }
});

test("helpers: booking reference, callsign rules, generated callsign, refusal wording", () => {
  assert.equal(normaliseBookingReference(" fef-bdh "), "FEFBDH");
  assert.equal(normaliseBookingReference("FEFBD"), undefined);
  assert.equal(callsignProblem("   "), "A callsign can't be empty.");
  assert.equal(callsignProblem("x".repeat(41)), "A callsign is 40 characters at most.");
  assert.equal(callsignProblem("Go\u0007ose"), "A callsign can't contain control characters.");
  assert.equal(callsignProblem("Goose"), undefined);
  assert.match(generateCallsign(), /^[A-Z][a-z]+ \d{2}$/);
  assert.equal(describeSquadronRefusal("jam_already_left"), "You left this sortie, and leaving is final. Ask the host for a new one.");
  assert.equal(describeSquadronRefusal("mystery"), "The server refused the join (mystery).");
});
