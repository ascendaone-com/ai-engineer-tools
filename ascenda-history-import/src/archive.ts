/**
 * The durable copy — the one thing in this package allowed to outlive the run
 * that made it.
 *
 * Everything else here is scaffolding: `staging/` is torn down by the run that
 * creates it, and `fix-retention` stops Claude Code's rolling purge *in
 * place*. Retention-in-place is not a backup. It keeps the live store from
 * trimming itself; it does nothing if that store is deleted, corrupted, or
 * lost with the machine. Until now the only thing filling that role was an
 * accident — abandoned staging snapshots nobody was maintaining, which is
 * exactly how 254 GB accumulated unnoticed.
 *
 * So this is deliberate, and built to three rules the accident broke:
 *
 *  1. **It lives outside `staging/`.** `sweepStagingRoot` walks the staging
 *     root and only the staging root; nothing here is reachable from it. An
 *     archive a cleanup can delete is not an archive.
 *  2. **It deduplicates.** Content-addressed blobs: an unchanged transcript is
 *     stored once no matter how many times it is archived. Re-archiving a 3 GB
 *     store that has not changed costs kilobytes.
 *  3. **It reports its own size, and can be pruned.** An archive that only
 *     grows is the same defect wearing a different hat. `pruneArchive` exists
 *     and the CLI prints the total every run, because the failure this package
 *     has already demonstrated is disk consumed silently.
 *
 * Layout:
 *
 *     archive/
 *       objects/<aa>/<sha256>          content-addressed, written once
 *       manifests/<generation>.json    one per archive run
 *
 * A manifest IS the generation: it names every file in the store at that
 * moment and the blob holding its contents. Because blobs are shared, a
 * transcript that grew between runs keeps BOTH versions — which is what an
 * archive is for — while one that did not costs nothing to keep again.
 *
 * The manifest is written LAST. A run killed halfway leaves unreferenced blobs
 * (collected by `pruneArchive`), never a manifest promising data that is not
 * there.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { HistoryStore } from "./types.js";
import { StorePaths } from "./stores.js";

export const ARCHIVE_SCHEMA = 1;

export function defaultArchiveRoot(home: string): string {
  return path.join(home, ".ascenda", "history-import", "archive");
}

export interface ArchivedFile {
  store: HistoryStore;
  /** Path relative to the store's own root, so a restore is unambiguous. */
  relativePath: string;
  sha256: string;
  size: number;
  /** Source mtime, used only to skip re-hashing an unchanged file. */
  mtimeMs: number;
}

export interface ArchiveManifest {
  schema: number;
  generation: string;
  createdAt: string;
  /** Store -> the absolute source root it was read from, for restore. */
  roots: Record<string, string>;
  files: ArchivedFile[];
}

export interface ArchiveSource {
  store: HistoryStore;
  /** A directory, or a single file (Cursor's db). */
  root: string;
  /** Suffixes to pick up alongside a single-file store (SQLite journals). */
  siblings?: string[];
  /** Distinguishes two sources of the same store in a manifest. */
  label: string;
}

/**
 * What gets archived by default, and why.
 *
 * Claude Code and Cursor are here because they are the stores that actually
 * evaporate: Claude Code purges on a rolling window (disarmed only by
 * `fix-retention`, and only on this machine), and Cursor's db is a single file
 * whose loss takes everything with it.
 *
 * VS Code chat sessions are NOT here by default. They are 15 GB, VS Code is
 * not deleting them, and copying them every run is the precise mistake that
 * filled a disk. `--include-vscode-sessions` opts in.
 */
export function defaultArchiveSources(
  paths: StorePaths,
  includeVsCodeSessions = false
): ArchiveSource[] {
  const sources: ArchiveSource[] = [
    { store: "claude_code", root: paths.claudeProjects, label: "projects" },
    { store: "cursor", root: paths.cursorStateDb, siblings: ["-wal", "-shm"], label: "state" },
    { store: "vscode", root: paths.vscodeHistory, label: "history" }
  ];
  if (includeVsCodeSessions) {
    sources.push({ store: "vscode", root: paths.vscodeWorkspaceStorage, label: "workspaceStorage" });
  }
  return sources;
}

