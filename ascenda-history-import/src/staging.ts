/**
 * Copy-then-parse.
 *
 * Every store is a live file another process is writing: Claude Code appends
 * to the transcript mid-session, Cursor's db is WAL-mode with a hot journal.
 * Parsing in place risks torn reads AND ties extraction time to purge time —
 * a Claude cleanup running mid-extract would delete lines under the parser.
 * So extraction always runs against a snapshot, stamped with an extraction id
 * that every emitted event carries (it is also the natural idempotency key
 * for backend dedup).
 */
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Ask for a reflink, but DO NOT believe you got one.
 *
 * This flag used to carry a comment claiming a snapshot "costs no disk until
 * the live files diverge". Measured on macOS 15 / APFS / Node 24, that is
 * false: `fs.copyFile` with `COPYFILE_FICLONE` costs exactly as much as a
 * plain copy — 450 MB source, 464 MB consumed, byte-identical to omitting the
 * flag. (`/bin/cp -c` on the same file costs 0, so the filesystem supports
 * reflinks fine; Node's copy path simply does not use them here.)
 *
 * That false comment is the whole reason staging quietly grew to 254 GB
 * across 19 runs: every "free" snapshot was a real ~20 GB copy. The flag is
 * kept because it is a genuine win where the runtime honours it (btrfs/XFS on
 * Linux), and NOT `FICLONE_FORCE` so it degrades to a real copy rather than an
 * error. But nothing in this module may assume the copy was free — which is
 * why every snapshot is torn down by the run that made it.
 */
const CLONE = constants.COPYFILE_FICLONE;

export interface StagingArea {
  extractionId: string;
  root: string;
}

/** Default staging root. Local, never synced, never shipped — raw records
 * (including UNPARSED ones) stay here on the machine. */
export function defaultStagingRoot(home: string): string {
  return path.join(home, ".ascenda", "history-import", "staging");
}

export async function createStagingArea(stagingRoot: string): Promise<StagingArea> {
  const extractionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const root = path.join(stagingRoot, extractionId);
  await fs.mkdir(root, { recursive: true });
  return { extractionId, root };
}

/**
 * Snapshot a file or directory into the staging area. For SQLite stores pass
 * the db path — the `-wal` and `-shm` siblings are picked up automatically,
 * because a WAL db copied without its journal silently loses the newest
 * transactions (the most recent sessions: exactly the ones a user would
 * notice missing).
 */
export async function snapshotPath(
  area: StagingArea,
  sourcePath: string,
  label: string
): Promise<string> {
  const dest = path.join(area.root, label);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const st = await fs.stat(sourcePath);
  if (st.isDirectory()) {
    await fs.cp(sourcePath, dest, {
      recursive: true,
      errorOnExist: false,
      force: true,
      mode: CLONE
    });
  } else {
    await fs.copyFile(sourcePath, dest, CLONE);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await fs.copyFile(sourcePath + suffix, dest + suffix, CLONE);
      } catch {
        // No journal sibling — a checkpointed or non-WAL db. Fine.
      }
    }
  }
  return dest;
}

/**
 * Surgical snapshot of `Code/User/workspaceStorage` for the VS Code
 * extractor: only `workspace.json` (workspace identity) and
 * `chatSessions/*.json` and `chatSessions/*.jsonl` (Copilot sessions) per
 * hash directory, never the
 * rest — `state.vscdb`, `state.vscdb.backup`, extension caches and other
 * per-workspace artifacts live alongside those two and can run to gigabytes
 * across dozens of workspaces, none of it needed by this extractor. A plain
 * `snapshotPath` recursive copy would drag all of it into staging for
 * nothing; this walks the hash directories itself and copies only what the
 * extractor reads.
 */
