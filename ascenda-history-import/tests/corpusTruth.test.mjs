import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCorpus, SHAPE_FLAGS, TRUTH_KEYS } from "./support/corpus.mjs";
import { extractCorpus, shippedFigures, sortedTruth, truthKeysOf } from "./support/corpusRun.mjs";

// The generator writes transcripts and records what a correct reader must
// report for them. These tests run the shipped extractors over those
// transcripts and compare every figure.
//
// A case the extractor gets wrong today, because of a bug with an open plan,
// is a `todo` that links the plan. It runs, and it fails, and the run still
// passes. When the fix lands the case starts passing; delete its entry below.

const PLAN = (n) => `https://github.com/ascendaone-com/ai-engineer-tools/pull/${n}`;

/** Shape flags whose cases fail today, per store, with the plan that fixes them. */
const OPEN = {
  claude_code: {},
  codex: {}
};

function openPlanFor(store, flags) {
  for (const flag of flags) if (OPEN[store][flag]) return OPEN[store][flag];
  return false;
}

async function check(store, { seed, sessions, flags }) {
  const corpus = generateCorpus({ seed, sessions, store, shape: flags });
  const events = await extractCorpus(store, corpus.files);
  assert.deepEqual(shippedFigures(store, events), sortedTruth(corpus.truth));
}

for (const store of Object.keys(SHAPE_FLAGS)) {
  test(`${store}: no flags`, async () => {
    await check(store, { seed: 1, sessions: 5, flags: [] });
  });

  for (const flag of SHAPE_FLAGS[store]) {
    test(`${store}: ${flag}`, { todo: openPlanFor(store, [flag]) }, async () => {
      await check(store, { seed: 1, sessions: 5, flags: [flag] });
    });
  }

  const closed = SHAPE_FLAGS[store].filter((flag) => !OPEN[store][flag]);
  for (let seed = 1; seed <= 20; seed += 1) {
    test(`${store}: every flag that passes today, seed ${seed}`, async () => {
      await check(store, { seed, sessions: 5, flags: closed });
    });
  }
  for (let seed = 1; seed <= 20; seed += 1) {
    test(`${store}: every flag, seed ${seed}`, { todo: openPlanFor(store, SHAPE_FLAGS[store]) }, async () => {
      await check(store, { seed, sessions: 5, flags: SHAPE_FLAGS[store] });
    });
  }
}

test("truth carries every key the comparison reads", () => {
  for (const store of Object.keys(SHAPE_FLAGS)) {
    const [session] = generateCorpus({ seed: 1, sessions: 1, store, shape: [] }).truth.sessions;
    for (const key of truthKeysOf(store)) assert.ok(key in session, `${store} truth lacks ${key}`);
    assert.ok(TRUTH_KEYS.every((key) => truthKeysOf(store).includes(key)));
  }
});

// A smoke test for performance regressions, off by default. Totals only, and
// the elapsed time is printed rather than asserted.
test("2,000 sessions per store, totals only", { skip: process.env.ASCENDA_SLOW_TESTS !== "1" }, async () => {
  for (const store of Object.keys(SHAPE_FLAGS)) {
    const closed = SHAPE_FLAGS[store].filter((flag) => !OPEN[store][flag]);
    const corpus = generateCorpus({ seed: 7, sessions: 2000, store, shape: closed });
    const started = Date.now();
    const events = await extractCorpus(store, corpus.files);
    const elapsed = Date.now() - started;
    const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
    const shipped = shippedFigures(store, events);
    const truth = sortedTruth(corpus.truth);
    assert.equal(shipped.length, truth.length);
    for (const key of ["promptCount", "mainThreadToolCallCount", "toolFailureCount", "inputTokens", "outputTokens"]) {
      assert.equal(sum(shipped, key), sum(truth, key), `${store} ${key}`);
    }
    console.log(`# ${store}: ${truth.length} sessions in ${elapsed} ms`);
  }
});
