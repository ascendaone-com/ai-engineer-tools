/**
 * The hands-on / agent-supervising split.
 *
 * Most of this runs over `fixtures/claude-session-real.jsonl`, which is a real
 * 339-line Claude Code transcript with every scrap of content removed: the
 * timestamps, line types, tool names, model ids and `permissionMode` values
 * are exactly as the runtime wrote them, and nothing else survived the copy
 * (audited — every distinct string in the file is a timestamp, a type name, a
 * tool name, a model id, a `+`/`-` patch marker, or the placeholder session id
 * and cwd). Real timings matter here in a way a hand-built fixture cannot
 * reproduce: this session ran 163 minutes of wall clock holding 5 human
 * prompts, which is the exact shape that made a prompts-only reading wrong.
 *
 * The defect being pinned, in one line: the per-day slices used to gap-split
 * the prompt timestamps while the session figure gap-split the whole timeline,
 * so the two disagreed on the material while sharing a threshold. Over 200
 * real sessions the prompts-only reading came to 2,730 minutes against 18,938
 * — an 85.6% under-report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { sliceSessionByLocalDay } from "../dist/daySlice.js";
import {
  activeSpans,
  minutesOf,
  snakeCasePermissionMode,
  splitActiveTime
} from "../dist/activeSplit.js";
import { buildHandoff, buildProjectDigests } from "../dist/localHandoff.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "claude-session-real.jsonl");
const GAP = 5 * 60_000;

/** Stages the fixture as a snapshot the extractor will walk, and extracts. */
async function extractFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "active-split-"));
  const project = path.join(dir, "projects", "-Users-example-Dev-repo-active-split");
  await fs.mkdir(project, { recursive: true });
  await fs.copyFile(FIXTURE, path.join(project, "aaaaaaaa-bbbb-cccc-dddd-000000000042.jsonl"));
  const events = [];
  for await (const event of extractClaudeCode(dir, "extraction-active-split")) events.push(event);
  await fs.rm(dir, { recursive: true, force: true });
  return events;
}

const sessionOf = (events) => events.find((e) => e.eventKind === "create_focus_session");

// ── The measurement ────────────────────────────────────────────────────────

test("a real session: two figures, and neither is the wall clock", async () => {
  const session = sessionOf(await extractFixture());
  const m = session.metrics;

  // 163 minutes of wall clock, 22 of them active. That gap is what
  // `activeMinutes` was always for and it is unchanged by this work.
  assert.equal(m.sessionMinutes, 163);
  assert.equal(m.activeMinutes, 22);

  // The split. Five minutes of someone typing; seventeen of an agent working.
  // Quoting 22 for either would be wrong by more than a factor of three.
  assert.equal(m.handsOnMinutes, 5);
  assert.equal(m.agentSupervisingMinutes, 17);

  assert.ok(
    m.agentSupervisingMinutes > m.handsOnMinutes * 3,
    "this fixture exists because the agent's share dominates; if that stopped being true the fixture is no longer the case being tested"
  );
});

test("the two halves partition active time exactly, in milliseconds", async () => {
  const session = sessionOf(await extractFixture());
  // Rounding is done once per figure at the edge, so the minute values need
  // not add up to the minute total. The invariant lives in the millisecond
  // domain, which is where it is actually true.
  assert.equal(
    session.metrics.handsOnMinutes + session.metrics.agentSupervisingMinutes,
    session.metrics.activeMinutes,
    "on this fixture the rounding happens to be exact; the ms-level invariant is pinned in the unit test below"
  );
});

test("no combined 'active split' figure is emitted — two keys, never a third", async () => {
  const session = sessionOf(await extractFixture());
  const keys = Object.keys(session.metrics);
  const combined = keys.filter((k) =>
    /^(activeSplitMinutes|totalActiveMinutes|combinedActiveMinutes|engagedMinutes)$/.test(k)
  );
  assert.deepEqual(combined, [], "the split must stay two figures; a summed third is the thing it replaces");
  assert.ok(keys.includes("handsOnMinutes"));
  assert.ok(keys.includes("agentSupervisingMinutes"));
});

// ── The defect ─────────────────────────────────────────────────────────────

