/**
 * Git extractor: commit cadence and size for the repositories a person's
 * agent sessions ran in.
 *
 * Off by default (`import --git`). The backend's consent store list has to
 * name `git` before these rows are accepted, so nothing here runs unless the
 * person asks for it.
 *
 * Which repositories: only the ones the other stores already named, handed
 * in as `repoRefs` (the cwd or project path on each extracted event). Nothing
 * walks a disk looking for `.git`. A ref that is a subdirectory, a linked
 * worktree or a path that no longer exists resolves to its repository root or
 * is skipped and counted.
 *
 * Which commits: the ones whose author email equals `git config user.email`
 * in that repository. Other people's commits are never emitted. A repository
 * with no configured email emits nothing and is counted.
 *
 * What an event carries: the commit time, the repository key and branch hash
 * the live hooks use (`deriveWorkContext`, `forgeRepoKey`,
 * `deriveBranchHash`), a files-changed count, lines-added and lines-removed
 * buckets, and whether it was a merge commit. No message, no path, no diff,
 * no name or email, and no commit id: the session id on each event is a hash
 * of the id, so a re-import keys the same commit the same way.
 *
 * The event type is `editor_activity`, which already exists, with
 * `activity: "git_commit"` and `gitAction: "commit"`. The backend reads
 * `gitAction` off any event, so no new type is needed.
 *
 * Branch: git doesn't record which branch a commit was made on. Each commit
 * gets a branch it is reachable from, searched feature branches first and the
 * default branch last. A commit on a branch deleted since is reachable from
 * the default branch only, and carries no branch key.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";
import {
  bucketLinesChanged,
  deriveBranchHash,
  deriveWorkContext,
  forgeBranchKey,
  forgeRepoKey,
  readForgeFullName,
  repoKeysEnabled
} from "@ascenda-one/tool-kit";
import { HISTORICAL_PROVENANCE, NormalizedHistoricalEvent } from "../types.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_GIT_SINCE_DAYS = 365;

export interface GitExtractOptions {
  /** Days of history to read, counted back from now. */
  sinceDays?: number;
  /** Injected for tests. */
  now?: Date;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  });
  return stdout;
}

/** The repository root a ref points inside, or null. */
async function repoRootOf(ref: string): Promise<string | null> {
  try {
    await fs.access(ref);
    const root = (await git(ref, ["rev-parse", "--show-toplevel"])).trim();
    return root || null;
  } catch {
    return null;
  }
}

/** Local branch names, the default branch last. */
async function branchOrder(repo: string): Promise<{ branches: string[]; defaultBranch: string | null }> {
  let names: string[] = [];
  try {
    names = (await git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
      .split("\n")
      .map((n) => n.trim())
      .filter(Boolean);
  } catch {
    return { branches: [], defaultBranch: null };
  }
  let defaultBranch: string | null = null;
  try {
    const head = (await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (head.startsWith("origin/")) defaultBranch = head.slice("origin/".length);
  } catch {
    /* no origin/HEAD */
  }
  if (!defaultBranch) defaultBranch = names.find((n) => n === "main" || n === "master") ?? null;
  const rest = names.filter((n) => n !== defaultBranch);
  const branches = defaultBranch && names.includes(defaultBranch) ? [...rest, defaultBranch] : rest;
  return { branches, defaultBranch };
}

interface ParsedCommit {
  sha: string;
  parents: number;
  at: string;
  email: string;
  branch: string | null;
  files: number;
  added: number;
  removed: number;
}

const COMMIT_MARK = "\x1e";

/**
 * One `git log` over the branches, in the order that decides which branch a
 * commit is attributed to. `--numstat` prints nothing for a merge commit, so
 * a merge has zero files and lines here, by design.
 */
export function parseGitLog(output: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const block of output.split(COMMIT_MARK)) {
    if (!block.trim()) continue;
    const [header, ...stat] = block.split("\n");
    const [sha, parentField, epoch, email, source] = header.split("\x1f");
    if (!sha || !epoch) continue;
    const seconds = Number(epoch);
    if (!Number.isFinite(seconds)) continue;
    let files = 0;
    let added = 0;
    let removed = 0;
    for (const line of stat) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      files += 1;
      if (m[1] !== "-") added += Number(m[1]);
      if (m[2] !== "-") removed += Number(m[2]);
    }
    commits.push({
      sha,
      parents: parentField.trim() === "" ? 0 : parentField.trim().split(" ").length,
      at: new Date(seconds * 1000).toISOString(),
      email: (email ?? "").trim().toLowerCase(),
      branch: source ? source.trim() : null,
      files,
      added,
      removed
    });
  }
  return commits;
}

