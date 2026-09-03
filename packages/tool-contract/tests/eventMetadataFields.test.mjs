import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_METADATA_FIELDS, METRIC_KEYS } from "../out/index.js";

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
