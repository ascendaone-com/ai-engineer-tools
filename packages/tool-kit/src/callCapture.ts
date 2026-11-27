import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ascendaHome } from "./tokenStore";

/**
 * Per-call file capture: which lines of which files changed in the working
 * tree across each agent tool call, whatever wrote them.
 *
 * Why it exists. Reading an agent's edit-tool log after the fact cannot say
 * who wrote a committed line, because agents mostly write through the shell
 * (`sed -i`, heredocs, `git apply`, formatters). On one real machine, over
 * three months, coding sessions ran 172,773 shell commands against 10,134
 * edit-tool calls, and two thirds of the unclassifiable committed hunks had no
 * edit-tool call on their file at all. Watching the working tree around every
 * call sees every channel.
 *
 * How. A *snapshot* of a repository is the multiset of (path, line) pairs the
 * working tree adds relative to `HEAD`, and the multiset it removes, from
 * `git diff HEAD -U0` plus untracked, non-ignored files. A *record* is the
 * difference between two consecutive snapshots of one repository:
 *
 * - `call`: across one agent call, its PreToolUse to its PostToolUse.
 * - `between`: since the last snapshot, taken at the next PreToolUse, so
 *   whatever changed while no captured call was running.
 *
 * What is stored. Nothing in clear. Paths, lines and repository roots are
 * stored only as keyed hashes under a machine-local salt of their own
 * (`capture/path-salt`), separate from the salt that keys workspace and
 * project hashes, never sent. No file content, no hunk text, no line numbers,
 * no commit SHA, no branch name.
 *
 * What leaves. Nothing. No value from this module is ever put on an outbound
 * payload; the hook tests fail if one appears. The capture is local-only and
 * **off by default**: it runs only after `capture on`, and `capture off`
 * deletes every record, every baseline and the salt.
 *
 * Invariants a change must keep:
 * - `git` runs with `GIT_OPTIONAL_LOCKS=0` and never with an external diff or
 *   textconv, so a snapshot never takes the index lock an agent's own
 *   `git commit` needs, and never runs a user's diff driver.
 * - A repository under a folder whose files can be offloaded to the cloud
 *   (iCloud Drive, a File Provider, synced Desktop & Documents), or that
 *   contains one, is never read: reading a placeholder downloads it.
 * - Nothing here throws into the hook. A capture that could fail a user's turn
 *   would be a worse bug than the attribution gap it closes.
 */

/** `on` forces capture on, `off` forces it off; unset defers to the switch file. */
export const CALL_CAPTURE_ENV_VAR = "ASCENDA_CALL_CAPTURE";

/** Tools that cannot write a file. A call to one is not snapshotted. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch"
]);

/** A PreToolUse within this long of the repository's last snapshot is skipped. */
export const PRE_SKIP_WINDOW_MS = 3_000;
/** Untracked files read per snapshot, and the largest one read. */
export const MAX_UNTRACKED_FILES = 300;
export const MAX_UNTRACKED_BYTES = 256 * 1024;
/** Above this many non-trivial changed lines a snapshot keeps no line hashes. */
export const MAX_SNAPSHOT_LINES = 20_000;
/** Line hashes written per record before it is marked truncated. */
export const MAX_RECORD_LINES = 5_000;
/** Day files older than this are pruned, then the oldest go while the directory is over the size cap. */
export const CAPTURE_MAX_AGE_DAYS = 120;
export const CAPTURE_MAX_BYTES = 256 * 1024 * 1024;
/** A baseline not touched for this long belongs to a repository no longer worked in. */
const BASELINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 2_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type CaptureHook = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";

/** One file's change in a record: path hash, written line hashes, deleted line hashes. */
export type CaptureFileDelta = { p: string; w?: string[]; x?: string[] };

export type CaptureRecord = {
  v: 1;
  at: string;
  kind: "call" | "between";
  agent: string;
  /** Keyed hash of the working-tree root, and of the common git directory (a worktree joins its main repository). */
  repo: string;
  common: string;
  tool?: string;
  session?: string;
  callId?: string;
  moved?: "commit" | "other";
  truncated?: true;
  /** Wall time this hook spent on the repository, in milliseconds. */
  ms: number;
  files: CaptureFileDelta[];
};

