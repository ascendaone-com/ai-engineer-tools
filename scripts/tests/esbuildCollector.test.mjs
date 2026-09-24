import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UNRELEASED, VERSION_ENV_VAR, collectorVersion } from "../esbuild-collector.mjs";
import { RELEASE_PACKAGES, REPO_ROOT } from "../release-artifacts.mjs";

const WRAPPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "esbuild-collector.mjs");
const TOOL_KIT_VERSION = path.join(REPO_ROOT, "packages", "tool-kit", "out", "collectorVersion.js");

/** A package directory whose package.json says `version`, as the stamp leaves it. */
function pkgDir(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-bundle-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version }));
  return dir;
}

test("no tag in the environment means unreleased, whatever package.json says", () => {
  const dir = pkgDir("0.1.0");
  assert.equal(collectorVersion({ env: {}, pkgDir: dir }), UNRELEASED);
  assert.equal(collectorVersion({ env: { [VERSION_ENV_VAR]: "  " }, pkgDir: dir }), UNRELEASED);
});

test("a tag becomes the bare version when the package was stamped with it", () => {
  const dir = pkgDir("0.1.28");
  assert.equal(collectorVersion({ env: { [VERSION_ENV_VAR]: "v0.1.28" }, pkgDir: dir }), "0.1.28");
  assert.equal(collectorVersion({ env: { [VERSION_ENV_VAR]: "0.1.28" }, pkgDir: dir }), "0.1.28");
});

test("a tag the package was not stamped with fails the build", () => {
  const dir = pkgDir("0.1.0");
  assert.throws(() => collectorVersion({ env: { [VERSION_ENV_VAR]: "v0.1.28" }, pkgDir: dir }), /stamp-version/);
});

/**
 * End to end through esbuild, against the real tool-kit module: the define
 * has to reach through the `typeof` guard in collectorVersion.ts, which a
 * unit test of the wrapper alone can't show.
 */
function bundleAndRun(env, dir) {
  const entry = path.join(dir, "entry.mjs");
  const out = path.join(dir, "out.cjs");
  fs.writeFileSync(entry, `import { COLLECTOR_VERSION } from ${JSON.stringify(TOOL_KIT_VERSION)};\nconsole.log(COLLECTOR_VERSION);\n`);
  const cleanEnv = { ...process.env };
  delete cleanEnv[VERSION_ENV_VAR];
  const build = spawnSync(process.execPath, [WRAPPER, entry, "--bundle", "--platform=node", "--format=cjs", `--outfile=${out}`, "--log-level=error"], {
    cwd: dir,
    env: { ...cleanEnv, ...env },
    encoding: "utf8"
  });
  assert.equal(build.status, 0, build.stderr);
  return spawnSync(process.execPath, [out], { encoding: "utf8" }).stdout.trim();
}

test("an unstamped bundle says unreleased", () => {
  assert.equal(bundleAndRun({}, pkgDir("0.1.0")), "unreleased");
});

test("a stamped bundle carries the release version", () => {
  assert.equal(bundleAndRun({ [VERSION_ENV_VAR]: "v2.3.4" }, pkgDir("2.3.4")), "2.3.4");
});

test("every shipped package bundles through the wrapper", () => {
  const offenders = RELEASE_PACKAGES.filter(({ dir }) => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, dir, "package.json"), "utf8"));
    return !scripts?.bundle?.startsWith("node ../scripts/esbuild-collector.mjs ");
  }).map((p) => p.dir);
  assert.deepEqual(offenders, [], "these would ship reporting collectorVersion unreleased");
});
