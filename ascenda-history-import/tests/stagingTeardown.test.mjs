import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  STAGING_KEEP,
  checkSpaceForSnapshot,
  disposeStagingArea,
  formatBytes,
  freeSpaceBytes,
  STAGING_KEEP_RUNS,
  stagingSizeBytes,
  sweepStagingRoot
} from "../dist/staging.js";

/**
 * Staging teardown.
 *
 * The failure being pinned here is not subtle and not hypothetical: nineteen
 * runs left 254 GB of snapshots on a 926 GB disk, free space fell to 279 MB,
 * and unrelated tooling started failing with ENOSPC. The importer reported
 * nothing, because from its point of view nothing had gone wrong — it had
 * simply never been told to clean up.
 *
 * The rule these tests hold: a run keeps its extraction OUTPUT and removes its
 * INPUTS. `events.jsonl` is the part with lasting value, kept for the newest
 * `STAGING_KEEP_RUNS` runs only (one runs to ~200 MB); the
 * snapshot beside it is ~20 GB of someone else's files that we already read.
 */

async function makeRun(stagingRoot, id, { events = true } = {}) {
  const root = path.join(stagingRoot, id);
  await fs.mkdir(path.join(root, "vscode", "workspaceStorage", "hash-a", "chatSessions"), {
    recursive: true
  });
  await fs.mkdir(path.join(root, "claude_code", "projects"), { recursive: true });
  await fs.writeFile(
    path.join(root, "vscode", "workspaceStorage", "hash-a", "chatSessions", "s.json"),
    "x".repeat(4096)
  );
  await fs.writeFile(path.join(root, "claude_code", "projects", "t.jsonl"), "y".repeat(2048));
  await fs.writeFile(path.join(root, "cursor.vscdb"), "z".repeat(1024));
  if (events) await fs.writeFile(path.join(root, "events.jsonl"), '{"eventKind":"x"}\n');
  return { extractionId: id, root };
}

test("disposing a run removes the snapshot and keeps the extracted events", async () => {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "asc-stage-"));
  const area = await makeRun(stagingRoot, "run-1");

  const result = await disposeStagingArea(area);

  assert.deepEqual(
    (await fs.readdir(area.root)).sort(),
    ["events.jsonl"],
    "the snapshot is scaffolding; the extracted events are the product"
  );
  assert.deepEqual(result.kept, ["events.jsonl"]);
  assert.ok(result.freedBytes >= 4096 + 2048 + 1024, `freed ${result.freedBytes} bytes`);
});

test("disposing is idempotent and never throws — it runs in a finally", async () => {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "asc-stage-"));
  const area = await makeRun(stagingRoot, "run-1");

  await disposeStagingArea(area);
  const second = await disposeStagingArea(area);
  assert.equal(second.freedBytes, 0);

  // A run directory that was never created at all: teardown must not be able
  // to convert a failed run into a *differently* failed run.
  const missing = { extractionId: "nope", root: path.join(stagingRoot, "nope") };
  await assert.doesNotReject(() => disposeStagingArea(missing));
});

test("a partly-written run left by a crash is still fully torn down", async () => {
  // The 25 Aug run died mid-copy, so it had no events.jsonl at all — the exact
  // shape that must not be skipped for lacking the file we normally keep.
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "asc-stage-"));
  const area = await makeRun(stagingRoot, "crashed", { events: false });

  const result = await disposeStagingArea(area);

  assert.deepEqual(await fs.readdir(area.root), [], "a crashed run leaves nothing behind either");
  assert.ok(result.freedBytes > 0);
});

test("the sweep drains a backlog of old runs but never the live one", async () => {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "asc-stage-"));
  await makeRun(stagingRoot, "old-1");
  await makeRun(stagingRoot, "old-2");
  const live = await makeRun(stagingRoot, "live");

  const result = await sweepStagingRoot(stagingRoot, "live");

  assert.equal(result.runsSwept, 2, "both stale runs, and only those");
  assert.ok(result.freedBytes > 0);
  assert.deepEqual((await fs.readdir(path.join(stagingRoot, "old-1"))).sort(), ["events.jsonl"]);
  assert.ok(
    (await fs.readdir(live.root)).includes("vscode"),
    "the live run's snapshot is still being read — sweeping it would break the run doing the sweeping"
  );
});

test("sweeping an absent staging root is a no-op, not a failure", async () => {
  const result = await sweepStagingRoot(path.join(os.tmpdir(), "asc-does-not-exist-" + Date.now()));
  assert.deepEqual(result, { runsSwept: 0, runsRemoved: 0, freedBytes: 0 });
});

test("STAGING_KEEP is the extraction output, not its inputs", () => {
  assert.deepEqual(STAGING_KEEP, ["events.jsonl"]);
});

/* ---------------------------------------------------------------------- *
 * Pre-flight space
 * ---------------------------------------------------------------------- */

