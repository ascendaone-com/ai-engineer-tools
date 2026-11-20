import "./isolateHome.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCorpus, SHAPE_FLAGS } from "./support/corpus.mjs";
import { extractCorpus } from "./support/corpusRun.mjs";

// The same seed gives the same bytes, and the extractor gives the same events
// in the same order for them. The second half is also what pins the order the
// extractors emit in: a change that reshuffles it fails here.

for (const store of Object.keys(SHAPE_FLAGS)) {
  const options = { seed: 11, sessions: 6, store, shape: SHAPE_FLAGS[store] };

  test(`${store}: one seed, byte-identical files`, () => {
    const first = generateCorpus(options);
    const second = generateCorpus(options);
    assert.deepEqual(first.files, second.files);
    assert.deepEqual(first.truth, second.truth);
  });

  test(`${store}: different seeds differ`, () => {
    const other = generateCorpus({ ...options, seed: 12 });
    assert.notDeepEqual(generateCorpus(options).files, other.files);
  });

  test(`${store}: the extractor's output is identical twice running`, async () => {
    const { files } = generateCorpus(options);
    const first = await extractCorpus(store, files);
    const second = await extractCorpus(store, files);
    assert.ok(first.length > 0);
    assert.deepEqual(first, second);
  });
}

test("no generated line carries a real path or a home directory", () => {
  for (const store of Object.keys(SHAPE_FLAGS)) {
    const { files } = generateCorpus({ seed: 3, sessions: 8, store, shape: SHAPE_FLAGS[store] });
    const text = files.map((f) => f.text).join("\n");
    const paths = text.match(/\/Users\/[A-Za-z0-9_.-]+/g) ?? [];
    assert.ok(paths.length > 0);
    assert.ok(paths.every((p) => p === "/Users/example"), `${store}: ${[...new Set(paths)].join(", ")}`);
  }
});
