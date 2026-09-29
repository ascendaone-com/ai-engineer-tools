const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { initiativesStatusLines, renderInitiatives, readInitiatives } = require("../out/index.js");

// `status` is where a person sees the changes their organisation has
// published to them. Each thing that can be true when it looks gets its own
// sentence, so these pin: every status word, including one this version has
// never heard of; the organisation's summary passing through as written; a
// raw code never reaching the screen; and the four situations that a blank
// would otherwise have to stand for.

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function initiative(overrides = {}) {
  return {
    id: "6f1d2f0e-1111-4a3b-9c0e-000000000001",
    organisationName: "Acme Health",
    title: "Shorter review turnaround",
    change: "Reviewers pick up pull requests within a working day",
    summaryForCohort: "We are trying a one-day pickup rule.\nIt starts on the 5th.",
    orgReason: null,
    measureKey: "review_turnaround",
    measureUnit: "hours",
    direction: "down",
    scoringStartUtc: "2026-10-05T00:00:00.000Z",
    scoringEndUtc: "2026-11-02T00:00:00.000Z",
    withdrawnUtc: null,
    status: "published",
    result: null,
    ...overrides
  };
}

const scoredResult = (overrides = {}) => ({
  scoredAtUtc: "2026-11-03T00:00:00.000Z",
  value: 15,
  baselineValue: 12,
  delta: 3,
  movement: "up",
  outcome: "met_target",
  withheldReason: null,
  basis: "cohort_median",
  ...overrides
});

const COPY = {
  outcomes: { met_target: "The change moved the number the way the organisation hoped." },
  withheldReasons: { too_few_people: "Too few people took part to show a figure." },
  units: { hours: "hours" }
};

const text = (lines) => lines.join("\n");

test("a published change shows the title, the organisation's summary as written, and the window", () => {
  const out = text(renderInitiatives([initiative()], COPY));
  assert.ok(out.includes("Acme Health: Shorter review turnaround"));
  assert.ok(out.includes("Published, not scored yet."));
  assert.ok(out.includes("We are trying a one-day pickup rule."));
  assert.ok(out.includes("It starts on the 5th."), "a multi-line summary keeps its lines");
  assert.ok(out.includes("Scoring window: 5 Oct – 2 Nov 2026"), out);
  assert.ok(!out.includes("Result:"), "nothing to report before it is scored");
});

test("a scored change shows the result in the organisation's words", () => {
  const out = text(renderInitiatives([initiative({ status: "scored", result: scoredResult() })], COPY));
  assert.ok(out.includes("Scored."));
  assert.ok(out.includes("Result: 15 hours (up 3 hours from 12 hours)"), out);
  assert.ok(out.includes("The change moved the number the way the organisation hoped."));
  assert.ok(!out.includes("met_target"), "the outcome key is never printed");
  assert.ok(!out.includes("hours_"), "no raw key leaks through");
});

test("a scored change moving down, and one level with its baseline", () => {
  const down = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ value: 9, delta: -3, movement: "down" }) })], COPY));
  assert.ok(down.includes("Result: 9 hours (down 3 hours from 12 hours)"), down);
  const level = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ value: 12, delta: 0, movement: "level" }) })], COPY));
  assert.ok(level.includes("Result: 12 hours (level with 12 hours)"), level);
});

test("a result whose outcome this version can't word says so, and never prints the key", () => {
  const out = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ outcome: "a_brand_new_outcome" }) })], COPY));
  assert.ok(out.includes("can't put the organisation's verdict into words"), out);
  assert.ok(!out.includes("a_brand_new_outcome"));
});

test("a withheld figure is shown as withheld, never as zero", () => {
  const withheld = scoredResult({ value: null, baselineValue: null, delta: null, movement: null, outcome: "withheld", withheldReason: "too_few_people" });
  const out = text(renderInitiatives([initiative({ status: "scored", result: withheld })], COPY));
  assert.ok(out.includes("Result: withheld. Too few people took part to show a figure."), out);
  assert.ok(!/Result: 0/.test(out));
  assert.ok(!out.includes("too_few_people"));

  const unknownReason = text(renderInitiatives([initiative({ status: "scored", result: { ...withheld, withheldReason: "never_seen_before" } })], COPY));
  assert.ok(unknownReason.includes("Result: withheld. The organisation withheld the figure."), unknownReason);
  assert.ok(!unknownReason.includes("never_seen_before"));
});

test("a withdrawn change is shown as withdrawn, with its date, and no result", () => {
  const out = text(renderInitiatives([initiative({ status: "withdrawn", withdrawnUtc: "2026-10-12T09:00:00.000Z", result: scoredResult() })], COPY));
  assert.ok(out.includes("Withdrawn on 12 Oct 2026. It won't be scored."), out);
  assert.ok(!out.includes("Result:"), "a withdrawn change carries no result");
  const undated = text(renderInitiatives([initiative({ status: "withdrawn" })], COPY));
  assert.ok(undated.includes("Withdrawn. It won't be scored."), undated);
});

test("a status this version doesn't know is shown, not hidden and not a crash", () => {
  const out = text(renderInitiatives([initiative({ status: "paused" })], COPY));
  assert.ok(out.includes("Acme Health: Shorter review turnaround"), "the change is still listed");
  assert.ok(out.includes("Status: paused (this version of the tool doesn't know that status)."), out);
});

