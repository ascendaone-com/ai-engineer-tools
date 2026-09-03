import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bannedTerms,
  check,
  exceptions,
  scanText,
  scannedFiles,
} from "../scripts/check-language.mjs";

// The guard's own tests. The point of the guard is that a banned phrase in
// shipped copy fails the build rather than surviving until a reviewer reads
// the file — so the guard failing silently would be the same defect one level
// up.

test("every file this package ships to an agent is in scope", () => {
  const files = scannedFiles();
  assert.ok(files.includes("skills/ascenda-work-signals/SKILL.md"));
  assert.ok(files.includes("skills/ascenda-work-checkpoints/SKILL.md"));
  assert.ok(files.includes("cursor/ascenda-work-signals.mdc"));
  assert.ok(files.includes("docs/EMISSION_CRITERIA.md"));
  assert.ok(files.includes("README.md"));
});

test("the shipped copy is clean, with no stale exceptions", () => {
  const { violations, unused } = check();
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} ${v.phrase}`),
    []
  );
  assert.deepEqual(
    unused.map((u) => `${u.file} ${u.phrase}`),
    []
  );
});

test("a banned phrase is caught wherever it sits in a line, and case-insensitively", () => {
  const hits = scanText("A line that says You Are Frustrated in the middle.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].phrase, "you are frustrated");
  assert.equal(hits[0].line, 1);
});

test("the line number points at the offending line, not the file", () => {
  const hits = scanText(["fine", "also fine", "burnout risk is high"].join("\n"));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});

test("ordinary work vocabulary is not a hit", () => {
  // The permitted namespace from the schema-discipline rule: demand, load of
  // the work, cadence, switches, verification, gaps, after-hours. A guard
  // that tripped on these would push the copy into euphemism.
  const hits = scanText(
    [
      "supervising minutes and hands-on minutes, never added together",
      "retry storms, compactions, and the demand of the work",
      "verification runs, switches, gaps, after-hours share",
    ].join("\n")
  );
  assert.deepEqual(hits, []);
});

test("the product's own name is never a banned term", () => {
  assert.ok(!bannedTerms().includes("flow"));
  assert.deepEqual(scanText("the Flow app's local MCP server"), []);
});

test("each exception names a file, a phrase and a reason", () => {
  const allowed = exceptions();
  assert.ok(allowed.length > 0, "expected at least the quoted-rule exceptions");
  for (const entry of allowed) {
    assert.ok(scannedFiles().includes(entry.file), `${entry.file} is not a scanned file`);
    assert.ok(bannedTerms().includes(entry.phrase), `${entry.phrase} is not a banned term`);
    assert.ok(entry.reason.length > 20, "an exception has to say why, not just exist");
  }
});
