/**
 * The quantity stamp the handoff carries — `activeTimeQuantities`.
 *
 * Two halves, and the second is the one that earns its keep.
 *
 * **The pin** checks that every quantity stamped is a name the vendored
 * contract owns, so a label this package invents fails here rather than in a
 * reader that has no way to know the name is nonsense.
 *
 * **Discovery walks the payload a real extraction produced**, not the map. A
 * map is opt-in, and the figure that causes the incident is the one nobody
 * remembered to add — starting from the map would only ever confirm the map
 * agrees with itself. So the walk collects every minute-shaped key in the
 * written document and fails on any that is neither stamped nor excused, and it
 * asserts it found a plausible number of them first so it cannot pass vacuously
 * over a fixture that stopped producing days or projects.
 *
 * The material is `fixtures/claude-session-real.jsonl` — the same real
 * transcript `activeSplit.test.mjs` runs on, which is what makes the walk reach
 * `projects[].elapsed.days[]` at all: those paths only exist once something has
 * actually measured active time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ASCENDA_ACTIVE_TIME_QUANTITIES } from "@ascenda-one/tool-contract";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import {
  buildHandoff,
  buildCodexHandoff,
  buildCursorHandoff,
  buildVsCodeHandoff
} from "../dist/localHandoff.js";
import {
  CLAUDE_CODE_ACTIVE_TIME_QUANTITIES,
  CODEX_ACTIVE_TIME_QUANTITIES,
  NOT_ACTIVE_TIME_QUANTITY_PATHS
} from "../dist/handoffActiveTime.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "claude-session-real.jsonl");

/** Stages the real transcript as a snapshot the extractor will walk. */
async function extractFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quantity-stamp-"));
  const project = path.join(dir, "projects", "-Users-example-Dev-repo-quantity-stamp");
  await fs.mkdir(project, { recursive: true });
  await fs.copyFile(FIXTURE, path.join(project, "aaaaaaaa-bbbb-cccc-dddd-000000000042.jsonl"));
  const events = [];
  for await (const event of extractClaudeCode(dir, "extraction-quantity-stamp")) events.push(event);
  await fs.rm(dir, { recursive: true, force: true });
  return events;
}

/**
 * The document as a reader receives it, not as the builder returned it.
 *
 * `writeHandoff` is `JSON.stringify`, and the round trip is what drops absent
 * optional fields — walking the in-memory object would let the test see a shape
 * the file never has.
 */
const written = (handoff) => JSON.parse(JSON.stringify(handoff));

/**
 * Figure-shaped keys are recognised by name, because these are bare JSON
 * numbers — indistinguishable by type from a count. Same trade, and the same
 * escape hatch, as the source scan in `activeTimeFigures.test.mjs`.
 */
const looksLikeFigure = (key) => /Minutes$/.test(key) || /Hours$/.test(key);

/** Every minute-shaped path in a written handoff, keyed as a reader walks it. */
function figurePaths(node, prefix = "", found = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) figurePaths(item, `${prefix}[]`, found);
    return found;
  }
  if (node === null || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number" && looksLikeFigure(key)) found.add(at);
    else figurePaths(value, at, found);
  }
  return found;
}

/* ── The pin ───────────────────────────────────────────────────────────── */

test("every stamped quantity is one the vendored contract owns", () => {
  for (const [store, stamp] of [
    ["claude_code", CLAUDE_CODE_ACTIVE_TIME_QUANTITIES],
    ["codex", CODEX_ACTIVE_TIME_QUANTITIES]
  ]) {
    for (const [figurePath, quantity] of Object.entries(stamp)) {
      assert.ok(
        ASCENDA_ACTIVE_TIME_QUANTITIES.includes(quantity),
        `${store} stamps ${figurePath} as '${quantity}', which is not a contract quantity`
      );
    }
  }
});

