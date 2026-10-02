const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { NOTICED_PURPOSES, renderStudyNotices, runStudyObjection, studyNoticeStatus } = require("../out/index.js");

// A purpose an organisation counts unless the person objects. These pin the
// words (the same as the app's study card), the closed list of purposes that
// can be noticed, "consent" never appearing, nothing about anyone else, and
// an older server leaving `status` exactly as it was.

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

const PREFIX = "npx @ascenda-one/claude-code-hooks";
const NOW = new Date("2026-10-02T00:00:00.000Z");
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const text = (lines) => lines.join("\n");

function notice(overrides = {}) {
  return {
    organisationId: "org-acme",
    organisationName: "Acme Health",
    code: 501,
    name: "AiDataProcessing",
    label: "Counted unless you object",
    processor: "Ascenda",
    basis: "legitimate_interests",
    basisLabel: null,
    documentTitle: "Engineering telemetry impact assessment",
    documentDate: "2026-09-01",
    documentReference: "LIA-2026-07",
    signatoryName: "Sam Rivera",
    objected: false,
    objectedAtUtc: null,
    noticeFromUtc: "2026-09-10T00:00:00.000Z",
    countingFromUtc: "2026-09-24T00:00:00.000Z",
    ...overrides
  };
}

test("only live telemetry, the imported history and the work-pattern axes can be noticed", () => {
  assert.deepEqual(NOTICED_PURPOSES.map((p) => p.code), [501, 507, 11]);
  assert.deepEqual(NOTICED_PURPOSES.map((p) => p.slug), ["telemetry", "import", "work-patterns"]);
});

test("a noticed purpose shows the label, the basis and its document, the processor, the state and the command", () => {
  const out = text(renderStudyNotices([notice()], PREFIX, NOW));
  assert.ok(out.includes("Your organisation's study"), out);
  assert.ok(out.includes("Acme Health: Live tool telemetry"));
  assert.ok(out.includes("    Counted unless you object"));
  assert.ok(out.includes("Acme Health's basis: Legitimate interests. Engineering telemetry impact assessment, ref LIA-2026-07, 1 Sep 2026."), out);
  assert.ok(out.includes("Recorded by Sam Rivera."));
  assert.ok(out.includes("Ascenda processes this for Acme Health."));
  assert.ok(out.includes("You haven't objected."));
  assert.ok(out.includes(`To object: ${PREFIX} object telemetry`));
  assert.ok(!out.includes("--undo"), "no undo before there's an objection");
});

test("an objection shows its date and the one command that undoes it", () => {
  const out = text(renderStudyNotices([notice({ code: 11, objected: true, objectedAtUtc: "2026-09-30T08:00:00.000Z" })], PREFIX, NOW));
  assert.ok(out.includes("Acme Health: Work-pattern axes in the group figures"));
  assert.ok(out.includes("You objected on 30 Sep 2026. You're left out from the next report."), out);
  assert.ok(out.includes(`To undo: ${PREFIX} object work-patterns --undo`));
  assert.ok(!out.includes("To object:"));
});

test("an objected state the reply doesn't give is never guessed", () => {
  const out = text(renderStudyNotices([notice({ objected: "yes" })], PREFIX, NOW));
  assert.ok(out.includes("couldn't read whether you've objected"), out);
  assert.ok(!out.includes("You haven't objected."));
  assert.ok(!out.includes("You objected"));
  assert.ok(out.includes(`To object: ${PREFIX} object telemetry`));
  assert.ok(out.includes(`To undo: ${PREFIX} object telemetry --undo`));
});

test("inside the notice period it says when counting can begin", () => {
  const out = text(renderStudyNotices([notice({ code: 507, countingFromUtc: "2026-10-12T00:00:00.000Z" })], PREFIX, NOW));
  assert.ok(out.includes("Acme Health: One-time import of past AI work"));
  assert.ok(out.includes("You're not counted before 12 Oct 2026."), out);
  const after = text(renderStudyNotices([notice()], PREFIX, NOW));
  assert.ok(!after.includes("not counted before"), "nothing to say once the period has run");
});

test("a collective agreement, a basis in the organisation's own words, and one this version can't name", () => {
  assert.ok(text(renderStudyNotices([notice({ basis: "collective_agreement" })], PREFIX, NOW)).includes("Acme Health's basis: Collective agreement."));
  assert.ok(text(renderStudyNotices([notice({ basis: "another_basis", basisLabel: "Statutory duty under local law" })], PREFIX, NOW))
    .includes("Acme Health's basis: Statutory duty under local law."));
  const unknown = text(renderStudyNotices([notice({ basis: "another_basis", basisLabel: null })], PREFIX, NOW));
  assert.ok(unknown.includes("Acme Health's basis is one this version of the tool can't name."), unknown);
  assert.ok(!unknown.includes("another_basis"), "a raw key never reaches the screen");
});