type Multiset = Record<string, number>;
type FileSets = { a: Multiset; d: Multiset; s?: string };
type Baseline = { at: number; head: string | null; truncated?: boolean; files: Record<string, FileSets> };

// ── switch and storage ──────────────────────────────────────────────────────

export function captureDir(): string {
  return path.join(ascendaHome(), "capture");
}

function switchFilePath(): string {
  return path.join(captureDir(), "enabled");
}

export function pathSaltFilePath(): string {
  return path.join(captureDir(), "path-salt");
}

export function captureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CALL_CAPTURE_ENV_VAR]?.trim().toLowerCase();
  if (value === "off" || value === "0" || value === "false" || value === "no") return false;
  if (value === "on" || value === "1" || value === "true" || value === "yes") return true;
  try {
    return fs.existsSync(switchFilePath());
  } catch {
    return false;
  }
}

/**
 * Turns the capture on (writes the switch) or off (deletes the whole capture
 * directory: records, baselines, state and the path salt, so no join survives).
 */
export function setCaptureEnabled(on: boolean, now: Date = new Date()): void {
  const dir = captureDir();
  if (on) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(switchFilePath(), `${now.toISOString()}\n`, { mode: 0o600 });
    readOrCreatePathSalt();
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export type CaptureStatus = {
  enabled: boolean;
  forcedBy?: "env";
  enabledSince?: string;
  dayFiles: number;
  bytes: number;
  firstDay?: string;
  lastDay?: string;
  records: number;
  pruned: number;
};

export function captureStatus(env: NodeJS.ProcessEnv = process.env): CaptureStatus {
  const dir = captureDir();
  const days = listDayFiles(dir);
  let bytes = 0;
  let records = 0;
  for (const f of days) {
    try {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      bytes += Buffer.byteLength(text);
      for (const line of text.split("\n")) if (line) records++;
    } catch {
      // A file pruned while we read it.
    }
  }
  let enabledSince: string | undefined;
  try {
    enabledSince = fs.readFileSync(switchFilePath(), "utf8").trim() || undefined;
  } catch {
    enabledSince = undefined;
  }
  const raw = env[CALL_CAPTURE_ENV_VAR]?.trim();
  return {
    enabled: captureEnabled(env),
    ...(raw ? { forcedBy: "env" as const } : {}),
    ...(enabledSince ? { enabledSince } : {}),
    dayFiles: days.length,
    bytes,
    ...(days.length ? { firstDay: dayOf(days[0]), lastDay: dayOf(days[days.length - 1]) } : {}),
    records,
    pruned: readState().pruned ?? 0
  };
}

export function readOrCreatePathSalt(saltFilePath: string = pathSaltFilePath()): string {
  fs.mkdirSync(path.dirname(saltFilePath), { recursive: true, mode: 0o700 });
  try {
    // `wx`, as the machine salt: a Pre and a Post hook can race on first run,
    // and two salts would split one repository's records in two.
    const salt = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(saltFilePath, salt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return salt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return fs.readFileSync(saltFilePath, "utf8").trim();
  }
}

function keyed(salt: string, domain: string, value: string): string {
  return crypto.createHmac("sha256", salt).update(domain).update("\0").update(value).digest("hex").slice(0, 16);
}

/** The keyed hash of a repository-relative path. Exported for the matcher; takes no other input. */
export function hashCapturePath(salt: string, relPath: string): string {
  return keyed(salt, "path", relPath.split(path.sep).join("/"));
}

/** The keyed hash of one already-normalised line. */
export function hashCaptureLine(salt: string, normalisedLine: string): string {
  return keyed(salt, "line", normalisedLine);
}

export function hashCaptureRepo(salt: string, absoluteDir: string): string {
  return keyed(salt, "repo", path.resolve(absoluteDir));
}

/** Trimmed, each run of whitespace collapsed to one space. */
export function normaliseLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/** Empty, or only whitespace, brackets, punctuation and symbols. */
export function isTrivialLine(line: string): boolean {
  return /^[\s\p{P}\p{S}]*$/u.test(line);
}

// ── offloadable folders ──────────────────────────────────────────────────────

/**
 * Folders whose files macOS may replace with cloud placeholders. A dataless
 * file can only exist inside a File Provider domain, so this list finds every
 * repository a `find -flags +dataless` walk would, without walking the tree on
 * every call.
 */
export function offloadableFolders(home: string = os.homedir()): string[] {
  const folders = [path.join(home, "Library", "Mobile Documents"), path.join(home, "Library", "CloudStorage")];
  const cloudDocs = path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
  for (const name of ["Documents", "Desktop"]) {
    try {
      if (fs.existsSync(path.join(cloudDocs, name))) folders.push(path.join(home, name));
    } catch {
      // Treat an unreadable probe as not synced; the Library folders still apply.
    }
  }
  return folders;
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * True when no git repository sits at or above any offloadable folder, so no
 * repository's root can contain one. Also false when git is pointed elsewhere
 * by the environment, where the root is not where the folders say.
 */
export function parallelIsSafe(folders: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.GIT_DIR || env.GIT_WORK_TREE) return false;
  for (const folder of folders) {
    let dir = path.resolve(folder);
    for (;;) {
      try {
        if (fs.existsSync(path.join(dir, ".git"))) return false;
      } catch {
        return false;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return true;
}

/** True when `dir` lies under an offloadable folder, or contains one (so git would walk into it). */
export function touchesOffloadable(dir: string, folders: string[] = offloadableFolders()): boolean {
  const resolved = path.resolve(dir);
  return folders.some((f) => within(resolved, f) || within(f, resolved));
}

// ── git ──────────────────────────────────────────────────────────────────────

export function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["-c", "core.quotepath=off", ...args],
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
          windowsHide: true
        },
        (error, stdout) => resolve(error ? null : stdout)
      );
    } catch {
      resolve(null);
    }
  });
}

