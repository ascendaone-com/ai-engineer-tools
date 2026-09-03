import * as fs from "fs";
import * as path from "path";
import { hashWithMachineSalt } from "./salt";

// The one derivation every collector must share. Two identifiers travel on the
// wire, both as machine-salted hashes, and WHAT STRING GETS HASHED is a frozen
// contract — a collector that hashes something else splits one repository into
// several identities in stored rows, permanently, because the backend only
// ever sees the digests.
//
//   workspaceHash — hash of the BASENAME of the CHECKOUT the work happened in:
//     the folder that owns the nearest `.git` ("asc-core-be-wt",
//     "quizzical-thompson"), so a cwd three directories deep still names the
//     checkout, not `src`. Matches what the VS Code extension has always sent
//     (`vscode.workspace.name` is the opened folder's name), so live IDE rows
//     and rows built here agree. Outside git, the folder itself.
//
//   projectHash — hash of the BASENAME of the canonical git repository the
//     checkout belongs to. A linked worktree resolves to the repository it was
//     created from, so `<repo>/.claude/worktrees/fancy-name` and the repo
//     itself are one project. Outside git it falls back to the workspace
//     basename.
//
// Basenames, not full paths, deliberately: a clone moved to a new machine or a
// second checkout of the same repo keeps its identity, and the input space
// stays consistent across collectors that only know a name (VS Code) and ones
// that know a path (hooks, the importer). Two unrelated directories that share
// a basename will collide — accepted: hashes are grouped and named locally
// (see contextRegistry.ts), where a person can split or merge what the digest
// could not distinguish.
export interface WorkContext {
  /** Basename of the checkout (or, outside git, the folder). Local only — never send the label. */
  workspaceLabel: string | null;
  /** Basename of the canonical repository root. Local only. */
  projectLabel: string | null;
  workspaceHash: string | null;
  projectHash: string | null;
  /** The checkout (or folder). Local only, kept for the registry. */
  workspacePath: string | null;
  /**
   * Canonical repository root — resolved on disk, or inferred from the
   * path's own shape when the disk can no longer answer (see
   * `inferRootsFromPath`). Local only.
   */
  projectPath: string | null;
}

/** Walk-up ceiling. A real checkout is never 64 directories from root. */
const MAX_WALK_DEPTH = 64;

/**
 * Derives the work-context identifiers for a working directory.
 *
 * Pure filesystem — no `git` subprocess, because this runs on the hook hot
 * path between a person and their agent. A path that no longer exists (the
 * importer replays cwds of repositories long deleted; a session's last hooks
 * fire after its worktree is cleaned up) degrades in two steps: first the
 * path's own shape is read for a worktree convention it can still name the
 * parent repository from, and only then does the project fall back to the
 * workspace basename. Without that first step every deleted worktree freezes
 * into stored rows as a project of its own — a permanent split the backend
 * cannot undo because it only ever sees the digests.
 *
 * Returns null for empty input so callers can pass optional fields through.
 */
export function deriveWorkContext(
  cwd: string | null | undefined,
  saltFilePath?: string
): WorkContext | null {
  if (!cwd || !cwd.trim()) return null;

  const startPath = stripTrailingSeparators(cwd.trim());

  let roots: RepositoryRoots | null = null;
  try {
    roots = resolveRepositoryRoots(startPath);
  } catch {
    // Unreadable directories are a property of other people's machines, not a
    // reason to drop the event or stall the hook.
    roots = null;
  }
  if (!roots) roots = inferRootsFromPath(startPath);

  const workspacePath = roots?.checkoutRoot ?? startPath;
  const workspaceLabel = basenameOf(workspacePath);
  if (!workspaceLabel) return null;

  const projectPath = roots?.canonicalRoot ?? null;
  const projectLabel = (projectPath ? basenameOf(projectPath) : null) ?? workspaceLabel;

  return {
    workspaceLabel,
    projectLabel,
    workspaceHash: hashWithMachineSalt(workspaceLabel, saltFilePath),
    projectHash: hashWithMachineSalt(projectLabel, saltFilePath),
    workspacePath,
    projectPath
  };
}

