/**
 * Store inventory without parsing content.
 *
 * `scan` is what the onboarding surface shows the user BEFORE asking for
 * consent — "here is what exists, how deep it goes, and what is evaporating".
 * It must therefore be cheap, read-only, and must not open a single record's
 * content: counts, file timestamps and sizes only. Anything that reads inside
 * a record belongs to `extract`, behind consent.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StorePaths } from "./stores.js";
import { StoreInventory } from "./types.js";

const execFileAsync = promisify(execFile);

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/** Tracks a min/max mtime window as files are visited. */
class Window {
  oldest: Date | null = null;
  newest: Date | null = null;
  see(d: Date) {
    if (!this.oldest || d < this.oldest) this.oldest = d;
    if (!this.newest || d > this.newest) this.newest = d;
  }
}

export async function scanClaudeCode(paths: StorePaths): Promise<StoreInventory> {
  const inv: StoreInventory = {
    store: "claude_code",
    rootPath: paths.claudeProjects,
    present: false,
    counts: {},
    notes: []
  };
  const root = await statOrNull(paths.claudeProjects);
  if (!root) return inv;
  inv.present = true;

  const window = new Window();
  let transcripts = 0;
  let bytes = 0;
  const projects = await fs.readdir(paths.claudeProjects, { withFileTypes: true });
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(paths.claudeProjects, project.name);
    for (const entry of await fs.readdir(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const st = await statOrNull(path.join(dir, entry));
      if (!st) continue;
      transcripts += 1;
      bytes += st.size;
      window.see(st.mtime);
    }
  }
  inv.counts = { projects: projects.length, transcripts, bytes };
  inv.oldest = window.oldest?.toISOString();
  inv.newest = window.newest?.toISOString();

  // The purge is the reason this store scans (and later extracts) first. A
  // missing cleanupPeriodDays means the 30-day default is live, and the
  // oldest-transcript date shows exactly how short the window already is.
  let cleanupPeriodDays: number | null = null;
  try {
    const settings = JSON.parse(await fs.readFile(paths.claudeSettings, "utf8"));
    if (typeof settings.cleanupPeriodDays === "number") {
      cleanupPeriodDays = settings.cleanupPeriodDays;
    }
  } catch {
    // No settings file, or unreadable JSON — same consequence: default purge.
  }
  if (cleanupPeriodDays === null || cleanupPeriodDays <= 30) {
    inv.retentionRisk = `rolling purge active (cleanupPeriodDays: ${
      cleanupPeriodDays ?? "30 by default"
    }) — the oldest transcript is deleted daily`;
  }
  return inv;
}

/**
 * Counts rollout files under one Codex sessions tree (`YYYY/MM/DD/*.jsonl`),
 * walking whatever nesting is actually there rather than assuming the
 * date layout survives the next release. File facts only.
 */
async function countRollouts(
  root: string,
  window: Window
): Promise<{ rollouts: number; bytes: number } | null> {
  if (!(await statOrNull(root))) return null;
  let rollouts = 0;
  let bytes = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const st = await statOrNull(full);
        if (!st) continue;
        rollouts += 1;
        bytes += st.size;
        window.see(st.mtime);
      }
    }
  }
  await walk(root);
  return { rollouts, bytes };
}

export async function scanCodex(paths: StorePaths): Promise<StoreInventory> {
  const inv: StoreInventory = {
    store: "codex",
    rootPath: paths.codexSessions,
    present: false,
    counts: {},
    notes: []
  };
  const window = new Window();
  const live = await countRollouts(paths.codexSessions, window);
  const archived = await countRollouts(paths.codexArchivedSessions, window);
  if (!live && !archived) return inv;
  inv.present = true;
  inv.counts = {
    rollouts: live?.rollouts ?? 0,
    archivedRollouts: archived?.rollouts ?? 0,
    bytes: (live?.bytes ?? 0) + (archived?.bytes ?? 0)
  };
  inv.oldest = window.oldest?.toISOString();
  inv.newest = window.newest?.toISOString();
  // No retentionRisk: no rolling purge has been observed on this store —
  // rollouts months old sit beside this week's. Stated as an observation,
  // not a guarantee; if one appears, this is where the warning goes.
  inv.notes.push("no rolling purge observed on rollouts; archived sessions are counted alongside live ones");
  return inv;
}

