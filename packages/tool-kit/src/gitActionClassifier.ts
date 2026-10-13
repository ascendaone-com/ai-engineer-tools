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

  const commands = heads.map(parseGitCommand).filter((c): c is GitCommand => c !== undefined);

  // Order matters. `git commit --amend` is a rewrite of work already
  // committed, not a fresh boundary, so amend is tested before commit — the
  // reverse order would count every amend as new progress.
  if (commands.some((c) => c.verb === "commit" && c.args.includes("--amend"))) return "amend";

  // `git revert` names an undo explicitly.
  if (commands.some((c) => c.verb === "revert")) return "revert";

  // Only `--hard` discards work. A soft or mixed reset moves a pointer and
  // leaves the tree alone, which is bookkeeping rather than rework.
  if (commands.some((c) => c.verb === "reset" && c.args.includes("--hard"))) return "reset_hard";

  // Every way of throwing away uncommitted changes is `restore`: `git restore
  // <path>`, `git checkout -- <path>` and its shorter spellings, `git clean -f`
  // (untracked files go too) and `git switch --discard-changes`. `git restore
  // --staged` only unstages, so it is excluded: nothing is lost.
  if (commands.some(discardsWork)) return "restore";

  if (commands.some((c) => c.verb === "push")) return "push";
  if (commands.some((c) => c.verb === "commit")) return "commit";

  // Everything else — status, log, diff, add, fetch — is not a boundary and
  // not rework. Undefined rather than "other": the field is absent when there
  // is nothing to say, matching how every other optional metadata key behaves.
  return undefined;
}

/** Whether an action undid work that already existed. */
export function isReworkGitAction(action: GitAction | undefined): boolean {
  return action === "revert" || action === "reset_hard" || action === "restore";
}

type GitCommand = { verb: string; args: string[] };

/** Global options that take their value as the next word (`-C dir`, `-c k=v`). */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

/**
 * Split a command head into git's verb and the words after it, skipping the
 * global options that sit between `git` and the verb. The head arrives
 * lowercased, so `-C` and `-c` are indistinguishable here, which is fine:
 * both take a value.
 */
function parseGitCommand(head: string): GitCommand | undefined {
  const words = head.split(/\s+/);
  if (words[0] !== "git") return undefined;
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    i += GLOBAL_OPTIONS_WITH_VALUE.has(words[i]) ? 2 : 1;
  }
  if (i >= words.length) return undefined;
  return { verb: words[i], args: words.slice(i + 1) };
}

function discardsWork({ verb, args }: GitCommand): boolean {
  switch (verb) {
    case "restore":
      return !args.includes("--staged");
    case "switch":
      return args.includes("--discard-changes") || args.includes("--force") || args.includes("-f");
    case "clean": {
      // `-n` only lists what would go. Short flags combine (`-fd`, `-nfdx`).
      const flags = args.filter((a) => /^-[a-z]+$/.test(a)).join("");
      const dryRun = args.includes("--dry-run") || flags.includes("n");
      return !dryRun && (args.includes("--force") || flags.includes("f"));
    }
    case "checkout":
      return checkoutDiscards(args);
    default:
      return false;
  }
}

/**
 * `git checkout` switches branches and restores files, and which one a given
 * command does depends on whether its words are refs or paths. After `--`
 * they are paths by definition. Without it, two or more words means a
 * tree-ish plus paths, and a lone word counts as a path only when it is
 * plainly one: `.`, a relative prefix, a trailing slash, a glob, or a name
 * ending in a lettered extension. `git checkout release-1.2` stays a switch.
 */
function checkoutDiscards(args: string[]): boolean {
  if (args.includes("--")) return true;
  // Creating or detaching to a new place never discards the working tree.
  if (args.some((a) => ["-b", "--orphan", "--detach", "-d", "-t", "--track", "-B"].includes(a))) return false;
  const words = args.filter((a) => !a.startsWith("-"));
  if (words.length >= 2) return true;
  if (words.length === 1) return /^\.{1,2}(\/|$)|\/$|[*?]|\.[a-z][a-z0-9]*$/.test(words[0]);
  return false;
}
