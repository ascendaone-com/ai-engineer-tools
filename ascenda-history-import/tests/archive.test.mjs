import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  archiveSizeBytes,
  archiveStores,
  listManifests,
  pruneArchive,
  readLatestManifest,
  restoreArchive,
  verifyArchive
} from "../dist/archive.js";

/**
 * The durable copy.
 *
 * `fix-retention` stops Claude Code trimming itself, which is retention in
 * place — not a backup. Nothing held a second copy of these stores except, by
 * accident, the abandoned staging snapshots that filled a 926 GB disk. This
 * module is the deliberate replacement, and these tests hold the three
 * properties that make it worth having: it deduplicates, it can prove what it
 * holds, and it can be bounded.
 */

async function makeStore(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asc-store-"));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  return root;
}

async function archiveRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "asc-archive-"));
}

function sourcesFor(root, label = "projects", store = "claude_code") {
  return [{ store, root, label }];
}

let clock = 0;
function generation() {
  clock += 1;
  return `2026-08-25T00-00-0${clock}-000Z`;
}

async function run(root, sources, gen = generation()) {
  return archiveStores({ archiveRoot: root, sources, generation: gen, now: "2026-08-25T00:00:00.000Z" });
}

test("an archive stores what it is given, and can say what it holds", async () => {
  const store = await makeStore({ "proj/a.jsonl": "alpha", "proj/b.jsonl": "beta" });
  const root = await archiveRoot();

  const result = await run(root, sourcesFor(store));

  assert.equal(result.filesArchived, 2);
  assert.equal(result.filesDeduplicated, 0);
  assert.equal(result.newBytes, "alpha".length + "beta".length);

  const manifest = await readLatestManifest(root);
  assert.equal(manifest.files.length, 2);
  assert.deepEqual(
    manifest.files.map((f) => f.relativePath).sort(),
    ["projects/proj/a.jsonl", "projects/proj/b.jsonl"]
  );
});

test("re-archiving an unchanged store stores no new bytes", async () => {
  // The property that makes this affordable enough to run often. A backup
  // people skip because it costs 4 GB a time is not a backup.
  const store = await makeStore({ "proj/a.jsonl": "alpha", "proj/b.jsonl": "beta" });
  const root = await archiveRoot();

  await run(root, sourcesFor(store));
  const second = await run(root, sourcesFor(store));

  assert.equal(second.filesArchived, 2, "the generation still names every file");
  assert.equal(second.filesDeduplicated, 2, "but holds no new copy of any of them");
  assert.equal(second.newBytes, 0);
  assert.equal((await listManifests(root)).length, 2, "two generations, one copy of the data");
});

test("a file that grew is kept at BOTH versions — that is what an archive is for", async () => {
  const store = await makeStore({ "proj/a.jsonl": "line one\n" });
  const root = await archiveRoot();
  const first = await run(root, sourcesFor(store));

  await fs.writeFile(path.join(store, "proj/a.jsonl"), "line one\nline two\n");
  const second = await run(root, sourcesFor(store));

  assert.ok(second.newBytes > 0, "the grown file is a new blob");
  const [genA, genB] = await listManifests(root);
  const manifestA = JSON.parse(await fs.readFile(path.join(root, "manifests", `${genA}.json`), "utf8"));
  const manifestB = JSON.parse(await fs.readFile(path.join(root, "manifests", `${genB}.json`), "utf8"));
  assert.notEqual(
    manifestA.files[0].sha256,
    manifestB.files[0].sha256,
    "the earlier state must still be recoverable"
  );
  assert.equal(first.filesArchived, 1);
});

test("a file the archive cannot read is counted, and fails the run", async () => {
  // The failure this whole investigation is about is a copy that reported
  // success while dropping the largest source it was given.
  const store = await makeStore({ "proj/a.jsonl": "alpha", "proj/locked.jsonl": "secret" });
  const locked = path.join(store, "proj/locked.jsonl");
  await fs.chmod(locked, 0o000);
  const root = await archiveRoot();
  try {
    const result = await run(root, sourcesFor(store));
    assert.equal(result.unreadable, 1, "an attempted-and-failed read must be counted");
    assert.equal(result.filesArchived, 1, "and must not be counted as archived");
  } finally {
    await fs.chmod(locked, 0o644).catch(() => {});
  }
});