interface RepositoryRoots {
  /** The folder owning the nearest `.git` — the checkout itself. */
  checkoutRoot: string;
  /** The repository the checkout belongs to; equals checkoutRoot except for linked worktrees. */
  canonicalRoot: string;
  /**
   * The git directory backing this checkout — `<checkout>/.git` for a primary
   * checkout, `<repo>/.git/worktrees/<name>` for a linked worktree. Null when
   * the roots were inferred from a dead path's shape, which names a repository
   * but reaches no files. Read only for the checkout's own `HEAD`.
   */
  gitDir: string | null;
}

/**
 * Nearest enclosing repository: the checkout, and its CANONICAL root.
 *
 * `.git` as a directory is a primary checkout — both roots are that folder.
 * `.git` as a file is a linked worktree (or a submodule): its `gitdir:` line
 * points into the parent repository's `.git/worktrees/<name>`, and THAT
 * repository is the project the work belongs to. Submodule gitdirs
 * (`.git/modules/...`) stay their own project — a submodule is a different
 * repository, not another checkout of this one.
 */
function resolveRepositoryRoots(startDir: string): RepositoryRoots | null {
  if (!fs.existsSync(startDir)) return null;

  let dir = startDir;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = null;
    }

    if (stat?.isDirectory()) return { checkoutRoot: dir, canonicalRoot: dir, gitDir: dotGit };
    if (stat?.isFile()) {
      const gitDir = readGitdirPointer(dotGit, dir);
      const canonicalRoot = (gitDir ? worktreeParentRoot(gitDir) : null) ?? dir;
      return { checkoutRoot: dir, canonicalRoot, gitDir };
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** The `gitdir:` a `.git` FILE points at, resolved against the folder holding it. */
function readGitdirPointer(dotGitFile: string, containingDir: string): string | null {
  try {
    const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGitFile, "utf8"));
    if (!match) return null;
    return path.resolve(containingDir, match[1].trim());
  } catch {
    return null;
  }
}

function worktreeParentRoot(resolvedGitDir: string): string | null {
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const idx = resolvedGitDir.indexOf(marker);
  if (idx === -1) return null;
  return resolvedGitDir.slice(0, idx);
}

/**
 * Roots read from the path's shape alone — the dead-path fallback.
 *
 * Only consulted when the disk gave no answer (the directory is gone, or
 * holds no `.git`). Two conventions are recognised, both deliberately
 * narrow so that a plain deleted checkout still degrades to its basename:
 *
 *   1. `<repo>/.claude/worktrees/<name>[/…]` — where Claude Code keeps the
 *      worktrees it creates. The parent repository is the folder above the
 *      marker; the checkout is the folder just below it.
 *   2. `<repo>-wt/<name>[/…]` and `<repo>-worktrees/<name>[/…]` — the sibling
 *      folder convention (`git worktree add ../<repo>-wt/<name>`). The parent
 *      repository is inferred as `<repo>` beside that folder. This one is a
 *      naming convention, not a git fact, so it applies to dead paths only.
 *
 * A worktree placed anywhere else (`git worktree add ../feature-x`) leaves no
 * trace in its cwd once deleted, and cannot be inferred — that case still
 * degrades to its own basename, as before.
 */
function inferRootsFromPath(startPath: string): RepositoryRoots | null {
  const sep = startPath.includes("\\") && !startPath.includes("/") ? "\\" : "/";
  const leading = /^[\\/]/.test(startPath) ? sep : "";
  const segments = startPath.split(/[\\/]/).filter(Boolean);
  const join = (count: number): string => leading + segments.slice(0, count).join(sep);

  for (let i = 0; i + 2 < segments.length; i++) {
    if (segments[i] === ".claude" && segments[i + 1] === "worktrees") {
      if (i === 0) return null;
      return { checkoutRoot: join(i + 3), canonicalRoot: join(i), gitDir: null };
    }
  }

  for (let i = 0; i + 1 < segments.length; i++) {
    const folder = segments[i];
    const suffix = ["-worktrees", "-wt"].find((s) => folder.endsWith(s) && folder.length > s.length);
    if (!suffix) continue;
    const repoName = folder.slice(0, -suffix.length);
    const canonicalRoot = leading + [...segments.slice(0, i), repoName].join(sep);
    return { checkoutRoot: join(i + 2), canonicalRoot, gitDir: null };
  }

  return null;
}

function stripTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 1 && (value[end - 1] === "/" || value[end - 1] === "\\")) end--;
  return value.slice(0, end);
}