test("the stamp separates the two figures no gap rule can", () => {
  // The whole reason this key exists. One spelling, one nesting level apart,
  // both cut by the same gap: summed across sessions that overlap, and unioned
  // over them.
  assert.equal(
    CLAUDE_CODE_ACTIVE_TIME_QUANTITIES["projects[].handsOnMinutes"],
    "hands_on_agent_hours"
  );
  assert.equal(
    CLAUDE_CODE_ACTIVE_TIME_QUANTITIES["projects[].elapsed.handsOnMinutes"],
    "hands_on"
  );
  assert.notEqual(
    CLAUDE_CODE_ACTIVE_TIME_QUANTITIES["projects[].handsOnMinutes"],
    CLAUDE_CODE_ACTIVE_TIME_QUANTITIES["projects[].elapsed.handsOnMinutes"]
  );
});

/* ── Discovery, from the payload ───────────────────────────────────────── */

test("the walk actually reaches a real handoff's figures", async () => {
  // Without this the whole half passes just as happily over an empty document,
  // which is the failure mode a discovery guard must not have.
  const paths = figurePaths(written(buildHandoff(await extractFixture(), "x1", "2026-07-21T00:00:00.000Z")));

  assert.ok(
    paths.size >= 14,
    `the walk found only ${paths.size} figure-shaped keys — it is not reaching the payload`
  );
  // The deep ones, which only exist once something has measured active time.
  assert.ok(paths.has("sessions[].days[].handsOnMinutes"));
  assert.ok(paths.has("projects[].elapsed.days[].summedHandsOnMinutes"));
});

for (const [store, build, stamp] of [
  ["claude_code", buildHandoff, CLAUDE_CODE_ACTIVE_TIME_QUANTITIES],
  ["codex", buildCodexHandoff, CODEX_ACTIVE_TIME_QUANTITIES]
]) {
  test(`every figure the ${store} handoff writes says what it measures`, async () => {
    // Both writers are fed the same real extraction on purpose: the normalized
    // event shape is store-agnostic, and what is under test here is the writer
    // that emits the stamp, not the store reader that filled the events.
    const handoff = written(build(await extractFixture(), "x1", "2026-07-21T00:00:00.000Z"));

    const unstamped = [...figurePaths(handoff)].filter(
      (at) => !(at in stamp) && !(at in NOT_ACTIVE_TIME_QUANTITY_PATHS)
    );
    assert.deepEqual(
      unstamped,
      [],
      `these ${store} figures do not say what they measure — stamp them in ` +
        `handoffActiveTime.ts, or excuse them in NOT_ACTIVE_TIME_QUANTITY_PATHS ` +
        `with a reason:\n  ` + unstamped.join("\n  ")
    );

    // And the other direction: a stamp for a path nothing writes is a claim
    // about a file that does not exist.
    const written_ = figurePaths(handoff);
    for (const at of Object.keys(stamp)) {
      assert.ok(written_.has(at), `${store} stamps ${at}, but no ${store} handoff writes it`);
    }
    for (const [at, reason] of Object.entries(NOT_ACTIVE_TIME_QUANTITY_PATHS)) {
      assert.ok(written_.has(at), `${at} is excused (${reason}) but no longer written`);
    }

    // The stamp rides on the document, not just in the module.
    assert.deepEqual(handoff.activeTimeQuantities, stamp);
  });
}

test("the gap rule is excused rather than stamped", async () => {
  // activeGapMinutes says how the figures were cut. Stamping it would claim the
  // gap is itself a measurement of something.
  const handoff = written(buildHandoff(await extractFixture(), "x1", "2026-07-21T00:00:00.000Z"));
  assert.equal(typeof handoff.activeGapMinutes, "number");
  assert.equal(handoff.activeTimeQuantities.activeGapMinutes, undefined);
  assert.ok("activeGapMinutes" in NOT_ACTIVE_TIME_QUANTITY_PATHS);
});

test("a store with no active figures makes no claim, rather than an empty one", () => {
  // Cursor and VS Code hand over no timeline and gap-split nothing, which is
  // why they carry no gap stamp either. An empty map would read as "these
  // figures measure nothing"; absent reads as "this handoff makes no claim",
  // and for these two the second is the true statement.
  for (const build of [buildCursorHandoff, buildVsCodeHandoff]) {
    const handoff = written(build([], "x1", "2026-07-21T00:00:00.000Z"));
    assert.ok(!("activeTimeQuantities" in handoff), `${handoff.store} stamped quantities it has none of`);
    assert.ok(!("activeGapMinutes" in handoff), `${handoff.store} stamped a gap it does not cut by`);
  }
});
