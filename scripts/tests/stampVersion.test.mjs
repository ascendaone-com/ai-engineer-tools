import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stampTargets, stampVersion } from "../stamp-version.mjs";
import { RELEASE_PACKAGES } from "../release-artifacts.mjs";

/** A fake repo root with a root package.json plus every release package. */
function fixture(versions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-stamp-"));
  const write = (dir, pkg) => {
    if (dir) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  };
  write("", { name: "ai-engineer-tools", version: versions.root ?? "0.0.1", engines: { node: ">=20" } });
  for (const p of RELEASE_PACKAGES) {
    // `p.name` names the release artifact; the package.json carries the npm
    // name where there is one, so the fixture mirrors the real tree.
    write(p.dir, { name: p.npm ?? p.name, version: versions[p.name] ?? "0.0.1", scripts: { build: "tsc" } });
  }
  return root;
}

const read = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel, "package.json"), "utf8"));

test("stamps one version across the root and every shipped package", () => {
  const root = fixture({ "ascenda": "0.0.2", "ascenda-claude-code-hooks": "0.1.0" });
  const changed = stampVersion({ tag: "v1.4.0", root });

  assert.equal(read(root, "").version, "1.4.0");
  for (const p of RELEASE_PACKAGES) assert.equal(read(root, p.dir).version, "1.4.0", p.name);
  assert.equal(changed.length, stampTargets(root).length, "pre-existing skew is all reported as changed");
});

test("preserves surrounding fields and formatting", () => {
  const root = fixture();
  stampVersion({ tag: "v2.0.0", root });

  const pkg = read(root, "ascenda-codex-hooks");
  assert.equal(pkg.name, "@ascenda-one/codex-hooks");
  assert.deepEqual(pkg.scripts, { build: "tsc" }, "unrelated fields survive the rewrite");
  assert.match(fs.readFileSync(path.join(root, "package.json"), "utf8"), /\n$/, "trailing newline kept");
});

test("--check reports drift without writing", () => {
  const root = fixture();
  const changed = stampVersion({ tag: "v3.0.0", root, write: false });

  assert.ok(changed.includes("package.json"));
  assert.equal(read(root, "").version, "0.0.1", "check mode leaves files untouched");
});

test("already-stamped packages are not reported as changed", () => {
  const root = fixture();
  stampVersion({ tag: "v1.0.0", root });
  assert.deepEqual(stampVersion({ tag: "v1.0.0", root }), [], "stamping is idempotent");
});

test("refuses a tag that is not a release version", () => {
  const root = fixture();
  assert.throws(() => stampVersion({ tag: "latest", root }), /semver/);
  assert.equal(read(root, "").version, "0.0.1", "nothing is written on a bad tag");
});
