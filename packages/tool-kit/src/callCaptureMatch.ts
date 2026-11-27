import * as fs from "fs";
import * as path from "path";
import {
  CaptureRecord,
  captureDir,
  git,
  hashCaptureLine,
  hashCapturePath,
  hashCaptureRepo,
  isTrivialLine,
  listDayFiles,
  normaliseLine,
  offloadableFolders,
  pathSaltFilePath,
  repoInfo,
  touchesOffloadable
} from "./callCapture";

/**
 * Matches commits on a repository's default branch to the capture records
 * that saw their lines being written, and says, per hunk, whether an agent's
 * call wrote it, something outside the captured calls did, or both.
 *
 * Runs on this machine only, over the local records and the local
 * repositories, under the local path salt. It prints counts. The optional
 * per-hunk file it writes names commits and paths, so it is for the person
 * running it and never leaves the machine either.
 *
 * The rule, in short:
 * - Unit: one `@@` block of `git diff -U0 -M <first parent> <commit>`. Its
 *   lines are its non-trivial added lines (removed lines, for a hunk that only
 *   removes). Generated, lock and vendored files, trivial-only and
 *   formatting-only hunks are excluded before counting.
 * - A line matches a record written in the 14 days before the commit (up to 60
 *   seconds after it) whose written set (deleted set, for a removal-only hunk)
 *   holds the same keyed (path, line) pair, for the new path or the old one.
 *   Exact match on the normalised line only.
 * - The latest matching record decides the line: `call` → agent, `between` →
 *   outside, any record whose HEAD moved by something other than a commit →
 *   opaque, none → unseen.
 * - Hunk verdict: unclassified when opaque + unseen is over 20% of its lines;
 *   otherwise agent-led or hand-led at 80% of the attributed lines, else mixed.
 */

export const MATCH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const MATCH_GRACE_MS = 60 * 1000;
export const UNSEEN_LIMIT = 0.2;
export const LEAD_SHARE = 0.8;

export type HunkVerdict = "agent-led" | "hand-led" | "mixed" | "unclassified";
type Source = "agent" | "outside" | "opaque";

const GENERATED = [
  /\.lock$/, /(^|\/)package-lock\.json$/, /(^|\/)pnpm-lock\.yaml$/,
  /\.g\.dart$/, /\.freezed\.dart$/, /\.mocks\.dart$/, /\.pb\.dart$/, /\.pbenum\.dart$/, /\.pbjson\.dart$/, /\.pbserver\.dart$/,
  /\.min\.js$/, /\.map$/, /(^|\/)project\.pbxproj$/, /(^|\/)GeneratedPluginRegistrant\.[^/]+$/,
  /(^|\/)(Pods|build|dist|node_modules|\.dart_tool)\//
];

export function isGeneratedPath(rel: string): boolean {
  return GENERATED.some((re) => re.test(rel));
}

export type Hunk = { oldPath?: string; newPath?: string; index: number; add: string[]; del: string[] };

/** Splits `git diff -U0 -M` output into hunks, with each file's old and new path. */
export function parseHunks(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let current: Hunk | undefined;
  let index = 0;
  let header = false;
  const strip = (p: string, prefix: string) => {
    let v = p;
    if (v.startsWith("\"")) {
      try { v = JSON.parse(v) as string; } catch { v = v.slice(1, -1); }
    }
    return v === "/dev/null" ? undefined : v.startsWith(prefix) ? v.slice(prefix.length) : v;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      oldPath = undefined;
      newPath = undefined;
      index = 0;
      header = true;
      continue;
    }
    if (header && line.startsWith("--- ")) { oldPath = strip(line.slice(4), "a/"); continue; }
    if (header && line.startsWith("+++ ")) { newPath = strip(line.slice(4), "b/"); continue; }
    if (line.startsWith("@@")) {
      header = false;
      current = { oldPath, newPath, index: index++, add: [], del: [] };
      hunks.push(current);
      continue;
    }
    if (header || !current) continue;
    if (line.startsWith("+")) current.add.push(line.slice(1));
    else if (line.startsWith("-")) current.del.push(line.slice(1));
  }
  return hunks;
}

