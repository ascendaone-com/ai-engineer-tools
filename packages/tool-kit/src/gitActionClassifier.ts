import { GitAction } from "@ascenda-one/tool-contract";
import { commandHeads } from "./commandHeads";

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

  // Only text in command position counts — the same guard as the milestone
  // classifier, for the same reason: `git commit -m 'then git push'` is a
  // commit whose *message* mentions a push, and a heredoc body that says
  // "git commit" is prose. Flags are searched within the same segment as
  // their verb, so one segment's `--hard` cannot upgrade another's reset.
  const heads = commandHeads(value);

  // Order matters. `git commit --amend` is a rewrite of work already
  // committed, not a fresh boundary, so amend is tested before commit — the
  // reverse order would count every amend as new progress.
  if (heads.some((h) => /^git\s+commit\b/.test(h) && /\s--amend\b/.test(h))) return "amend";

  // `git revert` names an undo explicitly.
  if (heads.some((h) => /^git\s+revert\b/.test(h))) return "revert";

  // Only `--hard` discards work. A soft or mixed reset moves a pointer and
  // leaves the tree alone, which is bookkeeping rather than rework.
  if (heads.some((h) => /^git\s+reset\b/.test(h) && /\s--hard\b/.test(h))) return "reset_hard";

  // `git restore <path>` and the older `git checkout -- <path>` both throw
  // away uncommitted changes. `git restore --staged` only unstages, so it is
  // excluded: nothing is lost.
  if (heads.some((h) => /^git\s+restore\b/.test(h) && !/\s--staged\b/.test(h))) return "restore";
  if (heads.some((h) => /^git\s+checkout\b.*\s--\s/.test(h))) return "restore";

  if (heads.some((h) => /^git\s+push\b/.test(h))) return "push";
  if (heads.some((h) => /^git\s+commit\b/.test(h))) return "commit";

  // Everything else — status, log, diff, add, fetch — is not a boundary and
  // not rework. Undefined rather than "other": the field is absent when there
  // is nothing to say, matching how every other optional metadata key behaves.
  return undefined;
}

/** Whether an action undid work that already existed. */
export function isReworkGitAction(action: GitAction | undefined): boolean {
  return action === "revert" || action === "reset_hard" || action === "restore";
}