export async function snapshotVsCodeWorkspaceStorage(
  area: StagingArea,
  sourceRoot: string,
  label: string
): Promise<string> {
  const dest = path.join(area.root, label);
  await fs.mkdir(dest, { recursive: true });

  let hashDirs: string[] = [];
  try {
    hashDirs = (await fs.readdir(sourceRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return dest; // No workspaceStorage on this machine — an empty snapshot, not an error.
  }

  for (const hash of hashDirs) {
    const destHashDir = path.join(dest, hash);

    const workspaceJson = path.join(sourceRoot, hash, "workspace.json");
    try {
      await fs.mkdir(destHashDir, { recursive: true });
      await fs.copyFile(workspaceJson, path.join(destHashDir, "workspace.json"), CLONE);
    } catch {
      // No workspace.json for this hash — common, and chatSessions below may
      // still exist and be worth copying.
    }

    const chatSessionsDir = path.join(sourceRoot, hash, "chatSessions");
    let sessionFiles: string[] = [];
    try {
      // Both on-disk shapes: `.json` (pre-Feb-2026) and `.jsonl` (the delta-log
      // format VS Code migrated to). Filtering to `.json` here is what kept
      // seven months of sessions out of staging entirely — the extractor never
      // saw them, so it could not even report them as unread.
      sessionFiles = (await fs.readdir(chatSessionsDir)).filter(
        (f) => f.endsWith(".json") || f.endsWith(".jsonl")
      );
    } catch {
      continue; // Most workspaces have no chatSessions dir — the norm.
    }
    if (sessionFiles.length === 0) continue;
    const destSessionsDir = path.join(destHashDir, "chatSessions");
    await fs.mkdir(destSessionsDir, { recursive: true });
    for (const file of sessionFiles) {
      await fs.copyFile(path.join(chatSessionsDir, file), path.join(destSessionsDir, file), CLONE);
    }
  }

  return dest;
}


/* ------------------------------------------------------------------------ *
 * Teardown
 *
 * A snapshot is scaffolding: worth exactly as much as the extraction running
 * against it, and worth nothing once that extraction has finished. The
 * extracted `events.jsonl` is the part with lasting value (~10 MB against
 * ~20 GB of sources), so teardown keeps that and removes the rest.
 *
 * Teardown belongs to the RUN, not to a separate `fix-retention`-style
 * command: a run that cleans up after itself cannot be forgotten, and the
 * failure mode being fixed here is precisely that nobody remembered. The
 * sweep below exists only to drain the backlog left by runs that shipped
 * before teardown did.
 * ------------------------------------------------------------------------ */

/** Kept when a staging run is disposed of — the extraction output, not its inputs. */
export const STAGING_KEEP = ["events.jsonl"];

export interface DisposeResult {
  /** Bytes of snapshot removed, as reported by the directory walk. */
  freedBytes: number;
  /** Entries kept (see `STAGING_KEEP`). */
  kept: string[];
}

async function entrySizeBytes(target: string): Promise<number> {
  let st;
  try {
    st = await fs.lstat(target);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(target);
  } catch {
    return total;
  }
  for (const entry of entries) {
    total += await entrySizeBytes(path.join(target, entry));
  }
  return total;
}

/**
 * Remove a run's snapshot payload, keeping `STAGING_KEEP`.
 *
 * Deliberately tolerant: teardown runs in a `finally`, so it must never be
 * able to turn a successful run into a failed one, nor mask the real error
 * from a failed one. A removal that fails is reported through the returned
 * byte count (it simply frees less), never thrown.
 */
export async function disposeStagingArea(
  area: StagingArea,
  keep: readonly string[] = STAGING_KEEP
): Promise<DisposeResult> {
  const result: DisposeResult = { freedBytes: 0, kept: [] };
  let entries: string[] = [];
  try {
    entries = await fs.readdir(area.root);
  } catch {
    return result; // Never created, or already gone.
  }
  for (const entry of entries) {
    if (keep.includes(entry)) {
      result.kept.push(entry);
      continue;
    }
    const target = path.join(area.root, entry);
    const size = await entrySizeBytes(target);
    try {
      await fs.rm(target, { recursive: true, force: true });
      result.freedBytes += size;
    } catch {
      // Left behind — the next run's sweep will try again.
    }
  }
  return result;
}

export interface SweepResult {
  runsSwept: number;
  freedBytes: number;
}

/**
 * Drain snapshot payloads left by earlier runs.
 *
 * `exceptRun` is the run currently executing — never swept, because its
 * snapshot is live. Everything else keeps only `STAGING_KEEP`, so historical
 * `events.jsonl` files survive a sweep: they are extraction output someone may
 * still want to inspect, and they are ~10 MB, not ~20 GB.
 */
export async function sweepStagingRoot(
  stagingRoot: string,
  exceptRun?: string,
  keep: readonly string[] = STAGING_KEEP
): Promise<SweepResult> {
  const result: SweepResult = { runsSwept: 0, freedBytes: 0 };
  let runs: string[] = [];
  try {
    runs = (await fs.readdir(stagingRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result; // No staging root yet — nothing to sweep.
  }
  for (const run of runs) {
    if (run === exceptRun) continue;
    const disposed = await disposeStagingArea({ extractionId: run, root: path.join(stagingRoot, run) }, keep);
    if (disposed.freedBytes > 0) {
      result.runsSwept += 1;
      result.freedBytes += disposed.freedBytes;
    }
  }
  return result;
}

/* ------------------------------------------------------------------------ *
 * Pre-flight space
 * ------------------------------------------------------------------------ */

/** Free bytes on the volume holding `dir` (walking up to the nearest existing
 * ancestor, since the staging root may not exist yet). */
export async function freeSpaceBytes(dir: string): Promise<number | null> {
  let probe = path.resolve(dir);
  for (;;) {
    try {
      const st = await fs.statfs(probe);
      return Number(st.bsize) * Number(st.bavail);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

/** What this run is about to copy, measured rather than guessed. */
export async function estimateSnapshotBytes(sources: readonly string[]): Promise<number> {
  let total = 0;
  for (const source of sources) total += await entrySizeBytes(source);
  return total;
}

export interface SpaceCheck {
  requiredBytes: number;
  freeBytes: number | null;
  /** False only when free space is known AND insufficient — an unknown free
   * figure must not block a run that would have worked. */
  sufficient: boolean;
}

/**
 * Headroom on top of the measured source size. The copy is the dominant cost,
 * but the extractor also writes `events.jsonl` and reads whole session files
 * into memory; refusing with a little room to spare beats an ENOSPC halfway
 * through a 20 GB copy.
 */
export const SPACE_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024;

export async function checkSpaceForSnapshot(
  stagingRoot: string,
  sources: readonly string[]
): Promise<SpaceCheck> {
  const requiredBytes = (await estimateSnapshotBytes(sources)) + SPACE_HEADROOM_BYTES;
  const freeBytes = await freeSpaceBytes(stagingRoot);
  return {
    requiredBytes,
    freeBytes,
    sufficient: freeBytes === null || freeBytes >= requiredBytes
  };
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
