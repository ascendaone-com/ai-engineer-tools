// Runs esbuild for a shipped collector, with the release version defined in.
//
// Every argument is passed to esbuild untouched; this adds one
// `--define:__ASCENDA_COLLECTOR_VERSION__=...`, which
// packages/tool-kit/src/collectorVersion.ts reads and every event carries as
// `metadata.collectorVersion`.
//
// The version comes from ASCENDA_COLLECTOR_VERSION, which release.yml sets from
// the tag. Unset, the bundle says "unreleased": a build from a checkout isn't
// any release, and the `package.json` it was built from still holds the
// placeholder version.
//
// Set, it must match the `package.json` in the working directory, which
// scripts/stamp-version.mjs rewrote from the same tag. A mismatch fails the
// build: an event reporting one version from a package published as another
// is worse than one reporting none.
//
//   node ../scripts/esbuild-collector.mjs src/cli.ts --bundle ... --outfile=dist/cli.js

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseVersion } from "./release-artifacts.mjs";

export const VERSION_ENV_VAR = "ASCENDA_COLLECTOR_VERSION";
export const UNRELEASED = "unreleased";

/** The version to define into a bundle built in `pkgDir`. */
export function collectorVersion({ env = process.env, pkgDir = process.cwd() } = {}) {
  const tag = env[VERSION_ENV_VAR]?.trim();
  if (!tag) return UNRELEASED;

  const version = normaliseVersion(tag);
  const manifest = path.join(pkgDir, "package.json");
  const stamped = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
  if (stamped !== version) {
    throw new Error(
      `${VERSION_ENV_VAR}=${tag} but ${manifest} says ${stamped}. Run scripts/stamp-version.mjs --tag ${tag} first.`,
    );
  }
  return version;
}

export function defineArg(version) {
  return `--define:__ASCENDA_COLLECTOR_VERSION__=${JSON.stringify(version)}`;
}

function main(args) {
  const require = createRequire(import.meta.url);
  const esbuild = path.join(path.dirname(require.resolve("esbuild/package.json")), "bin", "esbuild");
  const result = spawnSync(esbuild, [...args, defineArg(collectorVersion())], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
