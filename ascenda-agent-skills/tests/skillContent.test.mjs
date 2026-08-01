import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEMANTIC_WORK_SIGNAL_EVENT_TYPES } from "@ascenda-one/tool-contract";

// This package's whole value is that its content stays in sync with the
// contract it teaches against — a stale event name or an unreachable
// vocabulary file is a worse failure than a missing feature, since nothing
// else would catch it. These tests exist to make that drift mechanical
// rather than something a reviewer has to remember to check.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

/** Minimal frontmatter extraction — good enough for the flat key: value
 * blocks both SKILL.md and the Cursor .mdc use; not a general YAML parser. */
function frontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, "expected a --- delimited frontmatter block at the top of the file");
  const fields = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return fields;
}

test("SKILL.md has valid frontmatter with name and a non-trivial description", () => {
  const fm = frontmatter(read("claude-code/SKILL.md"));
  assert.equal(fm.name, "ascenda-work-signals");
  assert.ok(fm.description && fm.description.length > 40, "description should be specific enough to trigger correctly");
});

test("the Cursor rule has valid frontmatter with a description", () => {
  const fm = frontmatter(read("cursor/ascenda-work-signals.mdc"));
  assert.ok(fm.description && fm.description.length > 20);
});

test("every semantic event type is documented in EMISSION_CRITERIA.md, and nothing extra is", () => {
  const criteria = read("docs/EMISSION_CRITERIA.md");
  for (const eventType of SEMANTIC_WORK_SIGNAL_EVENT_TYPES) {
    assert.match(
      criteria,
      new RegExp(`\`${eventType}\``),
      `EMISSION_CRITERIA.md is missing \`${eventType}\` — it must document every type in SEMANTIC_WORK_SIGNAL_EVENT_TYPES`
    );
  }
  // Catches the other direction: a criterion for a type that no longer
  // exists in the contract (renamed or removed upstream).
  const headingEventTypes = [...criteria.matchAll(/^## `([a-z_]+)`$/gm)].map((m) => m[1]);
  for (const documented of headingEventTypes) {
    assert.ok(
      SEMANTIC_WORK_SIGNAL_EVENT_TYPES.includes(documented),
      `EMISSION_CRITERIA.md documents \`${documented}\` as a top-level event, but it is not in SEMANTIC_WORK_SIGNAL_EVENT_TYPES`
    );
  }
  assert.equal(headingEventTypes.length, SEMANTIC_WORK_SIGNAL_EVENT_TYPES.length);
});

test("every semantic event type appears in both SKILL.md and the Cursor rule", () => {
  const skill = read("claude-code/SKILL.md");
  const cursorRule = read("cursor/ascenda-work-signals.mdc");
  for (const eventType of SEMANTIC_WORK_SIGNAL_EVENT_TYPES) {
    assert.ok(skill.includes(eventType), `SKILL.md is missing ${eventType}`);
    assert.ok(cursorRule.includes(eventType), `the Cursor rule is missing ${eventType}`);
  }
});

test("EMISSION_CRITERIA.md declares a semver current version", () => {
  const criteria = read("docs/EMISSION_CRITERIA.md");
  assert.match(criteria, /Current version:\s*`\d+\.\d+\.\d+`/);
});

test("banned-vocabulary.txt has real entries and no accidental duplicates", () => {
  const lines = read("copy/banned-vocabulary.txt")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  assert.ok(lines.length >= 20, "expected a substantial list, not a stub");
  assert.equal(new Set(lines.map((l) => l.toLowerCase())).size, lines.length, "duplicate entries found");
});

test("banned-vocabulary.txt does not itself contain the bare word 'flow' as an entry", () => {
  // The one false-positive this list must never produce: banning the
  // product's own name. Entries must be specific phrases, not the bare word.
  const lines = read("copy/banned-vocabulary.txt")
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  assert.ok(!lines.includes("flow"), "the bare word 'flow' must never be a banned-vocabulary entry");
});

test("SKILL.md and the Cursor rule both point at EMISSION_CRITERIA.md and the vocabulary file", () => {
  for (const file of ["claude-code/SKILL.md", "cursor/ascenda-work-signals.mdc"]) {
    const content = read(file);
    assert.ok(content.includes("EMISSION_CRITERIA.md"), `${file} should reference EMISSION_CRITERIA.md`);
    assert.ok(content.includes("banned-vocabulary.txt"), `${file} should reference banned-vocabulary.txt`);
  }
});
