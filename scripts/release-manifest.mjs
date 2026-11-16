// Builds the release manifest the installer consumes.
//
// The installer resolves artifacts only through this file — never "whatever is
// on main" — so every entry carries a pinned URL and a sha256 the installer
// must check before executing anything.
//
//   node scripts/release-manifest.mjs --tag v1.2.3 --dir dist/release \
//     --repo ascendaone-com/ai-engineer-tools --out dist/release/manifest.json

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compatibility, minNode, normaliseVersion, REPO_ROOT } from "./release-artifacts.mjs";
import { releaseNotes } from "./release-notes.mjs";

export const MANIFEST_NAME = "manifest.json";

export function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The longest summary a consumer will accept; releaseCheck.ts holds the same number. */
export const SUMMARY_MAX = 200;

/**
 * One or two sentences saying what a release does, from the top of its
 * changelog section: the first paragraph, or the first bullet when the section
 * opens with a list. Links and emphasis are stripped, and the text is cut at
 * the last sentence end that fits in {@link SUMMARY_MAX} characters.
 */
export function summarise(notes) {
  const blocks = notes
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b && !/^#/.test(b));
  let first = blocks[0] ?? "";
  if (/^[-*]\s/.test(first)) first = first.split(/\n(?=[-*]\s)/)[0].replace(/^[-*]\s+/, "");
  const text = first
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= SUMMARY_MAX) return text;
  const head = text.slice(0, SUMMARY_MAX);
  const ends = [...head.matchAll(/[.!?](?=\s|$)/g)];
  if (ends.length) return head.slice(0, ends[ends.length - 1].index + 1);
  const words = text.slice(0, SUMMARY_MAX - 1).replace(/\s+\S*$/, "");
  return `${words}…`;
}

/**
 * @param {object} o
 * @param {string} o.tag   release tag, `v1.2.3` or `1.2.3`
 * @param {string} o.dir   directory of built artifacts to describe
 * @param {string} o.repo  `owner/name`, used to build download URLs
 */
export function buildManifest({ tag, dir, repo, root = REPO_ROOT }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
    throw new Error(`repo must be owner/name, got: ${repo}`);
  }
  const version = normaliseVersion(tag);

  // Describe every file in the staging dir except the manifest itself, so a
  // new artifact can never be silently left out of the manifest.
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== MANIFEST_NAME)
    .map((e) => e.name)
    .sort();

  if (files.length === 0) throw new Error(`no artifacts found in ${dir}`);

  // A tag with no changelog section already fails the release workflow; an
  // empty summary fails it here, so the update note never ships blank.
  const summary = summarise(releaseNotes({ tag, changelog: path.join(root, "CHANGELOG.md") }));
  if (!summary) throw new Error(`the changelog section for v${version} has no text to summarise`);

  return {
    version,
    summary,
    minNode: minNode(root),
    // Declared floors travel with the release so a consumer that can never see
    // this repo — doctor on a user's laptop, the Sparkle appcast, the app —
    // reads them from the same signed document it already trusts for artifacts.
    compatibility: compatibility(root),
    artifacts: files.map((name) => ({
      name,
      url: `https://github.com/${repo}/releases/download/v${version}/${name}`,
      sha256: sha256(path.join(dir, name)),
    })),
  };
}

function main(argv) {
  const args = Object.fromEntries(
    argv.reduce((pairs, token, i) => {
      if (token.startsWith("--")) pairs.push([token.slice(2), argv[i + 1]]);
      return pairs;
    }, []),
  );
  const { tag, dir, repo } = args;
  if (!tag || !dir || !repo) {
    console.error("usage: release-manifest.mjs --tag <v1.2.3> --dir <dir> --repo <owner/name> [--out <file>]");
    process.exit(2);
  }
  const manifest = buildManifest({ tag, dir, repo });
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const out = args.out ?? path.join(dir, MANIFEST_NAME);
  fs.writeFileSync(out, json);
  console.error(`wrote ${out} (${manifest.artifacts.length} artifacts, minNode ${manifest.minNode})`);
}

// fileURLToPath, not a `file://${argv[1]}` template: import.meta.url
// percent-encodes, so a checkout path containing a space makes this comparison
// silently false and the script exits 0 having done nothing — a stamp or a
// manifest that never ran, reported as success.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