test("the pre-flight check measures the real sources rather than guessing", async () => {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "asc-stage-"));
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "asc-src-"));
  await fs.writeFile(path.join(source, "big"), "x".repeat(50_000));

  const check = await checkSpaceForSnapshot(stagingRoot, [source]);
  assert.ok(
    check.requiredBytes >= 50_000,
    "required space must include what we are about to copy, not a hardcoded figure"
  );
  assert.equal(check.sufficient, true, "a temp dir on a working machine has room for 50 KB + headroom");
});

test("an unknown free-space figure permits the run rather than blocking it", async () => {
  const check = await checkSpaceForSnapshot("/", []);
  assert.ok(check.freeBytes === null || typeof check.freeBytes === "number");
  if (check.freeBytes === null) assert.equal(check.sufficient, true);
});

test("free space is resolved through ancestors, since the staging root may not exist yet", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asc-stage-"));
  const notYet = path.join(root, "a", "b", "c", "staging");
  const free = await freeSpaceBytes(notYet);
  assert.ok(typeof free === "number" && free > 0, "must walk up to a mounted ancestor");
});

test("formatBytes reads as a size a human can act on", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(254 * 1024 ** 3), "254 GB");
});

/* Bounded retention: one events.jsonl runs to ~200 MB, so only the newest
 * STAGING_KEEP_RUNS keep theirs. */

const ids = [
  "2026-08-25T09-00-00-000Z-aaaaaaaa",
  "2026-09-03T09-00-00-000Z-bbbbbbbb",
  "2026-10-25T09-00-00-000Z-cccccccc",
  "2026-10-26T01-48-22-730Z-f49e8dfc"
];

async function exists(p) {
  return fs.access(p).then(() => true, () => false);
}

test("the sweep keeps events.jsonl for the newest runs and removes older runs whole", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "asc-bound-"));
  const stagingRoot = path.join(home, "staging");
  // Create newest first so mtime order is the reverse of timestamp order.
  for (const id of [...ids].reverse()) await makeRun(stagingRoot, id);

  const result = await sweepStagingRoot(stagingRoot);

  assert.equal(STAGING_KEEP_RUNS, 2);
  assert.equal(result.runsRemoved, 2);
  assert.equal(await exists(path.join(stagingRoot, ids[0])), false);
  assert.equal(await exists(path.join(stagingRoot, ids[1])), false);
  for (const id of ids.slice(2)) {
    assert.deepEqual(await fs.readdir(path.join(stagingRoot, id)), ["events.jsonl"]);
  }
});

test("the live run is never touched and counts toward the kept runs", async () => {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "asc-bound-"));
  for (const id of ids) await makeRun(stagingRoot, id);
  const live = ids[3];

  await sweepStagingRoot(stagingRoot, live);

  const liveEntries = (await fs.readdir(path.join(stagingRoot, live))).sort();
  assert.ok(liveEntries.includes("cursor.vscdb"), "live snapshot left intact");
  assert.deepEqual(await fs.readdir(path.join(stagingRoot, ids[2])), ["events.jsonl"]);
  assert.equal(await exists(path.join(stagingRoot, ids[1])), false);
  assert.equal(await exists(path.join(stagingRoot, ids[0])), false);
});

test("the live run is spared even when it is not among the newest", async () => {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "asc-bound-"));
  for (const id of ids) await makeRun(stagingRoot, id);

  await sweepStagingRoot(stagingRoot, ids[0]);

  assert.ok((await fs.readdir(path.join(stagingRoot, ids[0]))).includes("cursor.vscdb"));
  assert.equal(await exists(path.join(stagingRoot, ids[1])), false);
});

test("the archive beside staging is never reached", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "asc-bound-"));
  const stagingRoot = path.join(home, "staging");
  const archive = path.join(home, "archive", "objects");
  await fs.mkdir(archive, { recursive: true });
  await fs.writeFile(path.join(archive, "blob"), "keep me");
  for (const id of ids) await makeRun(stagingRoot, id);
  // A symlinked run pointing at the archive must not be followed.
  await fs.symlink(path.join(home, "archive"), path.join(stagingRoot, "2020-01-01T00-00-00-000Z-00000000"));

  await sweepStagingRoot(stagingRoot, undefined, undefined, 0);

  assert.equal(await fs.readFile(path.join(archive, "blob"), "utf8"), "keep me");
});

test("directories whose names aren't extraction ids are not removed", async () => {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "asc-bound-"));
  for (const id of ids) await makeRun(stagingRoot, id);
  await makeRun(stagingRoot, "notes");
  await makeRun(stagingRoot, "2026-10-26-not-an-id");

  await sweepStagingRoot(stagingRoot);

  assert.deepEqual(await fs.readdir(path.join(stagingRoot, "notes")), ["events.jsonl"]);
  assert.deepEqual(await fs.readdir(path.join(stagingRoot, "2026-10-26-not-an-id")), ["events.jsonl"]);
});

test("stagingSizeBytes reports what the root holds", async () => {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "asc-bound-"));
  await fs.mkdir(path.join(stagingRoot, ids[0]));
  await fs.writeFile(path.join(stagingRoot, ids[0], "events.jsonl"), "x".repeat(500));
  assert.equal(await stagingSizeBytes(stagingRoot), 500);
  assert.equal(await stagingSizeBytes(path.join(stagingRoot, "absent")), 0);
});