function basenameOf(value: string): string | null {
  const segment = value.split(/[\\/]/).filter(Boolean).pop() ?? null;
  return segment && segment.length > 0 ? segment : null;
}

// ── The branch the work happened on ────────────────────────────────────────
//
// branchHash — hash of the BRANCH NAME, under the same salt and the same
// discipline as the two identifiers above: a NAME is hashed, never a path and
// never a ref path, so every collector that can see a branch produces the same
// digest for the same branch on this machine. `refs/heads/feat/x` and
// `feat/x` are the same branch and must not become two identities, so the ref
// prefix is stripped before hashing — the equivalent of "basename, never
// path" one level down.
//
// A branch name is LOW ENTROPY — `main`, `develop`, a ticket slug — and this
// digest is NOT a security boundary. It is the machine salt that makes the
// input space unguessable (see salt.ts), exactly as for workspaceHash; what
// the digest buys is that a branch name never travels as text while work can
// still be grouped by branch on the other side.
//
// Absent rather than fake, in four cases: a detached HEAD (there is no branch
// to name), a cwd outside any checkout, a checkout whose `HEAD` cannot be
// read, and a salt that cannot be read. An empty string or a `HEAD`
// placeholder would be a value a reader could group on, asserting a branch
// that does not exist — so the field is simply omitted.
//
// Per checkout, not per repository: unlike projectHash, a linked worktree
// does NOT fold into its parent here. Each worktree has its own `HEAD`, and
// its own branch is the honest answer.

const REFS_HEADS_PREFIX = "refs/heads/";

/**
 * The branch name a digest is taken of: trimmed, with `refs/heads/` stripped.
 *
 * Null — never an empty string — for anything that names no branch: blank
 * input, a bare prefix, and the literal `HEAD` a detached checkout reports.
 */
export function normalizeBranchName(branch: string | null | undefined): string | null {
  if (!branch) return null;
  let name = branch.trim();
  if (name.startsWith(REFS_HEADS_PREFIX)) name = name.slice(REFS_HEADS_PREFIX.length).trim();
  if (!name || name === "HEAD") return null;
  return name;
}

/**
 * The wire-ready digest of a branch name, or null when there is no branch to
 * name. The one derivation every collector must share — live hooks and the
 * retrospective importer both call THIS, so a historical row and a live one
 * from the same branch land on the same digest and can be pooled.
 */
export function deriveBranchHash(
  branch: string | null | undefined,
  saltFilePath?: string
): string | null {
  const name = normalizeBranchName(branch);
  if (!name) return null;
  try {
    return hashWithMachineSalt(name, saltFilePath);
  } catch {
    // No readable salt means no digest — never an unsalted one, which would be
    // recoverable from a list of common branch names, and never a placeholder.
    return null;
  }
}

/**
 * The branch checked out at a working directory, read from the checkout's own
 * `HEAD`. Null for a detached HEAD, and for a cwd in no checkout at all.
 *
 * Pure filesystem, no `git` subprocess, for the reason `deriveWorkContext`
 * gives: this runs on the hook hot path between a person and their agent. A
 * linked worktree has its own `HEAD` inside the parent's
 * `.git/worktrees/<name>`, so a worktree reports the branch it is actually on.
 */
export function readBranchName(cwd: string | null | undefined): string | null {
  if (!cwd || !cwd.trim()) return null;

  let gitDir: string | null = null;
  try {
    gitDir = resolveRepositoryRoots(stripTrailingSeparators(cwd.trim()))?.gitDir ?? null;
  } catch {
    gitDir = null;
  }
  if (!gitDir) return null;

  let head: string;
  try {
    head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return null;
  }

  // `ref: refs/heads/<branch>` on a branch; a bare object id when detached.
  const match = /^ref:\s*(.+)$/.exec(head);
  if (!match) return null;
  const ref = match[1].trim();
  if (!ref.startsWith(REFS_HEADS_PREFIX)) return null;
  return normalizeBranchName(ref);
}

/** {@link readBranchName} then {@link deriveBranchHash} — what a hook calls. */
export function deriveBranchHashForCwd(
  cwd: string | null | undefined,
  saltFilePath?: string
): string | null {
  return deriveBranchHash(readBranchName(cwd), saltFilePath);
}
