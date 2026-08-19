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

/** Clone-on-write when the filesystem supports it (APFS does): a 2.3 GB
 * store snapshots in milliseconds and costs no disk until the live files
 * diverge. NOT `FICLONE_FORCE` — on filesystems without reflinks this must
 * degrade to a real copy, not an error. */
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
