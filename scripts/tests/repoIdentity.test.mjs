/**
 * Guard rail: every place this repo names itself must name the repo the
 * release workflow actually runs in.
 *
 * `npm publish --provenance` is the strict one. It compares `repository.url`
 * against the repository the workflow runs in and *errors* rather than
 * warning, so a stale owner does not degrade a release — it stops it, on the
 * first tag after a transfer, after the VSIX has already gone to two
 * marketplaces. Nothing else in the repo notices, because a `repository.url`
 * pointing at a repo that still resolves via GitHub's redirect looks correct
 * to a reader and to every other tool.
 *
 * The registries themselves are not at risk here: the npm scope
 * (`@ascenda-one`), the Marketplace publisher and the Open VSX namespace are
 * identities in those systems, unrelated to who owns the repo on GitHub.
 * Publishing is `NPM_TOKEN`/`VSCE_PAT`/`OVSX_PAT`, not trusted publishing, so
 * a transfer needs no change on any registry — only in here.
 *
 * Expected owner/repo comes from `GITHUB_REPOSITORY` in CI, which is the exact
 * value provenance compares against, and from the `origin` remote locally.
 * Neither is hardcoded, so the day the repo moves this fails with the list of
 * files to fix instead of needing to have been updated in advance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { RELEASE_PACKAGES, REPO_ROOT } from "../release-artifacts.mjs";

/**
 * `owner/repo` for the repository a release of this tree would publish from.
 *
 * Resolved lazily so an unresolvable origin fails as a test, not as an
 * uncaught exception at import time. The origin here is commonly an SSH host
 * alias (`git@github-ascendaone-com:owner/repo.git`), so the host is not
 * required to read literally `github.com` — the owner/repo pair is what
 * provenance compares, and CI answers with GITHUB_REPOSITORY anyway.
 */
let cachedSlug;
function releaseSlug() {
  if (cachedSlug) return cachedSlug;

  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv) return (cachedSlug = fromEnv);

  let remote;
  try {
    remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    }).trim();
  } catch {
    assert.fail(
      "cannot tell which repository this tree belongs to: GITHUB_REPOSITORY is unset and " +
        "`git remote get-url origin` failed. Set GITHUB_REPOSITORY=owner/repo to run this test."
    );
  }

  const match = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
  assert.ok(match, `origin is ${remote}, which is not an owner/repo URL this test can read`);
  return (cachedSlug = `${match[1]}/${match[2]}`);
}

const sameSlug = (a, b) => a.toLowerCase() === b.toLowerCase();

test("every npm-published package declares the repository provenance will check", () => {
  const SLUG = releaseSlug();
  const wrong = [];
  for (const entry of RELEASE_PACKAGES.filter((p) => p.npm)) {
    const pkgPath = path.join(REPO_ROOT, entry.dir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const url = pkg.repository?.url;

    if (!url) {
      wrong.push(`${entry.dir}: no repository.url — --provenance cannot resolve a source repo`);
      continue;
    }
    const match = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
    if (!match) {
      wrong.push(`${entry.dir}: repository.url is ${url}, which is not a github.com URL`);
      continue;
    }
    if (!sameSlug(match[1], SLUG)) {
      wrong.push(`${entry.dir}: repository.url points at ${match[1]}, release publishes from ${SLUG}`);
    }
    // Without `directory`, a monorepo package's provenance points at the repo
    // root, so the attestation cannot say which workspace produced the tarball.
    if (pkg.repository?.directory !== entry.dir) {
      wrong.push(
        `${entry.dir}: repository.directory is ${JSON.stringify(pkg.repository?.directory)}, expected "${entry.dir}"`
      );
    }
  }

  assert.deepEqual(
    wrong,
    [],
    `npm publish --provenance fails the release outright on these — it does not warn:\n  ` + wrong.join("\n  ")
  );
});

/**
 * The rest are not hard failures at publish time, they are worse: they keep
 * working on GitHub's post-transfer redirect until the old name is reused or
 * the redirect lapses, and two of them are baked into artifacts already
 * shipped — the extension README's image URLs are absolute, and render from
 * the Marketplace and Open VSX listings, not from the repo.
 */
test("no tracked file points at a different owner of this repo", () => {
  const [OWNER, REPO] = releaseSlug().split("/");
  // git grep's -E is POSIX ERE: no `\\b`. The precise owner match happens in JS
  // below, so these only need to be broad enough to surface every candidate.
  const patterns = [
    `(github\\.com|raw\\.githubusercontent\\.com)/[A-Za-z0-9_.-]+/${REPO}`,
    `marketplace add [A-Za-z0-9_.-]+/${REPO}`
  ];

  let hits = "";
  try {
    hits = execFileSync("git", ["grep", "-InE", patterns.join("|")], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    });
  } catch (err) {
    // git grep exits 1 with no output when nothing matches.
    if (err.status !== 1) throw err;
  }

  const owned = new RegExp(
    `(?:github\\.com|raw\\.githubusercontent\\.com|marketplace add)[:/ ]([A-Za-z0-9_.-]+)/${REPO}(?![A-Za-z0-9_.-])`,
    "g"
  );
  const stale = [];
  for (const line of hits.split("\n").filter(Boolean)) {
    for (const [, owner] of line.matchAll(owned)) {
      if (!sameSlug(owner, OWNER)) stale.push(line.trim());
    }
  }

  assert.deepEqual(
    [...new Set(stale)],
    [],
    `this repo is ${OWNER}/${REPO}, but these still name another owner — README image URLs render from the ` +
      `Marketplace and Open VSX listings, and the manifest URL is what installed clients poll:\n  ` +
      [...new Set(stale)].join("\n  ")
  );
});
