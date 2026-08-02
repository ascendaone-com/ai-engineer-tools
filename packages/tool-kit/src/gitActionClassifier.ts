import { GitAction } from "@ascenda-one/tool-contract";

/**
 * What a `git` command actually did, from the command line alone.
 *
 * Two independent jobs, which is why one classifier covers both:
 *
 * 1. **Boundaries.** The backend derives `commit` and `push` work boundaries
 *    from a `gitAction` metadata field. It has read that field since the
 *    demand view shipped; nothing has ever written it. Until this existed, the
 *    only boundary any user could produce was a verification pass, and
 *    `commits_per_day` — the target metric of the `commit-at-green` remedy —
 *    reported as unmeasurable for everyone, which is honest but useless.
 *
 * 2. **Rework.** `revert`, `reset_hard` and `restore` are the report's
 *    "reversions" signal: work that was produced and then undone.
 *
 * Deliberately syntactic. This reads the command string and nothing else — it
 * does not run git, inspect a repository, or resolve what a revert touched. A
 * classifier that shelled out would be both slow on a hot path and a way for a
 * telemetry hook to have side effects in someone's working tree.
 */
export function classifyGitAction(command: string | undefined | null): GitAction | undefined {
  if (!command) return undefined;
  const value = command.toLowerCase().trim();
  if (!/\bgit\b/.test(value)) return undefined;

  // Order matters. `git commit --amend` is a rewrite of work already
  // committed, not a fresh boundary, so amend is tested before commit — the
  // reverse order would count every amend as new progress.
  if (/\bgit\s+commit\b[^\n]*--amend\b/.test(value)) return "amend";

  // `git revert` names an undo explicitly.
  if (/\bgit\s+revert\b/.test(value)) return "revert";

  // Only `--hard` discards work. A soft or mixed reset moves a pointer and
  // leaves the tree alone, which is bookkeeping rather than rework.
  if (/\bgit\s+reset\b[^\n]*--hard\b/.test(value)) return "reset_hard";

  // `git restore <path>` and the older `git checkout -- <path>` both throw
  // away uncommitted changes. `git restore --staged` only unstages, so it is
  // excluded: nothing is lost.
  if (/\bgit\s+restore\b/.test(value) && !/--staged\b/.test(value)) return "restore";
  if (/\bgit\s+checkout\b[^\n]*\s--\s/.test(value)) return "restore";

  if (/\bgit\s+push\b/.test(value)) return "push";
  if (/\bgit\s+commit\b/.test(value)) return "commit";

  // Everything else — status, log, diff, add, fetch — is not a boundary and
  // not rework. Undefined rather than "other": the field is absent when there
  // is nothing to say, matching how every other optional metadata key behaves.
  return undefined;
}

/** Whether an action undid work that already existed. */
export function isReworkGitAction(action: GitAction | undefined): boolean {
  return action === "revert" || action === "reset_hard" || action === "restore";
}
