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
  //
  // `git fetch && git reset --hard origin/<branch>` is often a worktree sync,
  // not rework, and it still counts. Telling the two apart needs the current
  // branch and whether there was anything local to lose, and neither is in
  // the command string. A rule built on the target's name alone would also
  // hide `git reset --hard origin/main` run to throw away a bad local commit.
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
  return { verb: words[i], args: withoutRedirects(words.slice(i + 1)) };
}

/**
 * Drop shell redirections, which are words the shell keeps and git never
 * sees. Left in, `git checkout -q main 2>/dev/null` has two non-flag words and
 * reads as a tree-ish plus a path. `commandHeads` has already split at `&`,
 * so `2>&1` arrives as a bare `2>` at the end of its segment; a bare operator
 * takes the next word as its target when there is one.
 */
function withoutRedirects(words: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const redirect = /^\d*(>>?|<)(.*)$/.exec(words[i]);
    if (!redirect) {
      kept.push(words[i]);
    } else if (redirect[2] === "") {
      i += 1;
    }
  }
  return kept;
}

/**
 * `HEAD`, `HEAD~2`, `HEAD@{1}`, `@`, `@~1`: the commit you're on or one of its
 * own ancestors. `@{u}` is the upstream, another ref, so it doesn't match.
 */
function isHeadRef(ref: string): boolean {
  return /^(head([~^@]|$)|@([~^]|$))/.test(ref);
}

function discardsWork({ verb, args }: GitCommand): boolean {
  switch (verb) {
    case "restore":
      return restoreDiscards(args);
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
 * `git restore` discards unless it only unstages, picks a side of a merge
 * conflict, or takes the file from another ref. `--source HEAD~1` is still
 * an undo; `--source origin/main` ports a file across.
 */
function restoreDiscards(args: string[]): boolean {
  if (args.includes("--staged")) return false;
  if (args.includes("--ours") || args.includes("--theirs")) return false;
  const source = optionValue(args, "--source", "-s");
  return source === undefined || isHeadRef(source);
}

/** The value of `--name value`, `--name=value` or `-n value`. */
function optionValue(args: string[], long: string, short: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(`${long}=`)) return args[i].slice(long.length + 1);
    if (args[i] === long || args[i] === short) return args[i + 1];
  }
  return undefined;
}

/**
 * `git checkout` switches branches and restores files, and which one a given
 * command does depends on whether its words are refs or paths. After `--`
 * they are paths by definition, and a word before `--` is the tree-ish they
 * come from. Without `--`, two or more words means a tree-ish plus paths, and
 * a lone word counts as a path only when it is plainly one: `.`, a relative
 * prefix, a trailing slash, a glob, or a name ending in a lettered extension.
 * `git checkout release-1.2` stays a switch.
 *
 * Paths taken from `HEAD` or one of its ancestors are an undo. Paths taken
 * from any other ref (`git checkout main -- pubspec.yaml`) are a port, and
 * `--ours`/`--theirs` picks a side of a conflict. Neither is rework.
 */
function checkoutDiscards(args: string[]): boolean {
  if (args.includes("--ours") || args.includes("--theirs")) return false;
  const separator = args.indexOf("--");
  if (separator !== -1) {
    const source = args.slice(0, separator).find((a) => !a.startsWith("-"));
    return source === undefined || isHeadRef(source);
  }
  // Creating or detaching to a new place never discards the working tree.
  if (args.some((a) => ["-b", "--orphan", "--detach", "-d", "-t", "--track", "-B"].includes(a))) return false;
  const words = args.filter((a) => !a.startsWith("-"));
  if (words.length >= 2) return isHeadRef(words[0]) || looksLikePath(words[0]);
  if (words.length === 1) return looksLikePath(words[0]);
  return false;
}

function looksLikePath(word: string): boolean {
  return /^\.{1,2}(\/|$)|\/$|[*?]|\.[a-z][a-z0-9]*$/.test(word);
}