test("two sources of the same store cannot collide in a manifest", async () => {
  const history = await makeStore({ "aaa/entries.json": "one" });
  const sessions = await makeStore({ "aaa/entries.json": "two" });
  const root = await archiveRoot();

  const result = await run(root, [
    { store: "vscode", root: history, label: "history" },
    { store: "vscode", root: sessions, label: "workspaceStorage" }
  ]);

  assert.equal(result.filesArchived, 2, "same relative path, different source — both must survive");
  const manifest = await readLatestManifest(root);
  assert.deepEqual(
    manifest.files.map((f) => f.relativePath).sort(),
    ["history/aaa/entries.json", "workspaceStorage/aaa/entries.json"]
  );
});

test("a single-file store brings its SQLite journals with it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asc-cursor-"));
  const db = path.join(dir, "state.vscdb");
  await fs.writeFile(db, "main");
  await fs.writeFile(db + "-wal", "journal");
  const root = await archiveRoot();

  const result = await run(root, [
    { store: "cursor", root: db, siblings: ["-wal", "-shm"], label: "state" }
  ]);

  assert.equal(result.filesArchived, 2, "a WAL db archived without its journal loses the newest writes");
  const manifest = await readLatestManifest(root);
  assert.ok(manifest.files.some((f) => f.relativePath.endsWith("state.vscdb-wal")));
});

/* ---------------------------------------------------------------------- *
 * Verify
 * ---------------------------------------------------------------------- */

test("verification passes on an intact archive", async () => {
  const store = await makeStore({ "proj/a.jsonl": "alpha", "proj/b.jsonl": "beta" });
  const root = await archiveRoot();
  await run(root, sourcesFor(store));

  const verified = await verifyArchive(root, await readLatestManifest(root));
  assert.equal(verified.checked, 2);
  assert.deepEqual(verified.missing, []);
  assert.deepEqual(verified.corrupted, []);
});

test("verification catches a blob that was deleted underneath it", async () => {
  const store = await makeStore({ "proj/a.jsonl": "alpha" });
  const root = await archiveRoot();
  await run(root, sourcesFor(store));
  const manifest = await readLatestManifest(root);

  const blob = path.join(root, "objects", manifest.files[0].sha256.slice(0, 2), manifest.files[0].sha256);
  await fs.rm(blob);

  const verified = await verifyArchive(root, manifest);
  assert.deepEqual(verified.missing, ["projects/proj/a.jsonl"], "a backup must be able to prove it is still there");
});

test("verification catches a blob whose contents changed", async () => {
  const store = await makeStore({ "proj/a.jsonl": "alpha" });
  const root = await archiveRoot();
  await run(root, sourcesFor(store));
  const manifest = await readLatestManifest(root);

  const blob = path.join(root, "objects", manifest.files[0].sha256.slice(0, 2), manifest.files[0].sha256);
  await fs.writeFile(blob, "tampered");

  const verified = await verifyArchive(root, manifest);
  assert.deepEqual(verified.corrupted, ["projects/proj/a.jsonl"]);
});

test("the fast path re-archives rather than trusting a manifest whose blob is gone", async () => {
  // (path, size, mtime) matching is an optimisation, never a source of truth.
  // Trusting it blindly would let a pruned archive keep claiming a file.
  const store = await makeStore({ "proj/a.jsonl": "alpha" });
  const root = await archiveRoot();
  const first = await run(root, sourcesFor(store));
  const manifest = await readLatestManifest(root);
  const sha = manifest.files[0].sha256;
  await fs.rm(path.join(root, "objects", sha.slice(0, 2), sha));

  const second = await run(root, sourcesFor(store));

  assert.equal(second.newBytes, "alpha".length, "the missing blob must be re-materialised");
  const verified = await verifyArchive(root, await readLatestManifest(root));
  assert.deepEqual(verified.missing, []);
  assert.equal(first.filesArchived, 1);
});

