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
 * other. Nothing here can still reach `asc-core-be` — it is private and in
 * another org, and this repo holds no token for it — so the staleness half of
 * the problem is answered from the other end. `asc-core-be`'s own
 * `Vendored contract fanout` workflow fetches THIS file (this repo is public,
 * so no credential is needed) and diffs it. That closes the direction that
 * actually matters: the drift starts with an edit there.
 *
 * What is left for this file is the direction that check cannot see — someone
 * editing the vendored copy here, in place, and moving the constants to match
 * so that every assertion below still passes. That is what the pinned
 * projection catches, and why it is a literal rather than something derived.
 * Re-vendoring is a two-line change: replace `contracts/…v1.json`, then paste
 * the new projection here.
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

/**
 * The exact contract asc-core-be owns, as of 8 Sep 2026.
 *
 * Print the current value there with
 *   `python3 Scripts/check_vendored_contracts.py --projection`
 * and paste it whole. It is deliberately the string and not a hash of it: the
 * whole contract fits on a line, so a failure here diffs into something you
 * can read instead of two digests that differ by an unknown amount.
 *
 * `$comment` is excluded at every depth, which is why the one-line VENDORED
 * COPY banner at the top of the local file does not appear. Prose is not
 * contract; a reworded comment in the backend must not red this repo.
 */
const OWNER_PROJECTION =
  '{"concurrencyPairs":[{"summed":"hands_on_agent_hours","unioned":"hands_on"},' +
  '{"summed":"supervising_agent_hours","unioned":"supervising"}],' +
  '"disjointHalves":[{"halves":["hands_on","supervising"],"whole":"coverage"}],' +
  '"elapsed":{"block_coverage":true,"coverage":true,"hands_on":true,' +
  '"hands_on_agent_hours":false,"supervising":true,' +
  '"supervising_agent_hours":false},' +
  '"quantities":["coverage","hands_on","supervising","block_coverage",' +
  '"hands_on_agent_hours","supervising_agent_hours"],"version":1}';

/** The semantic fields. Anything not named here is prose or local decoration. */
const SEMANTIC_FIELDS = ["version", "quantities", "elapsed", "concurrencyPairs", "disjointHalves"];

const stripComments = (node) =>
  Array.isArray(node)
    ? node.map(stripComments)
    : node && typeof node === "object"
      ? Object.fromEntries(
          Object.entries(node)
            .filter(([key]) => key !== "$comment")
            .map(([key, value]) => [key, stripComments(value)])
        )
      : node;

// Key order is fixed by sorting rather than left to insertion order, so this
// agrees byte for byte with the Python that produced OWNER_PROJECTION and with
// the Dart that pins the same string in the app workspace.
const canonicalise = (node) =>
  Array.isArray(node)
    ? "[" + node.map(canonicalise).join(",") + "]"
    : node && typeof node === "object"
      ? "{" +
        Object.keys(node)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + canonicalise(node[key]))
          .join(",") +
        "}"
      : JSON.stringify(node);

test("the vendored copy is byte-for-byte the contract asc-core-be owns", () => {
  const missing = SEMANTIC_FIELDS.filter((field) => !(field in contract));
  assert.deepEqual(missing, [], "the vendored copy is missing semantic field(s)");

  const projection = canonicalise(
    Object.fromEntries(SEMANTIC_FIELDS.map((field) => [field, stripComments(contract[field])]))
  );

  assert.equal(
    projection,
    OWNER_PROJECTION,
    "contracts/active-time-quantities.v1.json no longer matches the copy in " +
      "asc-core-be that OWNER_PROJECTION was pinned from. Either it was edited " +
      "here — don't; edit it there and re-vendor — or it was re-vendored " +
      "without updating OWNER_PROJECTION above."
  );
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
