import * as fs from "fs";
import * as path from "path";
import { readMachineCredentials } from "./credentials";
import { forgeBranchKey, forgeRepoKey, readForgeFullName } from "./forgeProject";
import { deriveWorkContext, normalizeBranchName, readBranchName } from "./workContext";

// The keys that let a coding session be matched to a pull request.
//
// `branchHash` on the wire is salted with a machine secret, so nothing off the
// machine can reproduce it, and a code-forge collector, which runs where no
// salt exists, can't either. These two keys use the forge collector's own
// recipe (forgeProject.ts), so a session and a pull request that name the same
// repository and head branch arrive with the same pair.
//
// THE TRADE-OFF. They are unsalted and low-entropy. Anyone holding them can
// confirm a guess like "this was branch feat/x of acme/api", and for a public
// repository the names are public. That is the trade-off already accepted for
// the forge collector's repository digest, widened by one branch name. Three
// limits keep it narrow:
//
//  - github.com remotes only, because that is the only forge the collector
//    names. Anything else gets no key rather than a guess.
//  - No branch key on the repository's default branch. Every session on `main`
//    would share one key, and the join has nothing to say about it.
//  - A switch anyone can flip: `ASCENDA_REPO_KEYS=off`, or `setup --repo-keys
//    off`, which is saved machine-wide in credentials.json.

export const REPO_KEYS_ENV_VAR = "ASCENDA_REPO_KEYS";

export type ForgeKeys = { repoKey?: string; branchKey?: string };

/** Whether this machine puts the keys on events. The environment beats the saved setting. */
export function repoKeysEnabled(): boolean {
  const env = process.env[REPO_KEYS_ENV_VAR]?.trim().toLowerCase();
  if (env === "off" || env === "0" || env === "false") return false;
  if (env === "on" || env === "1" || env === "true") return true;
  return readMachineCredentials()?.repoKeys !== false;
}

/**
 * `origin`'s default branch, from the symbolic ref `git clone` leaves at
 * `refs/remotes/origin/HEAD`. Null when it isn't there, which happens for a
 * repository that was `git init`ed and then given a remote.
 */
function readDefaultBranch(repositoryRoot: string): string | null {
  try {
    const head = fs.readFileSync(path.join(repositoryRoot, ".git", "refs", "remotes", "origin", "HEAD"), "utf8").trim();
    const match = /^ref:\s*refs\/remotes\/origin\/(.+)$/.exec(head);
    return match ? normalizeBranchName(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The repository key and, off the default branch, the branch key for the
 * checkout at `cwd`. Pure filesystem like the rest of the hook hot path, and
 * never throws: every missing piece just leaves its key off.
 */
export function deriveForgeKeysForCwd(cwd: string | null | undefined): ForgeKeys {
  try {
    if (!cwd || !repoKeysEnabled()) return {};
    const root = deriveWorkContext(cwd)?.projectPath;
    const fullName = readForgeFullName(root);
    if (!root || !fullName) return {};
    const branch = readBranchName(cwd);
    const onDefault = branch !== null && branch === readDefaultBranch(root);
    return {
      repoKey: forgeRepoKey(fullName),
      ...(branch && !onDefault ? { branchKey: forgeBranchKey(fullName, branch) } : {})
    };
  } catch {
    return {};
  }
}