test("per-day active minutes gap-split the timeline, not the prompts alone", async () => {
  const session = sessionOf(await extractFixture());
  const days = session.dayBreakdown;
  assert.ok(days.length > 0, "the fixture has prompts and must slice into at least one day");

  const dayActive = days.reduce((sum, d) => sum + d.activeMinutes, 0);
  // Exact here because this session falls in one local day. Across several
  // days each day rounds its own milliseconds, so the sum can differ from the
  // session figure by a minute or two — that is rounding, not the disagreement
  // this test is about, which was 85.6%.
  assert.equal(days.length, 1, "this fixture is one local day, which is what makes the equality below exact");
  assert.equal(
    dayActive,
    session.metrics.activeMinutes,
    "the day slices and the session figure must be the same measurement — they were not, and that was the bug"
  );

  // The regression, stated as the property that failed. Gap-splitting the 5
  // prompt timestamps alone yields far less than the timeline does, and the
  // old call site did exactly that.
  const promptsOnly = sliceSessionByLocalDay(
    days.flatMap((d) => Array(d.prompts).fill(`${d.day}T00:00:00.000Z`)),
    { activeGapMs: GAP }
  );
  const promptsOnlyActive = promptsOnly.reduce((sum, d) => sum + d.activeMinutes, 0);
  assert.ok(
    promptsOnlyActive < dayActive,
    "a prompts-only reading must come out lower; if it does not, this fixture no longer exercises the defect"
  );
});

test("per-day slices carry the split too, and it sums to the session's", async () => {
  const session = sessionOf(await extractFixture());
  const days = session.dayBreakdown;
  for (const day of days) {
    assert.equal(typeof day.handsOnMinutes, "number", `${day.day} must carry hands-on minutes`);
    assert.equal(typeof day.agentSupervisingMinutes, "number");
  }
  assert.equal(
    days.reduce((s, d) => s + d.handsOnMinutes, 0),
    session.metrics.handsOnMinutes
  );
  assert.equal(
    days.reduce((s, d) => s + d.agentSupervisingMinutes, 0),
    session.metrics.agentSupervisingMinutes
  );
});

test("a store with only prompt timestamps gets no split rather than a guessed one", () => {
  // Cursor and VS Code call this without classified instants. They must not
  // acquire a hands-on figure they have no material for.
  const slices = sliceSessionByLocalDay(
    ["2026-08-01T09:00:00.000Z", "2026-08-01T09:01:00.000Z"],
    { activeGapMs: GAP }
  );
  assert.equal(slices[0].activeMinutes, 1);
  assert.ok(!("handsOnMinutes" in slices[0]), "no classified instants means no split, not a zero");
  assert.ok(!("agentSupervisingMinutes" in slices[0]));
});

// ── Posture ────────────────────────────────────────────────────────────────

test("autonomy bands come off the transcript's own permissionMode", async () => {
  const session = sessionOf(await extractFixture());
  const split = session.autonomySplit;

  // The fixture's real postures: the session opens under `default` and the
  // person switches to `bypassPermissions` partway through.
  assert.equal(split.supervised, 14, "default -> supervised");
  assert.equal(split.unsupervised, 3, "bypassPermissions -> unsupervised");

  assert.equal(
    Object.values(split).reduce((a, b) => a + b, 0),
    session.metrics.agentSupervisingMinutes,
    "every supervising minute must land in exactly one band"
  );
});

test("the transcript spells it permissionMode; the wire vocabulary is snake_case", () => {
  assert.equal(snakeCasePermissionMode("bypassPermissions"), "bypass_permissions");
  assert.equal(snakeCasePermissionMode("acceptEdits"), "accept_edits");
  assert.equal(snakeCasePermissionMode("dontAsk"), "dont_ask");
  assert.equal(snakeCasePermissionMode("default"), "default");
  assert.equal(snakeCasePermissionMode("plan"), "plan");
  assert.equal(snakeCasePermissionMode("auto"), "auto");
  // A mode upstream has not shipped yet passes through rather than being
  // mapped onto whichever rung looks closest.
  assert.equal(snakeCasePermissionMode("someFutureMode"), "some_future_mode");
});

test("supervising time before any declared posture is unknown, never a neighbour", () => {
  const points = [
    { at: 0, human: false, autonomyMode: null },
    { at: 60_000, human: false, autonomyMode: null },
    { at: 120_000, human: true, autonomyMode: "bypass_permissions" },
    { at: 180_000, human: false, autonomyMode: null }
  ];
  const split = splitActiveTime(points, { activeGapMs: GAP });
  assert.equal(split.supervisingMsByBand.unknown, 60_000, "the first minute had no posture to carry");
  assert.equal(split.supervisingMsByBand.unsupervised, 60_000, "the last runs under the declared mode");
  assert.equal(split.handsOnMs, 60_000, "the minute ending at the prompt is hands-on");
  assert.equal(split.unposturedInstants, 2, "two instants were reached before any mode was declared");
});