export async function scanCursor(paths: StorePaths): Promise<StoreInventory> {
  const inv: StoreInventory = {
    store: "cursor",
    rootPath: paths.cursorStateDb,
    present: false,
    counts: {},
    notes: []
  };
  const st = await statOrNull(paths.cursorStateDb);
  if (!st) return inv;
  inv.present = true;
  inv.counts = { bytes: st.size };
  inv.newest = st.mtime.toISOString();

  // Counting rows needs SQLite, but the scan must not add a native dependency
  // for it — macOS ships /usr/bin/sqlite3, and `immutable=1` keeps a WAL-mode
  // db safe to read while Cursor is running. If the binary or the query
  // fails, the scan degrades to file facts rather than failing the inventory.
  try {
    const uri = `file:${paths.cursorStateDb}?mode=ro&immutable=1`;
    const { stdout } = await execFileAsync("sqlite3", [
      uri,
      "SELECT " +
        "(SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%'), " +
        "(SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'bubbleId:%');"
    ]);
    const [conversations, bubbles] = stdout.trim().split("|").map(Number);
    if (Number.isFinite(conversations)) inv.counts.conversations = conversations;
    if (Number.isFinite(bubbles)) inv.counts.bubbles = bubbles;
  } catch (error) {
    inv.notes.push(
      `row counts unavailable (${error instanceof Error ? error.message.split("\n")[0] : "sqlite3 failed"}); file-level facts only`
    );
  }
  return inv;
}

export async function scanVsCode(paths: StorePaths): Promise<StoreInventory> {
  const inv: StoreInventory = {
    store: "vscode",
    rootPath: paths.vscodeHistory,
    present: false,
    counts: {},
    notes: []
  };
  const root = await statOrNull(paths.vscodeHistory);
  if (root) {
    inv.present = true;
    const window = new Window();
    let fileHistories = 0;
    for (const entry of await fs.readdir(paths.vscodeHistory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      fileHistories += 1;
      const st = await statOrNull(path.join(paths.vscodeHistory, entry.name));
      if (st) window.see(st.mtime);
    }
    inv.counts.fileHistories = fileHistories;
    inv.oldest = window.oldest?.toISOString();
    inv.newest = window.newest?.toISOString();
  }

  // Copilot chat sessions live under a different root; count them into the
  // same inventory since they ship in the same extractor.
  let chatSessions = 0;
  const wsRoot = await statOrNull(paths.vscodeWorkspaceStorage);
  if (wsRoot) {
    inv.present = true;
    for (const ws of await fs.readdir(paths.vscodeWorkspaceStorage, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      const sessions = path.join(paths.vscodeWorkspaceStorage, ws.name, "chatSessions");
      try {
        chatSessions += (await fs.readdir(sessions)).filter((f) => f.endsWith(".json")).length;
      } catch {
        // Most workspaces have no chatSessions dir; absence is the norm.
      }
    }
  }
  inv.counts.chatSessions = chatSessions;
  return inv;
}

export async function scanGit(paths: StorePaths): Promise<StoreInventory> {
  const inv: StoreInventory = {
    store: "git",
    rootPath: paths.devRoot,
    present: false,
    counts: {},
    notes: ["the only fully durable, fully supported source — the spine other stores hang off"]
  };
  const root = await statOrNull(paths.devRoot);
  if (!root) return inv;
  inv.present = true;

  // Two levels deep matches the ~/Dev/<org>/<repo> and ~/Dev/<repo> layouts
  // without walking the world. Deeper nesting is a config concern, not a
  // scan concern.
  let repos = 0;
  const level1 = await fs.readdir(paths.devRoot, { withFileTypes: true });
  for (const entry of level1) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(paths.devRoot, entry.name);
    if (await statOrNull(path.join(dir, ".git"))) {
      repos += 1;
      continue;
    }
    let nested: import("node:fs").Dirent[] = [];
    try {
      nested = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of nested) {
      if (!sub.isDirectory()) continue;
      if (await statOrNull(path.join(dir, sub.name, ".git"))) repos += 1;
    }
  }
  inv.counts.repos = repos;
  return inv;
}

export async function scanAll(paths: StorePaths): Promise<StoreInventory[]> {
  // Report order is evaporation order — the same order extraction runs in.
  return [
    await scanClaudeCode(paths),
    await scanCodex(paths),
    await scanCursor(paths),
    await scanVsCode(paths),
    await scanGit(paths)
  ];
}