test("a document with no title or date still prints what there is", () => {
  const out = text(renderStudyNotices([notice({ documentTitle: null, documentDate: null })], PREFIX, NOW));
  assert.ok(out.includes("Acme Health's basis: Legitimate interests. ref LIA-2026-07."), out);
  const bare = text(renderStudyNotices([notice({ documentTitle: null, documentDate: null, documentReference: null, signatoryName: null })], PREFIX, NOW));
  assert.ok(bare.includes("Acme Health's basis: Legitimate interests.\n"), bare);
  assert.ok(!bare.includes("Recorded by"));
});

test("never the word consent, whatever the server sends", () => {
  const out = text(renderStudyNotices([
    notice(),
    notice({ code: 507, objected: true }),
    notice({ code: 11, objected: null, basis: "collective_agreement" })
  ], PREFIX, NOW));
  assert.doesNotMatch(out, /consent/i);
});

test("nothing about anyone else is printed, even if the server sent it", () => {
  const out = text(renderStudyNotices([notice({ objectorCount: 3, objectors: ["Alex Kim"], othersObjected: true })], PREFIX, NOW));
  assert.doesNotMatch(out, /Alex Kim|3 |others|objectors/i);
});

test("a purpose outside the closed list is never shown as counted unless you object", () => {
  const out = text(renderStudyNotices([notice({ code: 12, name: "SelfReportAggregation" })], PREFIX, NOW));
  assert.deepEqual(renderStudyNotices([notice({ code: 12 })], PREFIX, NOW), [], out);
  const mixed = text(renderStudyNotices([notice(), notice({ code: 9 })], PREFIX, NOW));
  assert.ok(mixed.includes("1 entry in the list couldn't be read by this version of the tool."), mixed);
  assert.equal(mixed.match(/Counted unless you object/g).length, 1);
});

test("an entry naming another mode is not a notice", () => {
  assert.deepEqual(renderStudyNotices([notice({ mode: "OptIn" })], PREFIX, NOW), []);
  assert.equal(renderStudyNotices([notice({ mode: "Notice" })], PREFIX, NOW).length > 0, true);
});

test("nothing noticed, an older server, a refused token or a failed read: status prints nothing for this", async () => {
  const cases = [
    () => json(200, []),
    () => json(404, { error: "not_found" }),
    () => json(200, { status: "accepted" }),
    () => json(401, { error: "unauthorized" }),
    () => json(503, { error: "down" }),
    () => { throw new TypeError("fetch failed"); }
  ];
  for (const respond of cases) {
    global.fetch = async () => respond();
    const status = await studyNoticeStatus({ apiBaseUrl: "http://x", eventWriteToken: "t", commandPrefix: PREFIX, now: NOW });
    assert.deepEqual(status.lines, []);
  }
});

test("no token, no request", async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return json(200, [notice()]); };
  const status = await studyNoticeStatus({ apiBaseUrl: "http://x", eventWriteToken: undefined, commandPrefix: PREFIX });
  assert.deepEqual(status.lines, []);
  await status.markShown();
  assert.equal(calls, 0);
});

test("the read uses the install's own token, and marking shown covers only notices not yet shown, per organisation", async () => {
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method, auth: init.headers.Authorization });
    if (String(url).endsWith("/study-notices")) {
      return json(200, [
        notice({ noticeFromUtc: null, countingFromUtc: null }),
        notice({ organisationId: "org-globex", organisationName: "Globex", noticeFromUtc: null }),
        notice({ code: 507 }),
        notice({ code: 12, noticeFromUtc: null }),
        notice({ code: 11, organisationId: null, noticeFromUtc: null })
      ]);
    }
    return new Response(null, { status: 204 });
  };
  const status = await studyNoticeStatus({ apiBaseUrl: "http://x", eventWriteToken: "tok", commandPrefix: PREFIX, now: NOW });
  assert.equal(requests.length, 1, "reading sends nothing back");
  assert.deepEqual(requests[0], { url: "http://x/v1/tool-installations/study-notices", method: "GET", auth: "Bearer tok" });
  await status.markShown();
  assert.deepEqual(requests.slice(1), [
    { url: "http://x/v1/tool-installations/study-notices/org-acme/501/shown", method: "POST", auth: "Bearer tok" },
    { url: "http://x/v1/tool-installations/study-notices/org-globex/501/shown", method: "POST", auth: "Bearer tok" }
  ]);
});

