import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CHANGELOG, releaseNotes } from "../release-notes.mjs";

function changelog(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-notes-"));
  const file = path.join(dir, "CHANGELOG.md");
  fs.writeFileSync(file, text);
  return file;
}

const SAMPLE = `# Changelog

Intro text nobody should ship.

## v0.2.0 — 2026-10-01

### Added
- The newer thing.

## v0.1.16

- Durable outbox.
- Idempotency key.

### Contract
- A field.

## 0.1.15

Bare heading, no v.
`;

test("extracts exactly the section named by the tag, with sub-headings kept", () => {
  const file = changelog(SAMPLE);
  assert.equal(
    releaseNotes({ tag: "v0.1.16", changelog: file }),
    "- Durable outbox.\n- Idempotency key.\n\n### Contract\n- A field."
  );
});

test("a date suffix or a missing v on the heading still names the version", () => {
  const file = changelog(SAMPLE);
  assert.equal(releaseNotes({ tag: "v0.2.0", changelog: file }), "### Added\n- The newer thing.");
  assert.equal(releaseNotes({ tag: "0.1.15", changelog: file }), "Bare heading, no v.");
});

test("a tag with no section fails, naming the heading to write", () => {
  const file = changelog(SAMPLE);
  assert.throws(() => releaseNotes({ tag: "v9.9.9", changelog: file }), /no "## v9\.9\.9" section/);
});

test("an empty section is not release notes", () => {
  const file = changelog("## v1.0.0\n\n\n## v0.9.0\n- old\n");
  assert.throws(() => releaseNotes({ tag: "v1.0.0", changelog: file }), /is empty/);
});

test("a malformed tag is rejected before the changelog is read", () => {
  assert.throws(() => releaseNotes({ tag: "latest", changelog: "/nonexistent" }), /not a semver release tag/);
});

// The repo's own CHANGELOG.md: its newest section must extract, so a heading
// typo cannot pass verify and then fail the release at the notes step.
test("the repo CHANGELOG's newest section is well-formed", () => {
  const first = fs
    .readFileSync(CHANGELOG, "utf8")
    .split("\n")
    .find((line) => /^## /.test(line));
  assert.ok(first, "CHANGELOG.md has no '## vX.Y.Z' section");
  const version = first.replace(/^## +/, "").split(/\s+/)[0];
  assert.match(version, /^v\d+\.\d+\.\d+$/, `newest heading "${first}" does not start with vX.Y.Z`);
  assert.ok(releaseNotes({ tag: version }).length > 0);
});
