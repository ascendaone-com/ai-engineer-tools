import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { buildManifest, sha256 } from "../release-manifest.mjs";
import { minNode, normaliseVersion } from "../release-artifacts.mjs";

const REPO = "ascendaone-com/ai-engineer-tools";

/** A staging dir holding `files` plus a fake repo root declaring engines.node. */
function fixture(files, engines = ">=20") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-manifest-"));
  const dir = path.join(base, "release");
  fs.mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  fs.writeFileSync(path.join(base, "package.json"), JSON.stringify({ engines: { node: engines } }));
  return { base, dir };
}

test("describes every artifact with a pinned url and checksum", () => {
  const { base, dir } = fixture({ "ascenda-vscode.vsix": "vsix-bytes", "cli.js": "cli-bytes" });
  const manifest = buildManifest({ tag: "v1.2.3", dir, repo: REPO, root: base });

  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.minNode, 20);
  assert.deepEqual(
    manifest.artifacts.map((a) => a.name),
    ["ascenda-vscode.vsix", "cli.js"],
    "artifacts are sorted for a stable manifest",
  );

  const vsix = manifest.artifacts[0];
  assert.equal(vsix.url, `https://github.com/${REPO}/releases/download/v1.2.3/ascenda-vscode.vsix`);
  assert.equal(vsix.sha256, createHash("sha256").update("vsix-bytes").digest("hex"));
});

test("checksums match the bytes actually written", () => {
  const { base, dir } = fixture({ "a.js": "hello" });
  const { artifacts } = buildManifest({ tag: "1.2.3", dir, repo: REPO, root: base });
  assert.equal(artifacts[0].sha256, sha256(path.join(dir, "a.js")));
});

test("the manifest never describes itself", () => {
  const { base, dir } = fixture({ "a.js": "x", "manifest.json": "{}" });
  const { artifacts } = buildManifest({ tag: "v0.1.0", dir, repo: REPO, root: base });
  assert.deepEqual(
    artifacts.map((a) => a.name),
    ["a.js"],
  );
});

test("minNode tracks the root engines range, not a hardcoded number", () => {
  const { base, dir } = fixture({ "a.js": "x" }, ">=22.1.0");
  assert.equal(buildManifest({ tag: "v1.0.0", dir, repo: REPO, root: base }).minNode, 22);
  assert.equal(minNode(base), 22);
});

test("rejects input that would produce an unusable manifest", () => {
  const { base, dir } = fixture({ "a.js": "x" });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-empty-"));

  assert.throws(() => buildManifest({ tag: "main", dir, repo: REPO, root: base }), /semver/);
  assert.throws(() => buildManifest({ tag: "v1.0.0", dir, repo: "nope", root: base }), /owner\/name/);
  assert.throws(() => buildManifest({ tag: "v1.0.0", dir: empty, repo: REPO, root: base }), /no artifacts/);
});

test("normalises tags with and without the v prefix", () => {
  assert.equal(normaliseVersion("v1.2.3"), "1.2.3");
  assert.equal(normaliseVersion("1.2.3"), "1.2.3");
  assert.equal(normaliseVersion("v1.2.3-rc.1"), "1.2.3-rc.1");
  assert.throws(() => normaliseVersion("v1.2"), /semver/);
});