/* ---------------------------------------------------------------------- *
 * Restore
 * ---------------------------------------------------------------------- */

test("a generation restores to real files with their contents intact", async () => {
  const store = await makeStore({ "proj/a.jsonl": "alpha", "proj/nested/b.jsonl": "beta" });
  const root = await archiveRoot();
  await run(root, sourcesFor(store));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "asc-restore-"));

  const result = await restoreArchive(root, await readLatestManifest(root), destination);

  assert.equal(result.restored, 2);
  assert.equal(
    await fs.readFile(path.join(destination, "claude_code", "projects", "proj", "a.jsonl"), "utf8"),
    "alpha"
  );
  assert.equal(
    await fs.readFile(path.join(destination, "claude_code", "projects", "proj", "nested", "b.jsonl"), "utf8"),
    "beta"
  );
});

test("an older generation restores the older contents, not the newest", async () => {
  const store = await makeStore({ "proj/a.jsonl": "first" });
  const root = await archiveRoot();
  await run(root, sourcesFor(store));
  await fs.writeFile(path.join(store, "proj/a.jsonl"), "second");
  await run(root, sourcesFor(store));

  const [oldest] = await listManifests(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifests", `${oldest}.json`), "utf8"));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "asc-restore-"));
  await restoreArchive(root, manifest, destination);

  assert.equal(
    await fs.readFile(path.join(destination, "claude_code", "projects", "proj", "a.jsonl"), "utf8"),
    "first",
    "point-in-time recovery is the reason generations exist"
  );
});

/* ---------------------------------------------------------------------- *
 * Prune
 * ---------------------------------------------------------------------- */

test("pruning drops old generations and the blobs nothing references", async () => {
  const store = await makeStore({ "proj/a.jsonl": "v1" });
  const root = await archiveRoot();
  await run(root, sourcesFor(store));
  await fs.writeFile(path.join(store, "proj/a.jsonl"), "v2-longer");
  await run(root, sourcesFor(store));

  const pruned = await pruneArchive(root, 1);

  assert.equal(pruned.generationsRemoved.length, 1);
  assert.equal(pruned.blobsRemoved, 1, "the v1 blob is referenced by nothing now");
  assert.equal((await listManifests(root)).length, 1);
  const verified = await verifyArchive(root, await readLatestManifest(root));
  assert.deepEqual(verified.missing, [], "pruning must never break the generations it keeps");
});

test("a blob still referenced by a surviving generation is never pruned", async () => {
  const store = await makeStore({ "proj/a.jsonl": "stable" });
  const root = await archiveRoot();
  await run(root, sourcesFor(store));
  await run(root, sourcesFor(store));

  const pruned = await pruneArchive(root, 1);

  assert.equal(pruned.generationsRemoved.length, 1);
  assert.equal(pruned.blobsRemoved, 0, "both generations shared the blob — dropping one must not delete it");
  const verified = await verifyArchive(root, await readLatestManifest(root));
  assert.deepEqual(verified.missing, []);
});

test("keeping more generations than exist removes nothing", async () => {
  const store = await makeStore({ "proj/a.jsonl": "alpha" });
  const root = await archiveRoot();
  await run(root, sourcesFor(store));

  const pruned = await pruneArchive(root, 10);
  assert.deepEqual(pruned.generationsRemoved, []);
  assert.equal(pruned.blobsRemoved, 0);
});

test("the archive can report its own size — the failure being avoided is silent growth", async () => {
  const store = await makeStore({ "proj/a.jsonl": "x".repeat(1000) });
  const root = await archiveRoot();
  await run(root, sourcesFor(store));

  assert.equal(await archiveSizeBytes(root), 1000);
  await run(root, sourcesFor(store));
  assert.equal(await archiveSizeBytes(root), 1000, "a second generation of unchanged data adds nothing");
});

test("an absent archive reports zero rather than throwing", async () => {
  const missing = path.join(os.tmpdir(), "asc-no-archive-" + process.pid);
  assert.equal(await archiveSizeBytes(missing), 0);
  assert.deepEqual(await listManifests(missing), []);
  assert.equal(await readLatestManifest(missing), null);
});
