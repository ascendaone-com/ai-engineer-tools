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
  /** Canonical repository root, when one was resolved on disk. Local only. */
  projectPath: string | null;
}

/** Walk-up ceiling. A real checkout is never 64 directories from root. */
const MAX_WALK_DEPTH = 64;

/**
 * Derives the work-context identifiers for a working directory.
 *
 * Pure filesystem — no `git` subprocess, because this runs on the hook hot
 * path between a person and their agent. A path that no longer exists (the
 * importer replays cwds of repositories long deleted) degrades cleanly: no
 * walk, project = workspace basename.
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

    if (stat?.isDirectory()) return { checkoutRoot: dir, canonicalRoot: dir };
    if (stat?.isFile()) return { checkoutRoot: dir, canonicalRoot: worktreeParentRoot(dotGit, dir) ?? dir };

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function worktreeParentRoot(dotGitFile: string, containingDir: string): string | null {
  let gitdir: string;
  try {
    const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGitFile, "utf8"));
    if (!match) return null;
    gitdir = match[1].trim();
  } catch {
    return null;
  }

  const resolved = path.resolve(containingDir, gitdir);
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const idx = resolved.indexOf(marker);
  if (idx === -1) return null;
  return resolved.slice(0, idx);
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