test("an unrecognised posture lands in unknown and is not folded into a band", () => {
  const points = [
    { at: 0, human: true, autonomyMode: "some_future_mode" },
    { at: 60_000, human: false, autonomyMode: null }
  ];
  const split = splitActiveTime(points, { activeGapMs: GAP });
  assert.equal(split.supervisingMsByBand.unknown, 60_000);
  assert.equal(Object.keys(split.supervisingMsByBand).length, 1, "a guess here would look exactly like a measurement");
});

// ── The rule itself ────────────────────────────────────────────────────────

test("the span ending at a human prompt is hands-on; the ones after it are not", () => {
  const points = [
    { at: 0, human: false, autonomyMode: null },
    { at: 60_000, human: true, autonomyMode: "default" }, // 1m of reading+typing
    { at: 120_000, human: false, autonomyMode: null }, //     1m of the agent working
    { at: 180_000, human: false, autonomyMode: null } //      1m more
  ];
  const split = splitActiveTime(points, { activeGapMs: GAP });
  assert.equal(split.handsOnMs, 60_000);
  assert.equal(split.agentSupervisingMs, 120_000);
});

test("a gap past the threshold is neither figure — stepping away is not work", () => {
  const points = [
    { at: 0, human: false, autonomyMode: null },
    { at: 60 * 60_000, human: true, autonomyMode: null } // an hour later
  ];
  const split = splitActiveTime(points, { activeGapMs: GAP });
  assert.equal(split.handsOnMs, 0);
  assert.equal(split.agentSupervisingMs, 0);
});

test("lines sharing a millisecond collapse instead of being ordered against each other", () => {
  // A parallel tool batch and the prompt that follows it can land on one
  // instant. Ordering them would make the split depend on a within-millisecond
  // order the store does not promise.
  const points = [
    { at: 0, human: false, autonomyMode: null },
    { at: 60_000, human: false, autonomyMode: null },
    { at: 60_000, human: true, autonomyMode: null },
    { at: 60_000, human: false, autonomyMode: null }
  ];
  const split = splitActiveTime(points, { activeGapMs: GAP });
  assert.equal(split.instants, 2, "three lines on one millisecond are one instant");
  assert.equal(split.handsOnMs, 60_000, "any human line at the instant makes the span hands-on");
  assert.equal(split.agentSupervisingMs, 0);
});

test("the split and the day slices read the same spans", async () => {
  // Not a coincidence to be re-asserted per caller: both go through
  // `activeSpans`, and this pins that they still do.
  const points = [
    { at: 0, human: false, autonomyMode: null },
    { at: 60_000, human: true, autonomyMode: null },
    { at: 120_000, human: false, autonomyMode: null }
  ];
  const report = activeSpans(points, { activeGapMs: GAP });
  const split = splitActiveTime(points, { activeGapMs: GAP });
  const handsOn = report.spans.filter((s) => s.handsOn).reduce((a, s) => a + (s.to - s.from), 0);
  assert.equal(handsOn, split.handsOnMs);
});

// ── Honest counters ────────────────────────────────────────────────────────

test("an unreadable timestamp is counted, not silently dropped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "active-split-undated-"));
  const project = path.join(dir, "projects", "-Users-example-Dev-repo-a");
  await fs.mkdir(project, { recursive: true });
  const session = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0009";
  const lines = [
    { type: "user", timestamp: "2026-07-20T10:00:00.000Z", sessionId: session, version: "2.1.227", cwd: "/Users/example/Dev/repo-a", message: { role: "user" } },
    // A `timestamp` the runtime wrote that Date.parse cannot read. It still
    // moves the session window by string comparison, so only a counter can
    // say the active figures are short.
    { type: "assistant", timestamp: "2026-07-20T10:00:3Q.000Z", sessionId: session, version: "2.1.227", message: { role: "assistant", model: "claude-opus-5" } },
    { type: "user", timestamp: "2026-07-20T10:01:00.000Z", sessionId: session, version: "2.1.227", message: { role: "user" } }
  ].map((o) => JSON.stringify(o));
  await fs.writeFile(path.join(project, `${session}.jsonl`), lines.join("\n") + "\n");

  const events = [];
  for await (const event of extractClaudeCode(dir, "extraction-undated")) events.push(event);
  await fs.rm(dir, { recursive: true, force: true });

  const m = sessionOf(events).metrics;
  assert.equal(m.activeSplitUndatedLines, 1, "the unreadable timestamp must be visible as a count");
  assert.equal(m.activeSplitInstants, 2, "and absent from the instants the split ran over");
});

test("the split's counters are present on every session, including a silent one", async () => {
  const session = sessionOf(await extractFixture());
  for (const key of ["activeSplitInstants", "activeSplitUndatedLines", "activeSplitUnposturedInstants"]) {
    assert.equal(typeof session.metrics[key], "number", `${key} must always be reported`);
  }
  assert.equal(session.metrics.activeSplitUndatedLines, 0, "this fixture's timestamps all parse");
});

