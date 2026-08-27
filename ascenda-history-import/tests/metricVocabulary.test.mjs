/**
 * The metric-key vocabulary guard — the `metrics{}` counterpart to
 * `wireVocabulary.test.mjs`.
 *
 * That file exists because `eventKind` was once typed `string` and three
 * invented event names shipped. The keys inside `metrics{}` had the identical
 * hole for longer: `Record<string, ...>` accepted any spelling, and the Cursor
 * extractor emitted `contextUsagePercent` while every reader looked up
 * `contextWindowPeakPct`. Roughly 8,720 rows carried a context reading that
 * nothing could resolve, and no compiler, ingestion check or test said a word.
 *
 * `MetricKey` now makes an unregistered key a compile error, which is the
 * primary guard. These tests cover what types cannot:
 *
 *  - that `readBy` tells the truth about the handoff, checked against the
 *    handoff's own source rather than trusted;
 *  - that a `backend` key names the spellings the backend accepts, and that
 *    the canonical name is among them — the exact property whose absence was
 *    the bug;
 *  - that no key claims a reader it does not have.
 *
 * The cross-repo half cannot be checked from here: the reader is C# in
 * asc-core-be. `backendAliases` mirrors it and `MetadataKeyRegistryTests`
 * there pins the same list from the other side. Two mirrors, each self-checked
 * — drift stays possible, but it stops being invisible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { METRIC_KEYS, backendMetricKeys } from "@ascenda-one/tool-contract";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const READERS = new Set(["backend", "handoff", "diagnostic"]);

test("every registered key declares at least one real reader", () => {
  const offenders = [];
  for (const [key, spec] of Object.entries(METRIC_KEYS)) {
    if (!Array.isArray(spec.readBy) || spec.readBy.length === 0) {
      offenders.push(`${key}: no readBy`);
      continue;
    }
    for (const r of spec.readBy) {
      if (!READERS.has(r)) offenders.push(`${key}: unknown reader ${r}`);
    }
  }
  assert.deepEqual(offenders, [], `metric keys with no declared destination:\n  ${offenders.join("\n  ")}`);
});

/**
 * The property whose absence was the entire bug. A key declared `backend` must
 * name the spellings the backend accepts, and the canonical name must be one
 * of them — a key that claims a backend reader while spelling itself something
 * that reader has never heard of is precisely `contextUsagePercent` before the
 * fix.
 */
test("a backend-read key names its aliases, and its own name is among them", () => {
  const offenders = [];
  for (const [key, aliases] of backendMetricKeys()) {
    if (aliases.length === 0) {
      offenders.push(`${key}: declares backend but names no aliases`);
      continue;
    }
    if (!aliases.includes(key)) {
      offenders.push(`${key}: not in its own alias list [${aliases.join(", ")}] — the backend cannot resolve it`);
    }
  }
  assert.deepEqual(offenders, [], `backend keys the backend cannot read:\n  ${offenders.join("\n  ")}`);
});

/**
 * `readBy: "handoff"` is a claim about `localHandoff.ts`, so it is checked
 * against that file rather than believed. Both directions matter: a key
 * claiming the handoff reads it when it does not is a false promise, and a key
 * the handoff reads without declaring it is how a rename quietly breaks the
 * desktop app.
 */
test("readBy handoff matches what localHandoff.ts actually reads", () => {
  const handoffSrc = fs.readFileSync(path.join(SRC, "localHandoff.ts"), "utf8");
  const actuallyRead = new Set(
    [...handoffSrc.matchAll(/event\.metrics\.(\w+)/g)].map((m) => m[1])
  );

  const claimed = new Set(
    Object.entries(METRIC_KEYS)
      .filter(([, spec]) => spec.readBy.includes("handoff"))
      .map(([key]) => key)
  );

  const claimedButNotRead = [...claimed].filter((k) => !actuallyRead.has(k)).sort();
  const readButNotClaimed = [...actuallyRead].filter((k) => !claimed.has(k)).sort();

  assert.deepEqual(claimedButNotRead, [],
    `declared readBy:"handoff" but localHandoff.ts never reads them:\n  ${claimedButNotRead.join("\n  ")}`);
  assert.deepEqual(readButNotClaimed, [],
    `localHandoff.ts reads these but they are not declared readBy:"handoff":\n  ${readButNotClaimed.join("\n  ")}`);
});

/**
 * A unit must be stated wherever one key carries two of them. The context
 * mismatch was half a naming problem and half a unit problem: Cursor's percent
 * and Claude Code's fraction met under one name, and only the backend's
 * `> 1.0` magnitude heuristic told them apart.
 */
test("the context-window keys state their units", () => {
  for (const key of ["contextWindowPeakPct", "contextUsagePercent"]) {
    assert.ok(METRIC_KEYS[key], `${key} missing from the vocabulary`);
    assert.ok(
      typeof METRIC_KEYS[key].unit === "string" && METRIC_KEYS[key].unit.length > 0,
      `${key} carries a number whose scale is not obvious and must state its unit`
    );
  }
  assert.notEqual(
    METRIC_KEYS.contextWindowPeakPct.unit,
    METRIC_KEYS.contextUsagePercent.unit,
    "these two deliberately differ in scale — if their units have become equal, one of them is now wrong"
  );
});

/**
 * The regression, stated as a property rather than a value: whatever the
 * backend's context alias list contains, both spellings this repo emits must
 * be in it, or one of them is unreadable again.
 */
test("both context spellings this repo emits are in the backend alias list", () => {
  const aliases = new Map(backendMetricKeys());
  for (const key of ["contextWindowPeakPct", "contextUsagePercent"]) {
    assert.ok(
      aliases.get(key)?.includes(key),
      `${key} is emitted by an extractor but is not in the backend alias list — it would read as "not collected"`
    );
  }
});