type Event = { at: number; source: Source };
type Index = { written: Map<string, Event[]>; deleted: Map<string, Event[]> };

export function readRecords(dir: string = captureDir()): CaptureRecord[] {
  const out: CaptureRecord[] = [];
  for (const f of listDayFiles(dir)) {
    let text: string;
    try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line) as CaptureRecord); } catch { /* a torn line */ }
    }
  }
  return out;
}

export function indexRecords(records: CaptureRecord[], common: string): Index {
  const index: Index = { written: new Map(), deleted: new Map() };
  const push = (map: Map<string, Event[]>, key: string, ev: Event) => {
    const list = map.get(key);
    if (list) list.push(ev); else map.set(key, [ev]);
  };
  for (const r of records) {
    if (r.common !== common) continue;
    const at = Date.parse(r.at);
    const source: Source = r.moved === "other" ? "opaque" : r.kind === "call" ? "agent" : "outside";
    for (const f of r.files) {
      for (const lh of f.w ?? []) push(index.written, `${f.p}:${lh}`, { at, source });
      for (const lh of f.x ?? []) push(index.deleted, `${f.p}:${lh}`, { at, source });
    }
  }
  for (const map of [index.written, index.deleted]) for (const list of map.values()) list.sort((a, b) => a.at - b.at);
  return index;
}

function latest(list: Event[] | undefined, from: number, to: number): Event | undefined {
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i];
    if (ev.at > to) continue;
    return ev.at > from ? ev : undefined;
  }
  return undefined;
}

export type HunkResult = { verdict: HunkVerdict; lines: number; agent: number; outside: number; opaque: number; unseen: number };

/** Classifies one hunk against the index. Returns undefined for a hunk excluded before counting. */
export function classifyHunk(hunk: Hunk, commitTimeMs: number, index: Index, salt: string): HunkResult | undefined {
  const rel = hunk.newPath ?? hunk.oldPath;
  if (!rel || isGeneratedPath(rel)) return undefined;
  const add = hunk.add.map(normaliseLine).filter((l) => !isTrivialLine(l));
  const del = hunk.del.map(normaliseLine).filter((l) => !isTrivialLine(l));
  if (!add.length && !del.length) return undefined;
  if (add.length && hunk.add.join("").replace(/\s+/g, "") === hunk.del.join("").replace(/\s+/g, "")) return undefined;
  const lines = add.length ? add : del;
  const map = add.length ? index.written : index.deleted;
  const paths = [hunk.newPath, hunk.oldPath].filter((p): p is string => !!p).map((p) => hashCapturePath(salt, p));
  const from = commitTimeMs - MATCH_WINDOW_MS;
  const to = commitTimeMs + MATCH_GRACE_MS;
  const r: HunkResult = { verdict: "unclassified", lines: lines.length, agent: 0, outside: 0, opaque: 0, unseen: 0 };
  for (const line of lines) {
    const lh = hashCaptureLine(salt, line);
    let best: Event | undefined;
    for (const ph of new Set(paths)) {
      const ev = latest(map.get(`${ph}:${lh}`), from, to);
      if (ev && (!best || ev.at > best.at)) best = ev;
    }
    if (!best) r.unseen++;
    else r[best.source]++;
  }
  const attributed = r.agent + r.outside;
  if ((r.opaque + r.unseen) / r.lines > UNSEEN_LIMIT || attributed === 0) r.verdict = "unclassified";
  else if (r.agent / attributed >= LEAD_SHARE) r.verdict = "agent-led";
  else if (r.outside / attributed >= LEAD_SHARE) r.verdict = "hand-led";
  else r.verdict = "mixed";
  return r;
}

export type RepoReport = {
  name: string;
  skipped?: "offloadable" | "not_a_repo" | "no_records" | "no_branch";
  commits: number;
  hunks: number;
  verdicts: Record<HunkVerdict, number>;
};

