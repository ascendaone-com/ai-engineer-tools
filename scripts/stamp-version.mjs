// Stamps the release tag into every shipped package.json.
//
// One tag means one version across all artifacts: the manifest carries a single
// `version`, so an installer never has to reason about per-package skew.
// CI runs this before building; it is not meant to be committed back.
//
//   node scripts/stamp-version.mjs --tag v1.2.3 [--check]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseVersion, RELEASE_PACKAGES, REPO_ROOT } from "./release-artifacts.mjs";

/** Package.json paths a release stamps: the root plus every shipped tool. */
export function stampTargets(root = REPO_ROOT) {
  return ["package.json", ...RELEASE_PACKAGES.map((p) => path.join(p.dir, "package.json"))].map((rel) =>
    path.join(root, rel),
  );
}

/**
 * Rewrites `version` in each target. Returns the files whose version changed,
 * so `--check` can report drift without writing.
 */
export function stampVersion({ tag, root = REPO_ROOT, write = true }) {
  const version = normaliseVersion(tag);
  const changed = [];

  for (const file of stampTargets(root)) {
    const raw = fs.readFileSync(file, "utf8");
    const pkg = JSON.parse(raw);
    if (pkg.version === version) continue;

    changed.push(path.relative(root, file));
    if (!write) continue;

    // Rewrite the version in place rather than re-serialising the whole file,
    // so key order and formatting survive untouched.
    const next = raw.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`);
    if (JSON.parse(next).version !== version) {
      throw new Error(`could not stamp version in ${file}`);
    }
    fs.writeFileSync(file, next);
  }
  return changed;
}

function main(argv) {
  const tag = argv[argv.indexOf("--tag") + 1];
  const check = argv.includes("--check");
  if (!argv.includes("--tag") || !tag) {
    console.error("usage: stamp-version.mjs --tag <v1.2.3> [--check]");
    process.exit(2);
  }
  const changed = stampVersion({ tag, write: !check });
  if (check && changed.length) {
    console.error(`versions differ from ${tag}:\n  ${changed.join("\n  ")}`);
    process.exit(1);
  }
  console.error(check ? `all versions match ${tag}` : `stamped ${normaliseVersion(tag)} into ${changed.length} file(s)`);
}

// fileURLToPath, not a `file://${argv[1]}` template: import.meta.url
// percent-encodes, so a checkout path containing a space makes this comparison
// silently false and the script exits 0 having done nothing — a stamp or a
// manifest that never ran, reported as success.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