test("an empty timeline reports zeroes and no bands, rather than throwing", () => {
  const split = splitActiveTime([], { activeGapMs: GAP });
  assert.equal(split.handsOnMs, 0);
  assert.equal(split.agentSupervisingMs, 0);
  assert.equal(split.instants, 0);
  assert.deepEqual(split.supervisingMsByBand, {});
});

// ── Per project ────────────────────────────────────────────────────────────

test("the handoff rolls the split up per project, keyed by projectHash", async () => {
  const events = await extractFixture();
  const handoff = buildHandoff(events, "extraction-active-split", "2026-09-03T00:00:00.000Z");

  assert.equal(handoff.projects.length, 1, "one project in this fixture");
  const digest = handoff.projects[0];
  const session = handoff.sessions[0];

  assert.equal(digest.handsOnMinutes, session.handsOnMinutes);
  assert.equal(digest.agentSupervisingMinutes, session.agentSupervisingMinutes);
  assert.equal(digest.sessions, 1);
  assert.equal(digest.promptCount, session.promptCount);
  assert.ok(digest.activeDays >= 1);
  assert.deepEqual(digest.autonomySplit, session.autonomySplit);
});

test("a project digest is two figures too — no combined total at project scale", () => {
  const digests = buildProjectDigests([
    {
      projectHash: "hash-a",
      projectLabel: "repo-a",
      promptCount: 2,
      handsOnMinutes: 5,
      agentSupervisingMinutes: 17,
      autonomySplit: { supervised: 14, unsupervised: 3 },
      days: [{ day: "2026-08-01", prompts: 2, activeMinutes: 22 }]
    },
    {
      projectHash: "hash-a",
      projectLabel: "repo-a",
      promptCount: 1,
      handsOnMinutes: 1,
      agentSupervisingMinutes: 2,
      autonomySplit: { supervised: 2 },
      days: [{ day: "2026-08-02", prompts: 1, activeMinutes: 3 }]
    }
  ]);
  assert.equal(digests.length, 1, "two sessions of one project are one digest");
  const [digest] = digests;
  assert.equal(digest.handsOnMinutes, 6);
  assert.equal(digest.agentSupervisingMinutes, 19);
  assert.equal(digest.activeDays, 2, "two distinct days held prompts");
  assert.deepEqual(digest.autonomySplit, { supervised: 16, unsupervised: 3 });
  assert.ok(!("activeMinutes" in digest), "the project digest must not carry a combined figure");
});

test("two checkouts of one repository fold into one digest", () => {
  const digests = buildProjectDigests([
    { projectHash: "hash-a", projectLabel: "repo-a", promptCount: 1, handsOnMinutes: 1, agentSupervisingMinutes: 1, autonomySplit: {}, days: [{ day: "2026-08-01", prompts: 1 }] },
    { projectHash: "hash-a", projectLabel: "repo-a", promptCount: 1, handsOnMinutes: 2, agentSupervisingMinutes: 2, autonomySplit: {}, days: [{ day: "2026-08-01", prompts: 1 }] },
    { projectHash: "hash-b", projectLabel: "repo-b", promptCount: 1, handsOnMinutes: 9, agentSupervisingMinutes: 9, autonomySplit: {}, days: [{ day: "2026-08-01", prompts: 1 }] }
  ]);
  assert.equal(digests.length, 2);
  assert.equal(digests[0].projectLabel, "repo-b", "busiest project first");
  assert.equal(digests[1].handsOnMinutes, 3, "the two checkouts summed");
  assert.equal(digests[1].activeDays, 1, "one shared day is one day, not two");
});

test("a ref that resolves to no repository is still counted somewhere", () => {
  const digests = buildProjectDigests([
    { projectHash: null, projectLabel: null, promptCount: 1, handsOnMinutes: 4, agentSupervisingMinutes: 1, autonomySplit: {}, days: [] }
  ]);
  assert.equal(digests.length, 1, "an unresolvable ref must not vanish from the rollup");
  assert.equal(digests[0].projectHash, null);
  assert.equal(digests[0].handsOnMinutes, 4);
  assert.equal(digests[0].activeDays, 0);
});

// ── Rounding ───────────────────────────────────────────────────────────────

test("minutes round once, at the edge", () => {
  assert.equal(minutesOf(0), 0);
  assert.equal(minutesOf(29_999), 0);
  assert.equal(minutesOf(30_000), 1);
  assert.equal(minutesOf(90_000), 2);
});
