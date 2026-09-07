import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASCENDA_ACTIVE_TIME_QUANTITIES,
  ASCENDA_ELAPSED_QUANTITIES,
  requireComparableQuantities,
  combineDisjointHalves
} from "../out/index.js";

/**
 * Pins `AscendaActiveTimeQuantity` to the quantity vocabulary asc-core-be owns,
 * at `Contracts/active-time-quantities.v1.json`. The file in `contracts/` here is
 * a vendored copy of it — edit it there, not here.
 *
 * The same shape as `wireVocabularyContract.test.mjs`, for the same reason and
 * with the same limit: it fails when a name is added on one side and not the
 * other, and it CANNOT detect the vendored copy going stale against the
 * backend's own copy, because nothing here can reach that repo. Re-vendor when
 * the backend's version bumps; the version assertion is the tripwire that makes
 * a bump impossible to apply silently.
 *
 * What makes this vocabulary worth pinning is the history of the one it
 * replaces. Before asc-core-be#208 the four names existed in a markdown table
 * and nowhere else — a grep for them across all three repos returned nothing —
 * while `gapMinutes` and `basis`, the other two thirds of the same documented
 * triple, were both shipped and both tested. A vocabulary that lives only in
 * prose is the `TOOL_TYPES` failure one level up: `ascenda-dev-server` kept the
 * only copy of that list, it drifted, and a real collector pairing was answered
 * with `unknown_tool_type`.
 */

const CONTRACT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../contracts/active-time-quantities.v1.json"
);

const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8"));

test("the vendored contract is the version this vocabulary was written against", () => {
  assert.equal(contract.version, 1);
});

test("every contract quantity is declared, and vice versa", () => {
  const declared = [...ASCENDA_ACTIVE_TIME_QUANTITIES].sort();
  const wire = [...contract.quantities].sort();

  assert.deepEqual(
    wire.filter((q) => !declared.includes(q)),
    [],
    "the contract names these quantities but ASCENDA_ACTIVE_TIME_QUANTITIES does not"
  );
  assert.deepEqual(
    declared.filter((q) => !wire.includes(q)),
    [],
    "these quantities are declared here but are not in the vendored contract"
  );
});

test("no vocabulary lists a duplicate", () => {
  assert.equal(
    new Set(contract.quantities).size,
    contract.quantities.length,
    "a duplicated quantity hides a real disagreement"
  );
  assert.equal(
    new Set(ASCENDA_ACTIVE_TIME_QUANTITIES).size,
    ASCENDA_ACTIVE_TIME_QUANTITIES.length,
    "ASCENDA_ACTIVE_TIME_QUANTITIES repeats a spelling"
  );
});

test("every quantity says whether it is elapsed time", () => {
  // A quantity with no entry would default to falsy and be treated as
  // agent-hours, which is the wrong way round to fail: it would quietly stop a
  // legitimate figure from being rendered as time.
  const missing = contract.quantities.filter(
    (q) => typeof contract.elapsed[q] !== "boolean"
  );
  assert.deepEqual(missing, [], `these quantities do not say if they are elapsed:\n  ${missing.join("\n  ")}`);

  for (const q of ASCENDA_ACTIVE_TIME_QUANTITIES) {
    assert.equal(
      ASCENDA_ELAPSED_QUANTITIES[q],
      contract.elapsed[q],
      `${q} disagrees with the contract about whether it is elapsed time`
    );
  }
});

test("every concurrency pair names two real quantities, summed and unioned", () => {
  // summed / unioned is meanConcurrency. If either side drifted out of the
  // vocabulary the ratio would be computed across something else entirely.
  for (const pair of contract.concurrencyPairs) {
    assert.ok(
      ASCENDA_ACTIVE_TIME_QUANTITIES.includes(pair.summed),
      `concurrency pair names unknown quantity '${pair.summed}'`
    );
    assert.ok(
      ASCENDA_ACTIVE_TIME_QUANTITIES.includes(pair.unioned),
      `concurrency pair names unknown quantity '${pair.unioned}'`
    );
    assert.equal(ASCENDA_ELAPSED_QUANTITIES[pair.summed], false, `${pair.summed} is summed, not elapsed`);
    assert.equal(ASCENDA_ELAPSED_QUANTITIES[pair.unioned], true, `${pair.unioned} is elapsed, not summed`);
  }

  assert.ok(contract.concurrencyPairs.length >= 2, "both hands-on and supervising have a summed counterpart");
});

test("hands_on plus supervising is coverage, and the contract says so", () => {
  // The correction to this file's first version, which banned this addition.
  // The halves partition the same spans, so their total is the whole; what is
  // forbidden is rendering that total as attention, which is a claim about
  // presentation rather than arithmetic.
  const { total, quantity } = combineDisjointHalves(5, "hands_on", 17, "supervising");
  assert.equal(total, 22);
  assert.equal(quantity, "coverage");

  const pair = contract.disjointHalves.find(
    (d) => d.halves.includes("hands_on") && d.halves.includes("supervising")
  );
  assert.ok(pair, "the contract declares the pair this function relies on");
  assert.equal(pair.whole, "coverage");
});

test("a pair that partitions nothing is still refused", () => {
  assert.throws(
    () => combineDisjointHalves(120, "coverage", 45, "block_coverage"),
    /do not partition a common whole/
  );
  // Disjoint too, but total agent-hours has no declared name.
  assert.throws(
    () => combineDisjointHalves(10, "hands_on_agent_hours", 20, "supervising_agent_hours"),
    /do not partition a common whole/
  );
});

test("the comparability guard still rejects an unrelated cross-quantity add", () => {
  assert.throws(
    () => requireComparableQuantities("coverage", "block_coverage", "add"),
    /combines active-time quantities/
  );
});

test("the guard rejects quoting agent-hours as elapsed time", () => {
  assert.throws(
    () => requireComparableQuantities("hands_on_agent_hours", "hands_on", "add"),
    /hands_on_agent_hours.*hands_on/
  );
});

test("the guard allows a difference within one quantity", () => {
  // Without this the guard would be a blanket ban on arithmetic, and a period
  // delta is a legitimate subtraction.
  assert.doesNotThrow(() => requireComparableQuantities("hands_on", "hands_on", "subtract"));
});
