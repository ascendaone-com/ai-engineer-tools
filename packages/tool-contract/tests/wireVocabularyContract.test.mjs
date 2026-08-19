import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_WORKLOAD_CATEGORY } from "../out/index.js";

/**
 * Pins `AscendaTelemetryEventType` to the wire vocabulary the backend owns.
 *
 * The vocabulary was hand-authored twice with no mechanical link: this union in
 * TypeScript, and `WorkloadCategoryMap` in asc-core-be's
 * `Services/ToolTelemetryCatalog.cs`. Drift between them did not fail a build —
 * the backend accepted unknown types and filed them under `unclassified`, so a
 * name that existed on only one side surfaced as missing dashboard rows months
 * later rather than as a red test. That is how `@ascenda-one/history-import`
 * shipped three invented names and lost seven months of history behind a 2xx.
 *
 * `contracts/tool-telemetry-event-types.v1.json` is a vendored copy of the
 * file asc-core-be owns at `Contracts/tool-telemetry-event-types.v1.json`.
 *
 * What this test does and does not buy:
 *
 *  - It DOES fail when a type is added to this union without being added to the
 *    vendored contract, or vice versa. That is the drift that produced the bug.
 *  - It does NOT detect the vendored copy going stale against the backend's
 *    own copy. Nothing here can reach the other repo. Re-vendor the file when
 *    the backend's version bumps; the version assertion below is the tripwire
 *    that makes a bump impossible to apply silently.
 *
 * The backend catalog is deliberately a SUPERSET of this list: it also
 * classifies `supervision_interruption` and the coarse workflow/HRIS types,
 * which the org activity-signals door produces internally rather than
 * accepting from a paired client. Those are not client-emittable, so they are
 * not here and must not be added to this union.
 */

const CONTRACT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../contracts/tool-telemetry-event-types.v1.json"
);

const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8"));

test("the vendored contract is the version this union was written against", () => {
  // A bump means the backend changed the wire vocabulary's shape, not just its
  // contents. Re-read the file before raising this number.
  assert.equal(contract.version, 1);
});

test("every catalog event type is in the contract, and vice versa", () => {
  const union = Object.keys(EVENT_WORKLOAD_CATEGORY).sort();
  const wire = [...contract.eventTypes].sort();

  const missingFromUnion = wire.filter((t) => !union.includes(t));
  const missingFromContract = union.filter((t) => !wire.includes(t));

  assert.deepEqual(
    missingFromUnion,
    [],
    `the backend accepts these types but AscendaTelemetryEventType does not name them:\n  ${missingFromUnion.join("\n  ")}`
  );
  assert.deepEqual(
    missingFromContract,
    [],
    `these types are in AscendaTelemetryEventType but not in the wire contract — ` +
      `the backend would file them as unclassified:\n  ${missingFromContract.join("\n  ")}`
  );
  assert.deepEqual(union, wire);
});

test("every contract type has a workload category — none can land as unclassified", () => {
  // Presence in the union is not enough: a type with no category would be
  // accepted at ingestion and still classify as unclassified downstream.
  const uncategorised = contract.eventTypes.filter((t) => !EVENT_WORKLOAD_CATEGORY[t]);
  assert.deepEqual(
    uncategorised,
    [],
    `these wire types have no workload category:\n  ${uncategorised.join("\n  ")}`
  );
});

test("the contract lists no duplicates", () => {
  const seen = new Set(contract.eventTypes);
  assert.equal(seen.size, contract.eventTypes.length, "a duplicated type hides a real disagreement");
});
