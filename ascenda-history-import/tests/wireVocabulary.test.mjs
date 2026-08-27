/**
 * The wire vocabulary guard.
 *
 * `eventKind` used to be typed `string` and was cast straight onto the wire.
 * That let this package invent three event names the catalog had never heard
 * of (`historical_ai_session`, `historical_epoch_marker`,
 * `historical_ai_edit_day`). The backend does not validate event types at
 * ingestion — it accepts them and buckets unknowns as `unclassified` — so the
 * import reported success while the events landed where no view reads them.
 *
 * TypeScript now enforces this at compile time. These tests enforce it again
 * at runtime, because the failure is silent end to end: nothing upstream or
 * downstream raises when a name is wrong, so the only place it can be caught
 * is here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_WORKLOAD_CATEGORY } from "@ascenda-one/tool-contract";
import { shippableEvents, toWirePayload } from "../dist/ship.js";
import { EXTRACTION_EPOCH_KIND } from "../dist/types.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const CANONICAL = new Set(Object.keys(EVENT_WORKLOAD_CATEGORY));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []
  );
}

test("every eventKind this package emits is canonical, or the local-only epoch marker", () => {
  const offenders = [];
  const seen = new Set();
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/eventKind:\s*"([^"]+)"/g)) {
      const kind = m[1];
      seen.add(kind);
      if (kind !== EXTRACTION_EPOCH_KIND && !CANONICAL.has(kind)) {
        offenders.push(`${path.relative(SRC, file)}: ${kind}`);
      }
    }
  }
  assert.ok(seen.size > 0, "found no eventKind literals — did the scan path break?");
  assert.deepEqual(
    offenders,
    [],
    `off-catalog event kinds would ship and be bucketed as unclassified:\n  ${offenders.join("\n  ")}`
  );
});

test("the extraction epoch marker never reaches the wire", () => {
  const epoch = {
    occurredAt: "2026-08-19T02:00:00.000Z",
    store: "claude_code",
    sourceVersion: null,
    sessionRef: null,
    repoRef: null,
    eventKind: EXTRACTION_EPOCH_KIND,
    metrics: { windowOldest: "2026-01-01T00:00:00.000Z", windowNewest: "2026-08-19T00:00:00.000Z", sessionCount: 312 },
    provenance: "historical_derived",
    extractionId: "x1"
  };
  const session = { ...epoch, eventKind: "create_focus_session", sessionRef: "s1", metrics: { promptCount: 12 } };

  const wire = shippableEvents([epoch, session, epoch]);
  assert.deepEqual(wire.map((e) => e.eventKind), ["create_focus_session"]);
});

test("a shipped payload's eventType is a catalog type the backend will classify", () => {
  const payload = toWirePayload(
    {
      occurredAt: "2026-08-19T02:00:00.000Z",
      store: "vscode",
      sourceVersion: "1",
      sessionRef: null,
      repoRef: "/Users/x/proj",
      eventKind: "editor_activity",
      metrics: { date: "2026-08-19", chatEditCount: 9, totalEntryCount: 40 },
      provenance: "historical_derived",
      extractionId: "x1"
    },
    0,
    "vscode_extension:abc"
  );
  assert.ok(
    CANONICAL.has(payload.eventType),
    `${payload.eventType} is not in the catalog — it would store as unclassified`
  );
  assert.equal(EVENT_WORKLOAD_CATEGORY[payload.eventType], "neutral");
});

/**
 * The duration-bucket half of the same guard.
 *
 * This package once minted its own duration vocabulary — `"0-5m" | "5-30m" |
 * "30m-2h" | "2-8h" | "8-24h" | "24h+"` — a third dialect matching neither the
 * live collectors' tool-contract buckets nor the backend's reader. Every
 * imported session therefore carried a `durationBucket` no one could read.
 * The extractors now route through `bucketDurationMs` from `@ascenda-one/tool-kit`,
 * which is the single producer of the field and is itself pinned against the
 * backend's reader in `packages/tool-kit/tests/buckets.test.cjs`.
 *
 * Reusing the shared function is what makes the drift structurally impossible;
 * this test is what stops someone hand-rolling a bucket again, because the
 * failure mode is silent — a bucket the reader cannot spell resolves to 0
 * minutes and presents as "not collected".
 */
const SUPERSEDED_DIALECT = ["0-5m", "5-30m", "30m-2h", "2-8h", "8-24h", "24h+"];

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no extractor mints its own duration vocabulary", () => {
  const offenders = [];
  for (const file of sourceFiles(SRC)) {
    // Comments are stripped first. The names appear in prose that explains
    // precisely why they are gone — that history is worth keeping, and it is
    // not what would ship.
    const text = stripComments(fs.readFileSync(file, "utf8"));
    for (const bucket of SUPERSEDED_DIALECT) {
      if (text.includes(`"${bucket}"`) || text.includes(`'${bucket}'`)) {
        offenders.push(`${path.relative(SRC, file)}: ${bucket}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `superseded duration buckets would ship and read as 0 minutes:\n  ${offenders.join("\n  ")}`
  );
});

test("every extractor that sets durationBucket routes through the shared bucketer", () => {
  const offenders = [];
  let checked = 0;
  // Extractors only: they are what derive a bucket from a duration. Everything
  // downstream (localHandoff, ship) relays whatever an extractor produced and
  // never mints one, so scanning those would flag a pass-through.
  for (const file of sourceFiles(path.join(SRC, "extractors"))) {
    const text = fs.readFileSync(file, "utf8");
    if (!/durationBucket[:\s]/.test(text)) continue;
    checked++;
    if (!text.includes("bucketDurationMs")) {
      offenders.push(path.relative(SRC, file));
    }
  }
  assert.ok(checked > 0, "found no durationBucket producers — did the scan path break?");
  assert.deepEqual(offenders, [], `these set durationBucket without the shared bucketer:\n  ${offenders.join("\n  ")}`);
});
