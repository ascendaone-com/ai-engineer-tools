/**
 * Guard rail: the release path must know about every package meant to ship.
 *
 * `RELEASE_PACKAGES` drives version stamping, npm publishing, artifact staging
 * and the manifest. A workspace absent from it still builds and still passes
 * every other test — it simply never ships. That is not hypothetical:
 * `@ascenda-one/history-import` was added as a workspace, wired into
 * `build:tools`, released green through a tag, and returned 404 from the
 * registry for every user, because nothing connected "is a package" to "is
 * released".
 *
 * The signal for "meant to ship" is `publishConfig` on a non-private
 * workspace. Anything carrying it must be in RELEASE_PACKAGES or in
 * NON_NPM_WORKSPACES below, with a reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PACKAGES } from "../release-artifacts.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Workspaces that deliberately do not go to npm via the tag path — listed
 * whether they still carry `publishConfig` or are marked private, so the
 * reason survives either form. Each entry states the channel that ships it
 * instead — if you
 * add one, say where it ships, or the next reader cannot tell an intentional
 * exclusion from a repeat of the history-import bug.
 */
const NON_NPM_WORKSPACES = new Map([
  [
    "ascenda-agent-skills",
    "Ships as a Claude Code plugin from .claude-plugin/marketplace.json at a pinned commit (see RELEASING.md, 'Plugin distribution: a pinned commit'), not as an npm tarball."
  ]
]);

function workspaceDirs() {
  const root = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  return root.workspaces.flatMap((w) =>
    w.endsWith("/*")
      ? fs
          .readdirSync(path.join(REPO_ROOT, w.slice(0, -2)))
          .map((d) => `${w.slice(0, -2)}/${d}`)
      : [w]
  );
}

test("every publishable workspace is in RELEASE_PACKAGES or explicitly excluded", () => {
  const known = new Set(RELEASE_PACKAGES.map((p) => p.dir));
  const missing = [];
  for (const dir of workspaceDirs()) {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, dir, "package.json"), "utf8"));
    if (pkg.private || !pkg.publishConfig) continue;
    if (known.has(dir) || NON_NPM_WORKSPACES.has(dir)) continue;
    missing.push(`${dir} (${pkg.name})`);
  }
  assert.deepEqual(
    missing,
    [],
    `these workspaces declare publishConfig but nothing ships them — add to RELEASE_PACKAGES ` +
      `in scripts/release-artifacts.mjs, or to NON_NPM_WORKSPACES with the channel that does:\n  ` +
      missing.join("\n  ")
  );
});

test("every RELEASE_PACKAGES entry points at a real workspace with the name it claims", () => {
  for (const entry of RELEASE_PACKAGES) {
    const pkgPath = path.join(REPO_ROOT, entry.dir, "package.json");
    assert.ok(fs.existsSync(pkgPath), `RELEASE_PACKAGES lists ${entry.dir}, which has no package.json`);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (entry.npm) {
      assert.equal(pkg.name, entry.npm, `${entry.dir}: RELEASE_PACKAGES says ${entry.npm}, package.json says ${pkg.name}`);
      assert.ok(pkg.publishConfig?.access === "public", `${entry.dir}: scoped npm package needs publishConfig.access=public or the publish 402s`);
    }
  }
});

test("every cli entry bundles to the dist/cli.js the staging step copies", () => {
  for (const entry of RELEASE_PACKAGES.filter((p) => p.kind === "cli")) {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, entry.dir, "package.json"), "utf8"));
    const bins = Object.values(pkg.bin ?? {});
    assert.ok(
      bins.includes("./dist/cli.js"),
      `${entry.dir}: staged as ${entry.name}.mjs from dist/cli.js, but package.json bin is ${JSON.stringify(pkg.bin)}`
    );
  }
});

test("every NON_NPM_WORKSPACES entry is still a real workspace", () => {
  const workspaces = new Set(workspaceDirs());
  for (const [dir, reason] of NON_NPM_WORKSPACES) {
    assert.ok(
      workspaces.has(dir),
      `NON_NPM_WORKSPACES excuses ${dir}, which is no longer a workspace — drop the entry, ` +
        `or the next reader trusts a reason for a package that is not there:\n  ${reason}`
    );
  }
});

/**
 * The plugin channel is the other way something ships here. Users receive the
 * plugin at the commit `marketplace.json` pins, and the version they see is
 * whatever `plugin.json` says at that commit. If the two disagree, the listing
 * advertises one version and installs another, and nothing else in the repo
 * notices.
 *
 * An entry is either a path in this repository or a `git-subdir` source of this
 * repository, which carries the path and the pinned commit.
 */
function pluginPath(entry) {
  if (typeof entry.source === "string") return entry.source.startsWith(".") ? entry.source : undefined;
  if (entry.source?.source === "git-subdir" && /ai-engineer-tools(\.git)?$/.test(entry.source.url ?? "")) {
    return entry.source.path;
  }
  return undefined;
}

test("marketplace.json and each plugin.json agree on name and version", () => {
  const marketplacePath = path.join(REPO_ROOT, ".claude-plugin", "marketplace.json");
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));

  for (const entry of marketplace.plugins ?? []) {
    const dir = pluginPath(entry);
    if (!dir) continue; // not ours to check

    const manifestPath = path.join(REPO_ROOT, dir, ".claude-plugin", "plugin.json");
    assert.ok(
      fs.existsSync(manifestPath),
      `marketplace.json lists ${entry.name} at ${dir}, which has no .claude-plugin/plugin.json`
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    assert.equal(
      manifest.name,
      entry.name,
      `${dir}: marketplace.json calls it ${entry.name}, plugin.json calls it ${manifest.name}`
    );
    // Without an explicit version the plugin host falls back to the commit SHA,
    // which makes every commit a new version and every update indistinguishable.
    assert.ok(manifest.version, `${dir}: plugin.json has no version, so every commit ships as a new one`);
    if (entry.version !== undefined) {
      assert.equal(
        entry.version,
        manifest.version,
        `${dir}: marketplace.json advertises ${entry.version}, plugin.json installs ${manifest.version}`
      );
    }
  }
});

/**
 * The plugin is pinned to a commit so that merging to `main` doesn't release it.
 * A pin that isn't a full commit id, or that names a commit this branch doesn't
 * have, installs nothing for every user. `scripts/check-dry.sh` checks the
 * second half, because it needs git history.
 */
test("every plugin from this repository is pinned to a full commit", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  for (const entry of marketplace.plugins ?? []) {
    if (!pluginPath(entry)) continue;
    assert.equal(typeof entry.source, "object", `${entry.name}: a path source follows main, so every merge is a plugin release`);
    assert.match(entry.source.sha ?? "", /^[0-9a-f]{40}$/, `${entry.name}: source.sha must be 40 hex characters`);
  }
});