test("the sealed-prediction line shows as given before scoring, and the prediction line beside the result after", () => {
  const before = text(renderInitiatives([initiative({ predictionSealed: true, predictionSealedLine: "A prediction is sealed until scoring.", prediction: null })], COPY));
  assert.ok(before.includes("A prediction is sealed until scoring."), before);

  const notSealed = text(renderInitiatives([initiative({ predictionSealed: false, predictionSealedLine: "should not show", prediction: null })], COPY));
  assert.ok(!notSealed.includes("should not show"));

  const after = text(renderInitiatives([initiative({
    status: "scored", result: scoredResult(), predictionSealed: false, predictionSealedLine: null,
    prediction: { direction: "down", minimumMove: 2, line: "The prediction was a drop of at least 2 hours.", outcome: "missed" }
  })], COPY));
  assert.ok(after.includes("Result: 15 hours"));
  assert.ok(after.includes("The prediction was a drop of at least 2 hours."), after);
  assert.ok(!after.includes("missed") && !after.includes("minimumMove"), "only the sentence is shown");

  const withdrawn = text(renderInitiatives([initiative({ status: "withdrawn", predictionSealed: true, predictionSealedLine: "sealed line" })], COPY));
  assert.ok(!withdrawn.includes("sealed line"), "a withdrawn change has nothing left to seal");
});

test("an entry that can't be read is counted, and the others are still shown", () => {
  const out = text(renderInitiatives([initiative(), { nonsense: true }, null], COPY));
  assert.ok(out.includes("Shorter review turnaround"));
  assert.ok(out.includes("2 entries in the list couldn't be read by this version of the tool."), out);
});

test("the shipped wording table is empty of raw codes on the way out, whatever the outcome", () => {
  const out = text(renderInitiatives([initiative({ status: "scored", result: scoredResult() })]));
  assert.ok(!out.includes("met_target"));
  assert.ok(!out.includes("cohort_median"));
});

// ── The four situations ────────────────────────────────────────────────────

const ctx = { apiBaseUrl: "https://api.example.test", eventWriteToken: "tok", pairCommand: "npx tool setup" };

test("an empty list says nothing is published to you", async () => {
  global.fetch = async () => json(200, []);
  const out = text(await initiativesStatusLines(ctx));
  assert.ok(out.includes("None published to you."), out);
});

test("a list with entries prints them under the heading", async () => {
  global.fetch = async () => json(200, [initiative(), initiative({ id: "2", title: "Pairing Fridays", status: "withdrawn" })]);
  const out = text(await initiativesStatusLines(ctx));
  assert.ok(out.startsWith("Changes your organisation has published to you"));
  assert.ok(out.includes("Shorter review turnaround"));
  assert.ok(out.includes("Pairing Fridays"));
  assert.ok(!out.includes("None published"));
});

test("a 401 says it couldn't check, guesses no cause, and names the way back, not 'none published'", async () => {
  global.fetch = async () => new Response("", { status: 401 });
  const out = text(await initiativesStatusLines(ctx));
  assert.ok(out.includes("Couldn't check: the server turned this install's request down."), out);
  assert.ok(!/revoked|expired|unpaired|isn't paired/i.test(out), "a bare 401 carries no cause to report");
  assert.ok(out.includes("`npx tool setup`"));
  assert.ok(!out.includes("None published"));
});

test("a failed fetch says why, for a dropped connection, a timeout, a 5xx and an unreadable reply", async () => {
  global.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  assert.ok(text(await initiativesStatusLines(ctx)).includes("Couldn't check: the server could not be reached. Run status again to retry."));

  global.fetch = async () => {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  };
  assert.ok(text(await initiativesStatusLines(ctx)).includes("the request timed out"));

  global.fetch = async () => new Response("bad gateway", { status: 502 });
  assert.ok(text(await initiativesStatusLines(ctx)).includes("the server answered HTTP 502"));

  global.fetch = async () => new Response("<html>", { status: 200 });
  assert.ok(text(await initiativesStatusLines(ctx)).includes("the reply was not readable"));

  global.fetch = async () => json(200, { not: "a list" });
  const notList = text(await initiativesStatusLines(ctx));
  assert.ok(notList.includes("the reply was not a list"), notList);
  assert.ok(!notList.includes("None published"));
});

test("an install with no token is told so, and no request is made", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return json(200, []);
  };
  const out = text(await initiativesStatusLines({ ...ctx, eventWriteToken: undefined }));
  assert.equal(calls, 0, "nothing is sent for an install that holds no token");
  assert.ok(out.includes("Not checked: this install holds no token, so nothing was fetched."), out);
});

test("the four messages are all different from one another", async () => {
  const seen = new Set();
  global.fetch = async () => json(200, []);
  seen.add(text(await initiativesStatusLines(ctx)));
  global.fetch = async () => new Response("", { status: 401 });
  seen.add(text(await initiativesStatusLines(ctx)));
  global.fetch = async () => new Response("", { status: 503 });
  seen.add(text(await initiativesStatusLines(ctx)));
  seen.add(text(await initiativesStatusLines({ ...ctx, eventWriteToken: undefined })));
  assert.equal(seen.size, 4);
});

test("the read sends the tool's own token as a Bearer, to the one route, and only reads", async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return json(200, []);
  };
  await readInitiatives("https://api.example.test", "secret-token");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/v1/tool-installations/initiatives");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
  assert.equal(calls[0].init.body, undefined);
});
