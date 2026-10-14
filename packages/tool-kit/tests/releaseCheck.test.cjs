const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  RELEASE_MANIFEST_URL,
  compareReleases,
  describeReleaseCheck,
  pendingReleaseNotice,
  readReleaseCheck,
  refreshReleaseCheck,
  releaseCheckPath,
  releaseStanding,
  runsFromInstalledBundle
} = require("../out/index.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-14T09:00:00Z");

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-release-"));
  const previous = process.env.ASCENDA_HOME;
  process.env.ASCENDA_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.ASCENDA_HOME;
    else process.env.ASCENDA_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeCheck(check) {
  fs.mkdirSync(path.dirname(releaseCheckPath()), { recursive: true });
  fs.writeFileSync(releaseCheckPath(), JSON.stringify(check));
}

function manifestFetch(body, calls = []) {
  return async (url) => {
    calls.push(url);
    return { ok: true, json: async () => body };
  };
}

const MANIFEST = { version: "0.1.36", minNode: 20, compatibility: { minCollectorVersion: "0.1.9", contractVersion: "0.1.0" } };
const NOTICE = { setupCommand: "npx -y @ascenda-one/claude-code-hooks setup", agentName: "Claude Code", nodeMajor: 22, env: {} };

test("compareReleases orders releases, puts a prerelease first, and won't guess", () => {
  assert.ok(compareReleases("0.1.33", "0.1.36") < 0);
  assert.ok(compareReleases("v0.2.0", "0.1.99") > 0);
  assert.equal(compareReleases("0.1.36", "v0.1.36"), 0);
  assert.ok(compareReleases("0.1.36-rc.1", "0.1.36") < 0);
  assert.equal(compareReleases("unreleased", "0.1.36"), undefined);
});

test("releaseStanding: below the floor, behind, current", () => {
  const check = { latestVersion: "0.1.36", minCollectorVersion: "0.1.9" };
  assert.deepEqual(releaseStanding("0.1.8", check), { kind: "unsupported", latest: "0.1.36", floor: "0.1.9" });
  assert.deepEqual(releaseStanding("0.1.33", check), { kind: "behind", latest: "0.1.36" });
  assert.deepEqual(releaseStanding("0.1.36", check), { kind: "current", latest: "0.1.36" });
  assert.equal(releaseStanding("0.1.33", undefined), undefined);
});

test("refresh fetches the manifest and records the latest release and floors", () => withHome(async () => {
  const calls = [];
  const check = await refreshReleaseCheck({ installed: "0.1.33", now: NOW, env: {}, fetchImpl: manifestFetch(MANIFEST, calls) });
  assert.deepEqual(calls, [RELEASE_MANIFEST_URL]);
  assert.equal(check.latestVersion, "0.1.36");
  assert.equal(check.minCollectorVersion, "0.1.9");
  assert.equal(check.minNode, 20);
  assert.equal(readReleaseCheck().checkedAt, new Date(NOW).toISOString());
}));

test("refresh fetches at most once a day", () => withHome(async () => {
  const calls = [];
  const fetchImpl = manifestFetch(MANIFEST, calls);
  await refreshReleaseCheck({ installed: "0.1.33", now: NOW, env: {}, fetchImpl });
  await refreshReleaseCheck({ installed: "0.1.33", now: NOW + DAY - 1, env: {}, fetchImpl });
  assert.equal(calls.length, 1);
  await refreshReleaseCheck({ installed: "0.1.33", now: NOW + DAY, env: {}, fetchImpl });
  assert.equal(calls.length, 2);
}));

test("a failed fetch keeps the last good check and waits an hour to retry", () => withHome(async () => {
  writeCheck({ latestVersion: "0.1.35", checkedAt: new Date(NOW - 2 * DAY).toISOString() });
  let calls = 0;
  const failing = async () => { calls += 1; throw new Error("offline"); };
  const after = await refreshReleaseCheck({ installed: "0.1.33", now: NOW, env: {}, fetchImpl: failing });
  assert.equal(after.latestVersion, "0.1.35");
  await refreshReleaseCheck({ installed: "0.1.33", now: NOW + 30 * 60 * 1000, env: {}, fetchImpl: failing });
  assert.equal(calls, 1);
}));

test("refresh does nothing when switched off or for a build with no release", () => withHome(async () => {
  const calls = [];
  await refreshReleaseCheck({ installed: "0.1.33", now: NOW, env: { ASCENDA_DISABLE_UPDATE_CHECK: "true" }, fetchImpl: manifestFetch(MANIFEST, calls) });
  await refreshReleaseCheck({ installed: "unreleased", now: NOW, env: {}, fetchImpl: manifestFetch(MANIFEST, calls) });
  assert.equal(calls.length, 0);
  assert.equal(readReleaseCheck(), undefined);
}));

