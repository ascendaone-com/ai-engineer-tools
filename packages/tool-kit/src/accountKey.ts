import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hashWithMachineSalt } from "./salt";

// An opaque key for "which Claude account was this session run under", so two
// accounts on one machine (a work profile and a personal one) don't blur
// together in the data.
//
// WHAT GETS HASHED is frozen: `account-v1`, the resolved config folder, and
// the plan tier, one per line, under the machine salt. The live hooks and the
// history import both call this, so a historical session and a live one from
// the same profile land on the same key.
//
// WHAT IS READ is one field. The config folder's `.claude.json` is parsed for
// `oauthAccount.organizationRateLimitTier` and nothing else: no token, no
// email, no organisation name, no account id is read into a variable, let
// alone hashed or sent. The tier is a plan label ("default_claude_max_5x");
// it is there so a profile whose plan changes gets a new key rather than a
// silently different history under the old one.
//
// WHERE `.claude.json` LIVES. Claude Code keeps it inside `$CLAUDE_CONFIG_DIR`
// when that is set and beside the default folder (`~/.claude.json`) when it
// isn't. A profile with no readable file hashes with an empty tier: the key
// still separates it from other folders.
//
// The key is a machine-local grouping, not an identity. The salt means it
// can't be compared across machines or reversed to a path.

export const ACCOUNT_KEY_VERSION = "account-v1";

/** The plan tier of the profile at `configDir`, or "" when it can't be read. */
export function readPlanTier(configDir: string, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const isDefault = path.resolve(configDir) === path.join(home, ".claude") && !env.CLAUDE_CONFIG_DIR?.trim();
  const candidates = isDefault
    ? [path.join(home, ".claude.json"), path.join(configDir, ".claude.json")]
    : [path.join(configDir, ".claude.json")];
  for (const file of candidates) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      const account = (parsed as { oauthAccount?: { organizationRateLimitTier?: unknown } } | null)?.oauthAccount;
      const tier = account?.organizationRateLimitTier;
      if (typeof tier === "string" && tier.length <= 64) return tier.trim();
    } catch {
      // Missing or unreadable: try the next candidate.
    }
  }
  return "";
}

/**
 * The account key for one config folder. `configDir` defaults to the one this
 * process runs under: the first entry of `CLAUDE_CONFIG_DIR`, else `~/.claude`.
 * Undefined when there is no readable machine salt, never an unsalted digest.
 */
export function deriveAccountKey(
  configDir?: string,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  saltFilePath?: string
): string | undefined {
  const first = env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
  const dir = path.resolve(configDir ?? (first ? first : path.join(home, ".claude")));
  const tier = readPlanTier(dir, home, env);
  try {
    return hashWithMachineSalt(`${ACCOUNT_KEY_VERSION}\n${dir}\n${tier}`, saltFilePath) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude profile folders beside the default one: `~/.claude-<name>` holding a
 * `projects` dir, sorted. A folder with settings and no `projects` dir has
 * never run a session, so it isn't a profile yet. Setup registers hooks in
 * each, and the history import reads each.
 */
export function extraClaudeProfileDirs(home: string = os.homedir()): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(home, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name.startsWith(".claude-"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return names
    .map((name) => path.join(home, name))
    .filter((dir) => {
      try {
        return fs.statSync(path.join(dir, "projects")).isDirectory();
      } catch {
        return false;
      }
    });
}