export type RepoInfo = { root: string; common: string; head: string | null };

export async function repoInfo(cwd: string): Promise<RepoInfo | null> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir", "--verify", "-q", "HEAD"]);
  if (out !== null) {
    const [root, common, head] = out.split("\n");
    if (root && common) return { root, common: path.resolve(cwd, common), head: head || null };
  }
  // A repository with no commit yet: HEAD does not resolve, so ask again without it.
  const bare = await git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  if (bare === null) return null;
  const [root, common] = bare.split("\n");
  if (!root || !common) return null;
  return { root, common: path.resolve(cwd, common), head: null };
}

function unquote(p: string): string {
  if (!p.startsWith("\"")) return p;
  try {
    return JSON.parse(p) as string;
  } catch {
    return p.slice(1, -1);
  }
}

/** Parses `git diff -U0` into added and removed lines per repository-relative path. */
export function parseUnifiedDiff(text: string): Map<string, { add: string[]; del: string[] }> {
  const files = new Map<string, { add: string[]; del: string[] }>();
  let current: { add: string[]; del: string[] } | undefined;
  let oldPath: string | undefined;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      oldPath = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("--- ")) {
        const p = unquote(line.slice(4));
        oldPath = p === "/dev/null" ? undefined : p.replace(/^a\//, "");
        continue;
      }
      if (line.startsWith("+++ ")) {
        const p = unquote(line.slice(4));
        const rel = p === "/dev/null" ? oldPath : p.replace(/^b\//, "");
        if (rel) {
          current = files.get(rel) ?? { add: [], del: [] };
          files.set(rel, current);
        }
        continue;
      }
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) continue;
    if (line.startsWith("+")) current.add.push(line.slice(1));
    else if (line.startsWith("-")) current.del.push(line.slice(1));
  }
  return files;
}

type RawSnapshot = { files: Map<string, { add: string[]; del: string[] }>; ok: boolean };