test("marking shown on a server without the route is harmless", async () => {
  global.fetch = async (url) => (String(url).endsWith("/study-notices") ? json(200, [notice({ noticeFromUtc: null })]) : json(404, {}));
  const status = await studyNoticeStatus({ apiBaseUrl: "http://x", eventWriteToken: "tok", commandPrefix: PREFIX, now: NOW });
  await status.markShown();
});

// ---------------------------------------------------------------- object ---

function terminal(isTTY = true) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdin.isTTY = isTTY;
  stdout.isTTY = isTTY;
  let out = "";
  let err = "";
  stdout.on("data", (c) => { out += c; });
  stderr.on("data", (c) => { err += c; });
  return { stdin, stdout, stderr, out: () => out, err: () => err };
}

function objection(argv, io, overrides = {}) {
  return runStudyObjection({
    apiBaseUrl: "http://x",
    eventWriteToken: "tok",
    commandPrefix: PREFIX,
    pairCommand: `${PREFIX} pair`,
    argv,
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    ...overrides
  });
}

test("object is one request, with no body and no reason, and says when it takes effect", async () => {
  const requests = [];
  global.fetch = async (url, init) => { requests.push({ url: String(url), method: init.method, body: init.body }); return new Response(null, { status: 204 }); };
  const io = terminal();
  assert.equal(await objection(["telemetry"], io), 0);
  assert.deepEqual(requests, [{ url: "http://x/v1/tool-installations/study-notices/501/objection", method: "POST", body: undefined }]);
  assert.ok(io.out().includes("Objected: Live tool telemetry."));
  assert.ok(io.out().includes("You're left out from the next report. Reports already issued stay as they are."));
  assert.ok(io.out().includes(`To undo: ${PREFIX} object telemetry --undo`));
  assert.doesNotMatch(io.out(), /consent|reason/i);
});

test("--undo withdraws the objection", async () => {
  const requests = [];
  global.fetch = async (url, init) => { requests.push({ url: String(url), method: init.method }); return new Response(null, { status: 204 }); };
  const io = terminal();
  assert.equal(await objection(["import", "--undo"], io), 0);
  assert.deepEqual(requests, [{ url: "http://x/v1/tool-installations/study-notices/507/objection", method: "DELETE" }]);
  assert.ok(io.out().includes("Objection withdrawn: One-time import of past AI work."));
  assert.ok(io.out().includes("You're counted again from the next report."));
  assert.ok(io.out().includes(`To object again: ${PREFIX} object import`));
});

test("object refuses without a terminal, in both directions, before any request", async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return new Response(null, { status: 204 }); };
  for (const argv of [["telemetry"], ["telemetry", "--undo"]]) {
    const io = terminal(false);
    assert.equal(await objection(argv, io), 1);
    assert.match(io.err(), /needs an interactive terminal/);
  }
  assert.equal(calls, 0);
});

test("an unknown purpose prints the three there are", async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return new Response(null, { status: 204 }); };
  for (const argv of [[], ["self-report"], ["501"], ["telemetry", "import"]]) {
    const io = terminal();
    assert.equal(await objection(argv, io), 1);
    assert.match(io.err(), /Usage: .* object <purpose> \[--undo\]/);
    for (const p of NOTICED_PURPOSES) assert.ok(io.err().includes(p.slug));
  }
  assert.equal(calls, 0);
});

test("object's refusals are said in plain words, and say nothing changed", async () => {
  const cases = [
    [() => json(404, { code: "not_noticed" }), ["telemetry"], /doesn't count you for Live tool telemetry unless you object, so there's nothing to object to\./],
    [() => json(404, { code: "not_noticed" }), ["telemetry", "--undo"], /so there's no objection to undo\./],
    [() => json(401, { error: "unauthorized" }), ["telemetry"], /pair again with `npx @ascenda-one\/claude-code-hooks pair`/],
    [() => json(404, { error: "not_found" }), ["telemetry"], /This server doesn't take objections yet\. Nothing changed\./],
    [() => json(500, {}), ["telemetry"], /Couldn't record that \(HTTP 500\)\. Nothing changed\./],
    [() => { throw new TypeError("fetch failed"); }, ["telemetry"], /Couldn't reach the server\. Nothing changed\./]
  ];
  for (const [respond, argv, expected] of cases) {
    global.fetch = async () => respond();
    const io = terminal();
    assert.equal(await objection(argv, io), 1);
    assert.match(io.err(), expected);
    assert.equal(io.out(), "");
  }
});

test("object on an unpaired install asks for nothing", async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return new Response(null, { status: 204 }); };
  const io = terminal();
  assert.equal(await objection(["telemetry"], io, { eventWriteToken: undefined }), 1);
  assert.match(io.err(), /isn't paired/);
  assert.equal(calls, 0);
});