test("refresh ignores a manifest with no usable version", () => withHome(async () => {
  const check = await refreshReleaseCheck({ installed: "0.1.33", now: NOW, env: {}, fetchImpl: manifestFetch({ version: "latest" }) });
  assert.equal(check.latestVersion, undefined);
  assert.equal(check.checkedAt, undefined);
}));

test("a release behind is noted once per release", () => withHome(async () => {
  writeCheck({ latestVersion: "0.1.36", minCollectorVersion: "0.1.9", checkedAt: new Date(NOW).toISOString() });
  const first = pendingReleaseNotice({ ...NOTICE, installed: "0.1.33" });
  assert.match(first.text, /hooks here are 0\.1\.33, and 0\.1\.36 is out/);
  assert.match(first.text, /npx -y @ascenda-one\/claude-code-hooks setup`, then restart Claude Code/);
  first.markShown();
  assert.equal(pendingReleaseNotice({ ...NOTICE, installed: "0.1.33" }), undefined);

  writeCheck({ ...readReleaseCheck(), latestVersion: "0.1.37" });
  assert.match(pendingReleaseNotice({ ...NOTICE, installed: "0.1.33" }).text, /0\.1\.37 is out/);
}));

test("below the floor, the note repeats until the install is updated", () => withHome(async () => {
  writeCheck({ latestVersion: "0.1.36", minCollectorVersion: "0.1.9", checkedAt: new Date(NOW).toISOString() });
  const first = pendingReleaseNotice({ ...NOTICE, installed: "0.1.8" });
  assert.match(first.text, /older than the oldest supported release \(0\.1\.9\)/);
  first.markShown();
  assert.ok(pendingReleaseNotice({ ...NOTICE, installed: "0.1.8" }));
}));

test("the note names Node when the latest release needs a newer one", () => withHome(async () => {
  writeCheck({ latestVersion: "0.1.36", minNode: 22, checkedAt: new Date(NOW).toISOString() });
  assert.match(pendingReleaseNotice({ ...NOTICE, installed: "0.1.33", nodeMajor: 20 }).text, /needs Node 22 or newer and these hooks run on Node 20/);
}));

test("no note when current, switched off, unreleased, or never checked", () => withHome(async () => {
  assert.equal(pendingReleaseNotice({ ...NOTICE, installed: "0.1.33" }), undefined);
  writeCheck({ latestVersion: "0.1.36", checkedAt: new Date(NOW).toISOString() });
  assert.equal(pendingReleaseNotice({ ...NOTICE, installed: "0.1.36" }), undefined);
  assert.equal(pendingReleaseNotice({ ...NOTICE, installed: "unreleased" }), undefined);
  assert.equal(pendingReleaseNotice({ ...NOTICE, installed: "0.1.33", env: { ASCENDA_DISABLE_UPDATE_CHECK: "true" } }), undefined);
}));

test("status line reads the last check and says why there isn't one", () => withHome(async () => {
  const base = { installed: "0.1.33", setupCommand: "npx -y x setup", now: NOW, env: {} };
  assert.match(describeReleaseCheck({ ...base, localOnly: true }), /unpaired install makes no network requests/);
  assert.match(describeReleaseCheck({ ...base, localOnly: false, env: { ASCENDA_DISABLE_UPDATE_CHECK: "true" } }), /ASCENDA_DISABLE_UPDATE_CHECK is set/);
  assert.match(describeReleaseCheck({ ...base, localOnly: false }), /not checked yet/);
  writeCheck({ latestVersion: "0.1.36", minCollectorVersion: "0.1.9", checkedAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString() });
  assert.equal(describeReleaseCheck({ ...base, localOnly: false }), "0.1.36 (checked 3 h ago). Update: npx -y x setup");
  assert.equal(describeReleaseCheck({ ...base, installed: "0.1.36", localOnly: false }), "0.1.36, up to date (checked 3 h ago)");
}));

test("runsFromInstalledBundle is true only for the copy setup installed", () => withHome(async (home) => {
  assert.equal(runsFromInstalledBundle(path.join(home, "bin", "ascenda-claude-hook.mjs")), true);
  assert.equal(runsFromInstalledBundle(path.join(home, "..", "_npx", "abc", "node_modules", "x", "dist", "cli.js")), false);
  assert.equal(runsFromInstalledBundle(undefined), false);
}));