/** `--no-relative`: run from a subfolder, a `diff.relative` setting would otherwise drop the rest of the tree. */
async function diffAgainst(cwd: string, base: string | null): Promise<RawSnapshot> {
  const out = await git(cwd, ["diff", base ?? EMPTY_TREE, "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--"]);
  if (out === null) return { files: new Map(), ok: false };
  return { files: parseUnifiedDiff(out), ok: true };
}

type UntrackedFile = { rel: string; full: string; size: number; mtimeMs: number };

function listUntracked(cwd: string): Promise<string | null> {
  return git(cwd, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"]);
}

function untrackedFiles(root: string, out: string | null): { files: UntrackedFile[]; truncated: boolean } | null {
  if (out === null) return null;
  const names = out.split("\0").filter(Boolean);
  const files: UntrackedFile[] = [];
  for (const rel of names.slice(0, MAX_UNTRACKED_FILES)) {
    try {
      const full = path.join(root, rel);
      const st = fs.lstatSync(full);
      // Regular files only: a symlink can point anywhere, including into a
      // folder whose files are cloud placeholders.
      if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) continue;
      files.push({ rel, full, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // Deleted between the listing and the stat.
    }
  }
  return { files, truncated: names.length > MAX_UNTRACKED_FILES };
}

/**
 * Hashes a snapshot. Each file carries a keyed signature (`s`) of what it was
 * hashed from: its diff section, or an untracked file's size and mtime. A file
 * whose signature matches the previous baseline reuses that baseline's sets,
 * so an untracked file is not even re-read. Measured on a 3,073-file
 * repository with 15,000 untracked lines, hashing every line on every call
 * cost more than all the git commands together.
 */
function hashSets(
  salt: string,
  tracked: Map<string, { add: string[]; del: string[] }>,
  untracked: UntrackedFile[],
  prev: Record<string, FileSets> | undefined
): { files: Record<string, FileSets>; lines: number } {
  const files: Record<string, FileSets> = {};
  let lines = 0;
  const count = (sets: FileSets) => {
    for (const n of Object.values(sets.a)) lines += n;
    for (const n of Object.values(sets.d)) lines += n;
  };
  const hashInto = (sets: FileSets, raw: string[], key: "a" | "d") => {
    for (const r of raw) {
      const n = normaliseLine(r);
      if (isTrivialLine(n)) continue;
      const lh = hashCaptureLine(salt, n);
      sets[key][lh] = (sets[key][lh] ?? 0) + 1;
    }
  };
  const place = (ph: string, sets: FileSets) => {
    if (!Object.keys(sets.a).length && !Object.keys(sets.d).length) return;
    files[ph] = sets;
    count(sets);
  };
  for (const [rel, f] of tracked) {
    const ph = hashCapturePath(salt, rel);
    const sig = keyed(salt, "sig", `t\0${f.add.join("\n")}\0${f.del.join("\n")}`);
    const before = prev?.[ph];
    if (before && before.s === sig) { place(ph, before); continue; }
    const sets: FileSets = { a: {}, d: {}, s: sig };
    hashInto(sets, f.add, "a");
    hashInto(sets, f.del, "d");
    place(ph, sets);
  }
  for (const u of untracked) {
    const ph = hashCapturePath(salt, u.rel);
    const sig = keyed(salt, "sig", `u\0${u.size}\0${u.mtimeMs}`);
    const before = prev?.[ph];
    if (before && before.s === sig) { place(ph, before); continue; }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(u.full);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue;
    const sets: FileSets = { a: {}, d: {}, s: sig };
    hashInto(sets, buf.toString("utf8").split("\n"), "a");
    place(ph, sets);
  }
  return { files, lines };
}

/** What `next` has that `prev` does not, per file, with multiplicity. */
export function diffSnapshots(prev: Record<string, FileSets>, next: Record<string, FileSets>): { files: CaptureFileDelta[]; lines: number } {
  const out: CaptureFileDelta[] = [];
  let lines = 0;
  for (const [p, sets] of Object.entries(next)) {
    const before = prev[p];
    if (before === sets) continue; // reused from the baseline unchanged
    const pick = (key: "a" | "d"): string[] => {
      const result: string[] = [];
      for (const [lh, n] of Object.entries(sets[key])) {
        const extra = n - (before?.[key][lh] ?? 0);
        for (let i = 0; i < extra; i++) result.push(lh);
      }
      return result;
    };
    const w = pick("a");
    const x = pick("d");
    if (!w.length && !x.length) continue;
    lines += w.length + x.length;
    out.push({ p, ...(w.length ? { w } : {}), ...(x.length ? { x } : {}) });
  }
  return { files: out, lines };
}

// ── baselines, records, pruning ───────────────────────────────────────────────

function baselinePath(repoHash: string): string {
  return path.join(captureDir(), "baselines", `${repoHash}.json`);
}

function readBaseline(repoHash: string): Baseline | undefined {
  try {
    return JSON.parse(fs.readFileSync(baselinePath(repoHash), "utf8")) as Baseline;
  } catch {
    return undefined;
  }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function writeBaseline(repoHash: string, baseline: Baseline): void {
  writeAtomic(baselinePath(repoHash), JSON.stringify(baseline));
}

type RecentIndex = Record<string, { repo: string; at: number }>;

function recentPath(): string {
  return path.join(captureDir(), "recent.json");
}

function readRecent(): RecentIndex {
  try {
    return JSON.parse(fs.readFileSync(recentPath(), "utf8")) as RecentIndex;
  } catch {
    return {};
  }
}

function dayOf(file: string): string {
  return file.slice("calls-".length, "calls-".length + 10);
}

export function listDayFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => /^calls-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
}

export function dayFilePath(now: Date): string {
  return path.join(captureDir(), `calls-${now.toISOString().slice(0, 10)}.jsonl`);
}

function appendRecord(record: CaptureRecord, now: Date): void {
  const file = dayFilePath(now);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // One write with O_APPEND, as the outbox: Pre and Post hooks are separate
  // processes. A record can exceed PIPE_BUF, but regular-file appends on the
  // platforms we ship to are atomic per write() in practice.
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

type CaptureState = { lastPruneAt?: number; pruned?: number; lastPrunedDay?: string };

function statePath(): string {
  return path.join(captureDir(), "state.json");
}

function readState(): CaptureState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8")) as CaptureState;
  } catch {
    return {};
  }
}

/**
 * Deletes day files past the age bound, then the oldest while over the size
 * bound, and baselines not touched for 30 days. Capture files only: nothing
 * outside the capture directory is ever touched. Every deletion is counted.
 */
export function pruneCapture(now: Date = new Date(), force = false): number {
  const dir = captureDir();
  const state = readState();
  if (!force && state.lastPruneAt && now.getTime() - state.lastPruneAt < PRUNE_INTERVAL_MS) return 0;
  const cutoff = new Date(now.getTime() - CAPTURE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let removed = 0;
  let lastDay: string | undefined;
  const days = listDayFiles(dir);
  const sizes = days.map((f) => {
    try {
      return fs.statSync(path.join(dir, f)).size;
    } catch {
      return 0;
    }
  });
  let total = sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < days.length; i++) {
    const overAge = dayOf(days[i]) < cutoff;
    const overSize = total > CAPTURE_MAX_BYTES && i < days.length - 1;
    if (!overAge && !overSize) break;
    try {
      fs.rmSync(path.join(dir, days[i]), { force: true });
      removed++;
      lastDay = dayOf(days[i]);
      total -= sizes[i];
    } catch {
      // Left for the next prune.
    }
  }
  try {
    const bdir = path.join(dir, "baselines");
    for (const f of fs.readdirSync(bdir)) {
      const full = path.join(bdir, f);
      if (now.getTime() - fs.statSync(full).mtimeMs > BASELINE_MAX_AGE_MS) fs.rmSync(full, { force: true });
    }
  } catch {
    // No baselines yet.
  }
  try {
    writeAtomic(statePath(), JSON.stringify({
      ...state,
      lastPruneAt: now.getTime(),
      pruned: (state.pruned ?? 0) + removed,
      ...(lastDay ? { lastPrunedDay: lastDay } : {})
    }));
  } catch {
    // The capture still works without its state file.
  }
  return removed;
}

// ── the hook entry point ────────────────────────────────────────────────────

export type CaptureInput = {
  hook: string;
  agent: string;
  cwd?: string;
  toolName?: string;
  /** For edit-shaped tools, the file the call names. */
  filePath?: string;
  session?: string;
  callId?: string;
};

export type CaptureOutcome = {
  /** What happened, for tests and the doctor. Never shown to a user mid-turn. */
  result: "disabled" | "not_a_tool_hook" | "read_only_tool" | "no_cwd" | "skipped_recent" | "offloadable" | "not_a_repo" | "git_failed" | "captured";
  records: number;
  ms: number;
};

/**
 * How HEAD moved between two snapshots. `commit` only when the new HEAD is one
 * commit, with one parent, sitting on the old HEAD (or replacing it, as an
 * amend does), and was committed since the earlier snapshot. The last part is
 * what tells a commit made in the window from a fast-forward onto one that
 * already existed (a pull, a reset), which has the same shape.
 */
async function movedKind(root: string, oldHead: string | null, newHead: string | null, sinceMs: number): Promise<"commit" | "other" | undefined> {
  if (oldHead === newHead) return undefined;
  if (!oldHead || !newHead) return "other";
  const [meta, oldParent] = await Promise.all([
    git(root, ["log", "-1", "--format=%P%x09%ct", newHead]),
    git(root, ["rev-parse", "-q", "--verify", `${oldHead}^`])
  ]);
  const [parentList = "", ct = "0"] = (meta ?? "").trim().split("\t");
  const list = parentList.split(/\s+/).filter(Boolean);
  const op = oldParent?.trim() || undefined;
  const onTop = list.length === 1 && (list[0] === oldHead || (op !== undefined && list[0] === op));
  // Commit times have one-second resolution: allow the second the snapshot fell in.
  const fresh = Number(ct) * 1000 >= Math.floor(sinceMs / 1000) * 1000 - 1000;
  return onTop && fresh ? "commit" : "other";
}

async function captureRepo(dir: string, input: CaptureInput, kind: "call" | "between", salt: string, now: Date, folders: string[]): Promise<{ result: CaptureOutcome["result"]; root?: string; recorded: boolean }> {
  const started = Date.now();
  if (touchesOffloadable(dir, folders)) return { result: "offloadable", recorded: false };
  let info: RepoInfo | null;
  let tracked: RawSnapshot;
  let listing: string | null;
  if (parallelIsSafe(folders)) {
    // No repository can contain an offloadable folder, and `dir` is not in
    // one, so the repository root cannot touch one either: the three git
    // commands may run at once. Saves one git start-up per hook.
    [info, tracked, listing] = await Promise.all([repoInfo(dir), diffAgainst(dir, "HEAD"), listUntracked(dir)]);
    if (!info) return { result: "not_a_repo", recorded: false };
    if (!info.head) tracked = await diffAgainst(info.root, null);
  } else {
    info = await repoInfo(dir);
    if (!info) return { result: "not_a_repo", recorded: false };
    if (touchesOffloadable(info.root, folders)) return { result: "offloadable", root: info.root, recorded: false };
    [tracked, listing] = await Promise.all([diffAgainst(info.root, info.head), listUntracked(info.root)]);
  }
  const untracked = untrackedFiles(info.root, listing);
  if (!tracked.ok || !untracked) return { result: "git_failed", root: info.root, recorded: false };

  const repo = hashCaptureRepo(salt, info.root);
  const common = hashCaptureRepo(salt, info.common);
  const prev = readBaseline(repo);

  const current = hashSets(salt, tracked.files, untracked.files, prev && !prev.truncated ? prev.files : undefined);
  const tooBig = current.lines > MAX_SNAPSHOT_LINES;
  const baseline: Baseline = { at: now.getTime(), head: info.head, ...(tooBig ? { truncated: true } : {}), files: tooBig ? {} : current.files };

  let recorded = false;
  if (prev) {
    const moved = await movedKind(info.root, prev.head, info.head, prev.at);
    let against = current.files;
    if (moved === "commit" && !tooBig) {
      // Lines a call wrote and committed inside the same call are only
      // visible against the old HEAD.
      const before = await diffAgainst(info.root, prev.head);
      if (before.ok) against = hashSets(salt, before.files, untracked.files, prev.files).files;
    }
    const truncatedSnapshot = tooBig || prev.truncated === true || untracked.truncated;
    const delta = tooBig || prev.truncated ? { files: [], lines: 0 } : diffSnapshots(prev.files, against);
    let files = delta.files;
    let truncated = truncatedSnapshot;
    if (delta.lines > MAX_RECORD_LINES) {
      truncated = true;
      let budget = MAX_RECORD_LINES;
      files = [];
      for (const f of delta.files) {
        if (budget <= 0) break;
        const w = (f.w ?? []).slice(0, budget);
        budget -= w.length;
        const x = (f.x ?? []).slice(0, Math.max(0, budget));
        budget -= x.length;
        files.push({ p: f.p, ...(w.length ? { w } : {}), ...(x.length ? { x } : {}) });
      }
    }
    if (files.length || moved || truncated) {
      const record: CaptureRecord = {
        v: 1,
        at: now.toISOString(),
        kind,
        agent: input.agent,
        repo,
        common,
        ...(kind === "call" && input.toolName ? { tool: input.toolName } : {}),
        ...(input.session ? { session: input.session } : {}),
        ...(kind === "call" && input.callId ? { callId: input.callId } : {}),
        ...(moved ? { moved } : {}),
        ...(truncated ? { truncated: true as const } : {}),
        ms: Date.now() - started,
        files
      };
      appendRecord(record, now);
      recorded = true;
    }
  }
  writeBaseline(repo, baseline);
  return { result: "captured", root: info.root, recorded };
}

/**
 * Runs the capture for one hook invocation. Resolves; never rejects.
 */
export async function runCallCapture(input: CaptureInput, opts: { now?: Date; env?: NodeJS.ProcessEnv; home?: string } = {}): Promise<CaptureOutcome> {
  const started = Date.now();
  const done = (result: CaptureOutcome["result"], records = 0): CaptureOutcome => ({ result, records, ms: Date.now() - started });
  try {
    if (!captureEnabled(opts.env)) return done("disabled");
    const hook = input.hook;
    if (hook !== "PreToolUse" && hook !== "PostToolUse" && hook !== "PostToolUseFailure") return done("not_a_tool_hook");
    if (input.toolName && READ_ONLY_TOOLS.has(input.toolName)) return done("read_only_tool");
    if (!input.cwd || !path.isAbsolute(input.cwd)) return done("no_cwd");
    const now = opts.now ?? new Date();
    const kind = hook === "PreToolUse" ? "between" : "call";
    const salt = readOrCreatePathSalt();
    const cwdKey = keyed(salt, "cwd", path.resolve(input.cwd));
    const recent = readRecent();

    if (kind === "between") {
      const last = recent[cwdKey];
      if (last && now.getTime() - last.at >= 0 && now.getTime() - last.at < PRE_SKIP_WINDOW_MS) return done("skipped_recent");
    }

    const folders = offloadableFolders(opts.home);
    const first = await captureRepo(input.cwd, input, kind, salt, now, folders);
    let records = first.recorded ? 1 : 0;
    if (first.root) {
      recent[cwdKey] = { repo: hashCaptureRepo(salt, first.root), at: now.getTime() };
      try {
        writeAtomic(recentPath(), JSON.stringify(recent));
      } catch {
        // Only costs the skip.
      }
    }
    if (input.filePath) {
      const target = path.resolve(input.cwd, input.filePath);
      if (!first.root || !within(target, first.root)) {
        // A Write can name a file in a folder it is about to create: start
        // from the nearest folder that exists.
        let dir = path.dirname(target);
        while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
        const second = await captureRepo(dir, input, kind, salt, now, folders);
        if (second.recorded) records++;
      }
    }
    pruneCapture(now);
    return done(first.result, records);
  } catch {
    return done("git_failed");
  }
}
