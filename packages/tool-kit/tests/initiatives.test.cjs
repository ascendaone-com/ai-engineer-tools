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
  outcome: "moved_as_declared",
  withheldReason: null,
  basis: "cohort_median",
  ...overrides
});

const text = (lines) => lines.join("\n");

test("a published change shows the title, the organisation's summary as written, and the window", () => {
  const out = text(renderInitiatives([initiative()]));
  assert.ok(out.includes("Acme Health: Shorter review turnaround"));
  assert.ok(out.includes("Published, not scored yet."));
  assert.ok(out.includes("We are trying a one-day pickup rule."));
  assert.ok(out.includes("It starts on the 5th."), "a multi-line summary keeps its lines");
  assert.ok(out.includes("Scoring window: 5 Oct – 2 Nov 2026"), out);
  assert.ok(!out.includes("Result:"), "nothing to report before it is scored");
});

test("a scored change shows the result, the movement and the outcome in the app's words", () => {
  const out = text(renderInitiatives([initiative({ status: "scored", result: scoredResult() })]));
  assert.ok(out.includes("Scored."));
  assert.ok(out.includes("Result: 15 hours"), out);
  assert.ok(out.includes("Up 3 against frozen baseline"), out);
  assert.ok(out.includes("Moved the way declared, beyond the cohort's own variation"), out);
  assert.ok(!out.includes("moved_as_declared"), "the outcome key is never printed");
});

test("every known outcome reads in the app's words", () => {
  const expected = {
    moved_as_declared: "Moved the way declared, beyond the cohort's own variation",
    moved_against_declared: "Moved the other way, beyond the cohort's own variation",
    moved_no_direction_declared: "Moved beyond the cohort's own variation; no direction was declared",
    within_own_variation: "No further from the baseline than the cohort's own week-to-week variation",
    withheld: "Withheld"
  };
  for (const [key, words] of Object.entries(expected)) {
    const out = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ outcome: key }) })]));
    assert.ok(out.includes(words), `${key}: ${out}`);
    assert.ok(!out.includes(key), `${key} is not printed raw`);
  }
});

test("an empty outcome reads 'Not stated' and an unknown one says it isn't recognised, never the key", () => {
  const empty = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ outcome: "" }) })]));
  assert.ok(empty.includes("Not stated"), empty);
  const odd = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ outcome: "a_brand_new_outcome" }) })]));
  assert.ok(odd.includes("An outcome this app does not recognise"), odd);
  assert.ok(!odd.includes("a_brand_new_outcome"));
});

test("movement reads from the delta, in the app's words", () => {
  const down = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ value: 9, delta: -3 }) })]));
  assert.ok(down.includes("Down 3 against frozen baseline"), down);
  const flat = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ value: 12, delta: 0 }) })]));
  assert.ok(flat.includes("No change against frozen baseline"), flat);
  const missing = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ delta: null }) })]));
  assert.ok(missing.includes("No reading"), missing);
  const within = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ outcome: "within_own_variation", delta: 1 }) })]));
  assert.ok(within.includes("No material change against frozen baseline"), within);
  assert.ok(!within.includes("Up 1"), "within the cohort's own variation outranks the sign of the delta");
  for (const out of [down, flat, missing, within]) assert.ok(!/\bmovement\b|\blevel\b/.test(out));
});

test("figures print like the ledger: 5, not 5.0, and 1.1 as it is", () => {
  const out = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ value: 5.0, delta: 1.1 }) })]));
  assert.ok(out.includes("Result: 5 hours"), out);
  assert.ok(out.includes("Up 1.1 against frozen baseline"), out);
  const noise = text(renderInitiatives([initiative({ status: "scored", result: scoredResult({ value: 0.1 + 0.2, delta: 0.30000000000000004 }) })]));
  assert.ok(noise.includes("Result: 0.3 hours"), noise);
});

test("a withheld figure is shown as withheld with its reason, never as zero", () => {
  const withheld = (reason) => scoredResult({ value: null, baselineValue: null, delta: null, movement: null, outcome: "withheld", withheldReason: reason });
  for (const key of ["cohort_below_minimum", "below_minimum_cohort", "below_minimum_cohort_size"]) {
    const out = text(renderInitiatives([initiative({ status: "scored", result: withheld(key) })]));
    assert.ok(out.includes("Withheld: the cohort was too small to report on when the scoring window closed."), `${key}: ${out}`);
    assert.ok(!out.includes(key));
    assert.ok(!/Result: 0/.test(out));
  }
  const baseline = text(renderInitiatives([initiative({ status: "scored", result: withheld("baseline_withheld") })]));
  assert.ok(baseline.includes("Withheld: the baseline was withheld."), baseline);

  for (const reason of ["never_seen_before", null]) {
    const out = text(renderInitiatives([initiative({ status: "scored", result: withheld(reason) })]));
    assert.ok(out.includes("Withheld, for a reason this version of the app doesn't name yet."), out);
    assert.ok(!out.includes("never_seen_before"));
  }
});

test("a withdrawn change is shown as withdrawn, with its date, and keeps a result it already had", () => {
  const out = text(renderInitiatives([initiative({ status: "withdrawn", withdrawnUtc: "2026-10-12T09:00:00.000Z", result: scoredResult() })]));
  assert.ok(out.includes("Withdrawn on 12 Oct 2026. It won't be scored."), out);
  assert.ok(out.includes("Result: 15 hours"), "as the app does, a withdrawn change still shows its result");
  const noResult = text(renderInitiatives([initiative({ status: "withdrawn", withdrawnUtc: "2026-10-12T09:00:00.000Z" })]));
  assert.ok(!noResult.includes("Result:"));
  const undated = text(renderInitiatives([initiative({ status: "withdrawn" })]));
  assert.ok(undated.includes("Withdrawn. It won't be scored."), undated);
});

test("a status this version doesn't know is shown as not recognised, never as the raw word", () => {
  const out = text(renderInitiatives([initiative({ status: "paused" })]));
  assert.ok(out.includes("Acme Health: Shorter review turnaround"), "the change is still listed");
  assert.ok(out.includes("Status not recognised."), out);
  assert.ok(!out.includes("paused"), "the raw status word is not printed");
});

test("the declared direction is shown in words, and an unknown one says so", () => {
  assert.ok(text(renderInitiatives([initiative({ direction: "up" })])).includes("Expected to rise"));
  assert.ok(text(renderInitiatives([initiative({ direction: "down" })])).includes("Expected to fall"));
  const none = text(renderInitiatives([initiative({ direction: "none_declared" })]));
  assert.ok(none.includes("No direction declared"));
  assert.ok(!none.includes("none_declared"));
  const odd = text(renderInitiatives([initiative({ direction: "sideways" })]));
  assert.ok(odd.includes("A direction this app does not recognise"), odd);
  assert.ok(!odd.includes("sideways"));
});

test("the unit is the organisation's own word and is printed as sent", () => {
  const out = text(renderInitiatives([initiative({ measureUnit: "pull requests a week", status: "scored", result: scoredResult() })]));
  assert.ok(out.includes("Result: 15 pull requests a week"), out);
});

test("an entry that can't be read is counted, and the others are still shown", () => {
  const out = text(renderInitiatives([initiative(), { nonsense: true }, null]));
  assert.ok(out.includes("Shorter review turnaround"));
  assert.ok(out.includes("2 entries in the list couldn't be read by this version of the tool."), out);
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