export type CaptureReport = {
  since: string;
  until?: string;
  repos: RepoReport[];
  hunks: number;
  verdicts: Record<HunkVerdict, number>;
  /** (agent-led + mixed + hand-led) / hunks; null with no hunks. */
  coverage: number | null;
};

export type ReportOptions = {
  repos: string[];
  since: string;
  until?: string;
  /** Author emails counted besides each repository's own `user.email`. */
  authors?: string[];
  /** Writes one JSON line per classified hunk here: commit, path, index, verdict. Local only. */
  hunksFile?: string;
  records?: CaptureRecord[];
};

const emptyVerdicts = (): Record<HunkVerdict, number> => ({ "agent-led": 0, "hand-led": 0, mixed: 0, unclassified: 0 });

async function defaultBranch(root: string): Promise<string | undefined> {
  const remote = (await git(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  if (remote) return remote;
  for (const b of ["main", "master"]) if ((await git(root, ["rev-parse", "-q", "--verify", `refs/heads/${b}`])) !== null) return b;
  const heads = (await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))?.trim().split("\n").filter(Boolean) ?? [];
  return heads.length === 1 ? heads[0] : undefined;
}

export async function captureReport(opts: ReportOptions): Promise<CaptureReport> {
  const salt = fs.readFileSync(pathSaltFilePath(), "utf8").trim();
  const records = opts.records ?? readRecords();
  const folders = offloadableFolders();
  const total = emptyVerdicts();
  const repos: RepoReport[] = [];
  const out = opts.hunksFile ? fs.openSync(opts.hunksFile, "w", 0o600) : undefined;
  try {
    for (const dir of opts.repos) {
      const report: RepoReport = { name: path.basename(path.resolve(dir)), commits: 0, hunks: 0, verdicts: emptyVerdicts() };
      repos.push(report);
      if (touchesOffloadable(dir, folders)) { report.skipped = "offloadable"; continue; }
      const info = await repoInfo(path.resolve(dir));
      if (!info) { report.skipped = "not_a_repo"; continue; }
      if (touchesOffloadable(info.root, folders)) { report.skipped = "offloadable"; continue; }
      const index = indexRecords(records, hashCaptureRepo(salt, info.common));
      if (!index.written.size && !index.deleted.size) { report.skipped = "no_records"; continue; }
      const branch = await defaultBranch(info.root);
      if (!branch) { report.skipped = "no_branch"; continue; }
      const own = (await git(info.root, ["config", "user.email"]))?.trim().toLowerCase();
      const authors = new Set([own, ...(opts.authors ?? []).map((a) => a.toLowerCase())].filter(Boolean));
      const log = await git(info.root, [
        "log", "--first-parent", "--format=%H%x09%P%x09%ct%x09%ae", `--since=${opts.since}`, ...(opts.until ? [`--until=${opts.until}`] : []), branch
      ]);
      for (const row of (log ?? "").split("\n").filter(Boolean)) {
        const [sha, parents, ct, email] = row.split("\t");
        const parent = parents.split(" ")[0];
        if (!parent || !authors.has(email.toLowerCase())) continue;
        const diff = await git(info.root, ["diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--no-textconv", parent, sha]);
        if (diff === null) continue;
        report.commits++;
        const at = Number(ct) * 1000;
        for (const hunk of parseHunks(diff)) {
          const r = classifyHunk(hunk, at, index, salt);
          if (!r) continue;
          report.hunks++;
          report.verdicts[r.verdict]++;
          total[r.verdict]++;
          if (out !== undefined) fs.writeSync(out, `${JSON.stringify({ repo: report.name, commit: sha, path: hunk.newPath ?? hunk.oldPath, hunkIndex: hunk.index, ...r })}\n`);
        }
      }
    }
  } finally {
    if (out !== undefined) fs.closeSync(out);
  }
  const hunks = Object.values(total).reduce((a, b) => a + b, 0);
  return {
    since: opts.since,
    ...(opts.until ? { until: opts.until } : {}),
    repos,
    hunks,
    verdicts: total,
    coverage: hunks ? (hunks - total.unclassified) / hunks : null
  };
}