export async function* extractGit(
  repoRefs: Iterable<string>,
  extractionId: string,
  options: GitExtractOptions = {}
): AsyncIterable<NormalizedHistoricalEvent> {
  const now = options.now ?? new Date();
  const sinceDays = options.sinceDays ?? DEFAULT_GIT_SINCE_DAYS;
  const since = new Date(now.getTime() - sinceDays * 86_400_000).toISOString();

  // Resolve every ref to a repository root first, so two refs in one
  // repository (or a worktree and its parent's subdirectory) read it once.
  const roots = new Map<string, string>();
  let skipped = 0;
  for (const ref of new Set(repoRefs)) {
    const root = await repoRootOf(ref);
    if (!root) {
      skipped += 1;
      continue;
    }
    // A linked worktree shares its parent's history. Read the canonical
    // repository once, through whichever checkout named it first.
    const canonical = deriveWorkContext(root)?.projectPath ?? root;
    if (!roots.has(canonical)) roots.set(canonical, root);
  }

  let read = 0;
  let withoutIdentity = 0;
  let windowOldest: string | null = null;
  let windowNewest: string | null = null;

  for (const [canonical, checkout] of roots) {
    let me = "";
    try {
      me = (await git(checkout, ["config", "user.email"])).trim().toLowerCase();
    } catch {
      me = "";
    }
    if (!me) {
      withoutIdentity += 1;
      continue;
    }

    const { branches, defaultBranch } = await branchOrder(checkout);
    if (branches.length === 0) {
      skipped += 1;
      continue;
    }
    let output: string;
    try {
      output = await git(checkout, [
        "log",
        "--source",
        "--numstat",
        "--no-renames",
        `--since=${since}`,
        `--format=${COMMIT_MARK}%H\x1f%P\x1f%ct\x1f%ae\x1f%S`,
        ...branches,
        "--"
      ]);
    } catch {
      skipped += 1;
      continue;
    }
    read += 1;

    const fullName = repoKeysEnabled() ? readForgeFullName(canonical) : null;
    const context = deriveWorkContext(canonical);
    const seen = new Set<string>();
    for (const commit of parseGitLog(output)) {
      // `--source` over several branches lists a commit once, but a repository
      // with a replace ref or a graft can repeat one.
      if (seen.has(commit.sha)) continue;
      seen.add(commit.sha);
      if (commit.email !== me) continue;

      const isMerge = commit.parents > 1;
      const metrics: NormalizedHistoricalEvent["metrics"] = {
        activity: "git_commit",
        gitAction: "commit",
        isMergeCommit: isMerge,
        authoredByMe: true,
        filesChangedCount: commit.files,
        linesAddedBucket: bucketLinesChanged(commit.added),
        linesRemovedBucket: bucketLinesChanged(commit.removed),
        linesChangedBucket: bucketLinesChanged(commit.added + commit.removed)
      };
      const onDefault = commit.branch !== null && commit.branch === defaultBranch;
      if (commit.branch && !onDefault) {
        // `gitBranch` is hashed by the shipper through deriveBranchHash, the
        // function the live hooks call.
        if (deriveBranchHash(commit.branch)) metrics.gitBranch = commit.branch;
      }
      if (fullName) {
        metrics.repoKey = forgeRepoKey(fullName);
        if (commit.branch && !onDefault) metrics.branchKey = forgeBranchKey(fullName, commit.branch);
      }

      if (!windowOldest || commit.at < windowOldest) windowOldest = commit.at;
      if (!windowNewest || commit.at > windowNewest) windowNewest = commit.at;
      yield {
        occurredAt: commit.at,
        store: "git",
        sourceVersion: null,
        // A digest of the commit id: unique per commit and stable across
        // runs, which is what keeps two commits in one second apart without
        // putting the id itself on the wire.
        sessionRef: "git:" + createHash("sha256").update(commit.sha).digest("hex").slice(0, 16),
        repoRef: context?.projectPath ?? canonical,
        eventKind: "editor_activity",
        metrics,
        provenance: HISTORICAL_PROVENANCE.direct,
        extractionId
      };
    }
  }

  if (read > 0 || skipped > 0 || withoutIdentity > 0) {
    yield {
      occurredAt: windowNewest ?? now.toISOString(),
      store: "git",
      sourceVersion: null,
      sessionRef: null,
      repoRef: null,
      eventKind: "extraction_epoch",
      metrics: {
        ...(windowOldest && windowNewest ? { windowOldest, windowNewest } : {}),
        gitReposRead: read,
        gitReposSkipped: skipped,
        gitReposWithoutIdentity: withoutIdentity
      },
      provenance: HISTORICAL_PROVENANCE.derived,
      extractionId
    };
  }
}
