// Extracts the hand-written release notes for a tag from CHANGELOG.md.
//
// `gh release create --generate-notes` produces the merged-PR list on its own,
// and that list is all a release carried until v0.1.16. It names pull requests;
// it does not say what changed for someone running `npx`. The CHANGELOG
// section for the tag is that missing half, and the workflow reads it here
// BEFORE anything is built or published, so a tag with no notes fails at zero
// cost rather than shipping unreadable.
//
//   node scripts/release-notes.mjs --tag v1.2.3 [--out dist/release-notes.md]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseVersion, REPO_ROOT } from "./release-artifacts.mjs";

export const CHANGELOG = path.join(REPO_ROOT, "CHANGELOG.md");

const HEADING = /^## +(.*)$/;

/** `## v1.2.3`, `## 1.2.3` and `## v1.2.3 — 2026-09-04` all name 1.2.3. */
function headingVersion(line) {
  const m = HEADING.exec(line);
  if (!m) return null;
  return m[1].trim().split(/\s+/)[0].replace(/^v/, "");
}

/**
 * The body of the changelog section whose heading names `tag`, with the
 * heading itself and surrounding blank lines removed. Throws when the section
 * is absent or empty: both mean the notes were not written.
 */
export function releaseNotes({ tag, changelog = CHANGELOG }) {
  const version = normaliseVersion(tag);
  const name = path.basename(changelog);
  const lines = fs.readFileSync(changelog, "utf8").split("\n");

  const start = lines.findIndex((line) => headingVersion(line) === version);
  if (start < 0) {
    throw new Error(`${name} has no "## v${version}" section — write the release notes before tagging`);
  }
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => HEADING.test(line));
  const body = rest.slice(0, next < 0 ? rest.length : next).join("\n").trim();
  if (!body) throw new Error(`the "## v${version}" section in ${name} is empty`);
  return body;
}

function main(argv) {
  const tag = argv[argv.indexOf("--tag") + 1];
  const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;
  if (!argv.includes("--tag") || !tag) {
    console.error("usage: release-notes.mjs --tag <v1.2.3> [--out <file>]");
    process.exit(2);
  }
  const body = `${releaseNotes({ tag })}\n`;
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
    console.error(`wrote release notes for ${tag} to ${out}`);
  } else {
    process.stdout.write(body);
  }
}

// See stamp-version.mjs for why this is fileURLToPath and not a template.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