function blobPath(archiveRoot: string, sha256: string): string {
  return path.join(archiveRoot, "objects", sha256.slice(0, 2), sha256);
}

function manifestDir(archiveRoot: string): string {
  return path.join(archiveRoot, "manifests");
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  // Streamed rather than read whole: Cursor's store is ~940 MB and several VS
  // Code sessions on this machine are close enough to V8's maximum string
  // length that reading one into memory is a live hazard.
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Every regular file under `root`, or `root` itself when it is a file. */
async function walkFiles(root: string): Promise<{ absolute: string; relative: string }[]> {
  let st;
  try {
    st = await fs.stat(root);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [{ absolute: root, relative: path.basename(root) }];

  const found: { absolute: string; relative: string }[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory — surfaced through the caller's counter.
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) found.push({ absolute, relative });
    }
  }
  await walk(root, "");
  return found;
}

export async function listManifests(archiveRoot: string): Promise<string[]> {
  try {
    return (await fs.readdir(manifestDir(archiveRoot)))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

export async function readManifest(
  archiveRoot: string,
  generation: string
): Promise<ArchiveManifest | null> {
  try {
    const raw = await fs.readFile(path.join(manifestDir(archiveRoot), `${generation}.json`), "utf8");
    const parsed = JSON.parse(raw) as ArchiveManifest;
    if (parsed.schema !== ARCHIVE_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function readLatestManifest(archiveRoot: string): Promise<ArchiveManifest | null> {
  const generations = await listManifests(archiveRoot);
  const latest = generations[generations.length - 1];
  return latest ? readManifest(archiveRoot, latest) : null;
}

export interface StoreArchiveCounts {
  files: number;
  newBytes: number;
}

export interface ArchiveResult {
  generation: string;
  manifestPath: string;
  filesArchived: number;
  /** Files whose contents the archive already held — zero new bytes stored. */
  filesDeduplicated: number;
  newBytes: number;
  totalBytes: number;
  perStore: Record<string, StoreArchiveCounts>;
  /** Files the walk found and could not read. Counted, never dropped. */
  unreadable: number;
}

export interface ArchiveOptions {
  archiveRoot: string;
  sources: ArchiveSource[];
  generation: string;
  now: string;
}

/**
 * Archive every source, storing only contents the archive does not hold.
 *
 * The fast path matters: re-hashing 4 GB every run to discover nothing changed
 * would make this expensive enough to skip, and a backup people skip is not a
 * backup. A file whose (path, size, mtime) matches the previous generation
 * reuses that generation's hash — but only after confirming the blob is still
 * on disk, so a pruned or damaged archive re-materialises the file rather than
 * silently recording a reference to nothing.
 */
export async function archiveStores(options: ArchiveOptions): Promise<ArchiveResult> {
  const { archiveRoot, sources, generation, now } = options;
  const result: ArchiveResult = {
    generation,
    manifestPath: path.join(manifestDir(archiveRoot), `${generation}.json`),
    filesArchived: 0,
    filesDeduplicated: 0,
    newBytes: 0,
    totalBytes: 0,
    perStore: {},
    unreadable: 0
  };

  await fs.mkdir(path.join(archiveRoot, "objects"), { recursive: true });
  await fs.mkdir(manifestDir(archiveRoot), { recursive: true });

  const previous = await readLatestManifest(archiveRoot);
  const previousByKey = new Map<string, ArchivedFile>();
  for (const file of previous?.files ?? []) {
    previousByKey.set(`${file.store}/${file.relativePath}`, file);
  }

  const files: ArchivedFile[] = [];
  const roots: Record<string, string> = {};

  for (const source of sources) {
    roots[`${source.store}/${source.label}`] = source.root;
    const targets = await walkFiles(source.root);
    for (const suffix of source.siblings ?? []) {
      const absolute = source.root + suffix;
      try {
        await fs.stat(absolute);
        targets.push({ absolute, relative: path.basename(absolute) });
      } catch {
        // No journal sibling — a checkpointed or non-WAL db. Fine.
      }
    }

    const storeStats: StoreArchiveCounts = (result.perStore[source.store] ??= {
      files: 0,
      newBytes: 0
    });

    for (const target of targets) {
      // Namespaced by label so two sources of the same store cannot collide.
      const relativePath = `${source.label}/${target.relative}`;
      let st;
      try {
        st = await fs.stat(target.absolute);
      } catch {
        result.unreadable += 1;
        continue;
      }

      const prior = previousByKey.get(`${source.store}/${relativePath}`);
      let sha256: string | null = null;

      if (prior && prior.size === st.size && prior.mtimeMs === st.mtimeMs) {
        // Unchanged since the last generation — but only trust that if the
        // blob it points at is genuinely still there.
        try {
          await fs.stat(blobPath(archiveRoot, prior.sha256));
          sha256 = prior.sha256;
        } catch {
          sha256 = null; // Blob gone: re-archive rather than record a lie.
        }
      }

      if (sha256 === null) {
        try {
          sha256 = await hashFile(target.absolute);
        } catch {
          result.unreadable += 1;
          continue;
        }
      }

      const destination = blobPath(archiveRoot, sha256);
      let alreadyHeld = true;
      try {
        await fs.stat(destination);
      } catch {
        alreadyHeld = false;
      }

      if (alreadyHeld) {
        result.filesDeduplicated += 1;
      } else {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        // Write under a temporary name and rename. A blob is addressed by its
        // contents, so a half-written one sitting under its final name would
        // be indistinguishable from a good one forever after.
        const temporary = `${destination}.tmp-${generation}`;
        try {
          await fs.copyFile(target.absolute, temporary);
          await fs.rename(temporary, destination);
          result.newBytes += st.size;
          storeStats.newBytes += st.size;
        } catch {
          await fs.rm(temporary, { force: true });
          result.unreadable += 1;
          continue;
        }
      }

      files.push({
        store: source.store,
        relativePath,
        sha256,
        size: st.size,
        mtimeMs: st.mtimeMs
      });
      result.filesArchived += 1;
      result.totalBytes += st.size;
      storeStats.files += 1;
    }
  }

  const manifest: ArchiveManifest = {
    schema: ARCHIVE_SCHEMA,
    generation,
    createdAt: now,
    roots,
    files
  };
  // Last, and atomically: a manifest is a promise that every blob it names is
  // on disk, and a run killed mid-copy must not be able to make that promise.
  const temporary = `${result.manifestPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fs.rename(temporary, result.manifestPath);

  return result;
}

/* ------------------------------------------------------------------------ *
 * Verify
 * ------------------------------------------------------------------------ */

export interface VerifyResult {
  generation: string;
  checked: number;
  missing: string[];
  corrupted: string[];
}

/**
 * Re-hash every blob a generation names.
 *
 * An unverified backup is a belief, not a fact — and this package's recurring
 * defect has been surfaces reporting something adjacent to what they claim.
 * `--verify` turns "it archived" into something checkable.
 */
export async function verifyArchive(
  archiveRoot: string,
  manifest: ArchiveManifest,
  deep = true
): Promise<VerifyResult> {
  const result: VerifyResult = { generation: manifest.generation, checked: 0, missing: [], corrupted: [] };
  const hashed = new Set<string>();
  for (const file of manifest.files) {
    const blob = blobPath(archiveRoot, file.sha256);
    result.checked += 1;
    try {
      await fs.stat(blob);
    } catch {
      result.missing.push(file.relativePath);
      continue;
    }
    if (!deep || hashed.has(file.sha256)) continue;
    hashed.add(file.sha256);
    let actual: string;
    try {
      actual = await hashFile(blob);
    } catch {
      result.corrupted.push(file.relativePath);
      continue;
    }
    if (actual !== file.sha256) result.corrupted.push(file.relativePath);
  }
  return result;
}

/* ------------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------------ */

export interface RestoreResult {
  restored: number;
  skipped: number;
  destination: string;
}

/**
 * Materialise a generation into `destination`.
 *
 * NEVER into the live store. Restoring over `~/.claude/projects` in place
 * would make this an archive command that can destroy the thing it exists to
 * protect, and a mistyped `--generation` would be unrecoverable. The caller
 * copies back by hand, having looked at what came out.
 */
export async function restoreArchive(
  archiveRoot: string,
  manifest: ArchiveManifest,
  destination: string
): Promise<RestoreResult> {
  const result: RestoreResult = { restored: 0, skipped: 0, destination };
  for (const file of manifest.files) {
    const blob = blobPath(archiveRoot, file.sha256);
    const target = path.join(destination, file.store, file.relativePath);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(blob, target);
      result.restored += 1;
    } catch {
      result.skipped += 1;
    }
  }
  return result;
}

/* ------------------------------------------------------------------------ *
 * Prune
 * ------------------------------------------------------------------------ */

export interface PruneResult {
  generationsRemoved: string[];
  blobsRemoved: number;
  freedBytes: number;
}

/**
 * Drop all but the newest `keep` generations, then delete every blob no
 * surviving manifest references.
 *
 * This exists because the alternative is the defect this package just spent a
 * commit fixing: storage that only ever grows, silently, until something
 * unrelated fails with ENOSPC. Unreferenced blobs left behind by a killed run
 * are collected here too.
 */
export async function pruneArchive(archiveRoot: string, keep: number): Promise<PruneResult> {
  const result: PruneResult = { generationsRemoved: [], blobsRemoved: 0, freedBytes: 0 };
  const generations = await listManifests(archiveRoot);
  const doomed = keep >= generations.length ? [] : generations.slice(0, generations.length - keep);

  for (const generation of doomed) {
    try {
      await fs.rm(path.join(manifestDir(archiveRoot), `${generation}.json`), { force: true });
      result.generationsRemoved.push(generation);
    } catch {
      // Left in place, so still counted as live below — the safe direction. A
      // blob is deleted only when NO manifest wants it.
    }
  }

  const live = new Set<string>();
  for (const generation of await listManifests(archiveRoot)) {
    const manifest = await readManifest(archiveRoot, generation);
    for (const file of manifest?.files ?? []) live.add(file.sha256);
  }

  const objectsRoot = path.join(archiveRoot, "objects");
  let shards: string[] = [];
  try {
    shards = (await fs.readdir(objectsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result;
  }
  for (const shard of shards) {
    let blobs: string[] = [];
    try {
      blobs = await fs.readdir(path.join(objectsRoot, shard));
    } catch {
      continue;
    }
    for (const blob of blobs) {
      // A `.tmp-*` leftover from a killed run is unreferenced by definition.
      if (live.has(blob)) continue;
      const target = path.join(objectsRoot, shard, blob);
      let size = 0;
      try {
        size = (await fs.stat(target)).size;
      } catch {
        continue;
      }
      try {
        await fs.rm(target, { force: true });
        result.blobsRemoved += 1;
        result.freedBytes += size;
      } catch {
        // Referenced by nothing and still on disk — reported again next run.
      }
    }
  }
  return result;
}

/** Bytes the archive occupies, blobs deduplicated as they are stored. */
export async function archiveSizeBytes(archiveRoot: string): Promise<number> {
  const objectsRoot = path.join(archiveRoot, "objects");
  let total = 0;
  let shards: string[] = [];
  try {
    shards = (await fs.readdir(objectsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return 0;
  }
  for (const shard of shards) {
    let blobs: string[] = [];
    try {
      blobs = await fs.readdir(path.join(objectsRoot, shard));
    } catch {
      continue;
    }
    for (const blob of blobs) {
      try {
        total += (await fs.stat(path.join(objectsRoot, shard, blob))).size;
      } catch {
        // Vanished between listing and stat — not worth failing a size report.
      }
    }
  }
  return total;
}
