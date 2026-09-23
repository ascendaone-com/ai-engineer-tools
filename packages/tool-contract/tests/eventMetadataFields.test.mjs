import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_METADATA_DISCLOSURE, EVENT_METADATA_FIELDS, METRIC_KEYS } from "../out/index.js";

/**
 * `EVENT_METADATA_FIELDS` is a hand-written mirror of the named fields on the
 * `AscendaEventMetadata` type, kept so hook-adapter guard tests can check the
 * keys a mapper emits at runtime. TypeScript cannot pin the two together —
 * the type is intersected with `Record<string, …>`, so `keyof` is just
 * `string` — so this test reads the field declarations straight out of the
 * source and compares. A field added to one side and not the other fails
 * here rather than becoming a key an adapter is allowed to emit but nothing
 * documents, or a documented key the guard would wrongly reject.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts");

function declaredMetadataFields() {
  const text = fs.readFileSync(SRC, "utf8");
  const start = text.indexOf("export type AscendaEventMetadata =");
  assert.ok(start >= 0, "AscendaEventMetadata moved — update this scan");
  const end = text.indexOf("\n};", start);
  const block = text.slice(start, end);
  return [...block.matchAll(/^\s+(\w+)\?:/gm)].map((m) => m[1]);
}

test("the runtime field list matches the fields declared on AscendaEventMetadata", () => {
  const declared = declaredMetadataFields();
  assert.ok(declared.length > 10, "found too few fields — did the scan break?");
  assert.deepEqual([...EVENT_METADATA_FIELDS].sort(), [...declared].sort());
});

test("durationBucket is both a metadata field and a registered metric key — one bucketer feeds both", () => {
  assert.ok(EVENT_METADATA_FIELDS.includes("durationBucket"));
  assert.ok(METRIC_KEYS.durationBucket);
});

/**
 * The disclosure half of the same mirror.
 *
 * A field can be added to the type and the runtime list, compile, ship and be
 * read by a backend reader without anyone having been told it leaves — that is
 * the whole defect class this map exists for, and it is invisible to review
 * because each addition is fine on its own. So the two lists are pinned to each
 * other: a field with no family fails here, at the declaration, rather than
 * silently defaulting to undisclosed.
 */
test("every named metadata field is classified, and nothing is classified twice over", () => {
  const fields = [...EVENT_METADATA_FIELDS].sort();
  const classified = Object.keys(EVENT_METADATA_DISCLOSURE).sort();

  const undisclosed = fields.filter((f) => !classified.includes(f));
  assert.deepEqual(
    undisclosed,
    [],
    `these fields reach the wire with no disclosure family:\n  ${undisclosed.join(", ")}\n\n` +
      "Give it a family if it says anything about how the work went, or transport/local " +
      "with the reason. A field nobody classified is a field nobody was told about."
  );

  const stale = classified.filter((f) => !fields.includes(f));
  assert.deepEqual(
    stale,
    [],
    `these are classified and are no longer metadata fields:\n  ${stale.join(", ")}`
  );
});

test("every metric key carries a family", () => {
  const missing = Object.entries(METRIC_KEYS)
    .filter(([, spec]) => !spec.family)
    .map(([key]) => key);
  assert.deepEqual(missing, [], `metric keys with no disclosure family:\n  ${missing.join(", ")}`);
});
