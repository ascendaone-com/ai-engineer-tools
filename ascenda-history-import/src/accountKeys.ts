import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deriveAccountKey } from "@ascenda-one/tool-kit";

/**
 * Which account each Claude Code session ran under, for a machine with more
 * than one config folder.
 *
 * Staging merges every projects dir into one tree, so the folder a transcript
 * came from is gone by the time the extractor reads it. This is read from the
 * live dirs before the copy and written beside the snapshot as
 * `account-keys.json`, `{ <sessionId>: <accountKey> }`. The key is the one the
 * live hooks send (`deriveAccountKey`), so a session imported from a profile
 * and the same profile's live events agree.
 *
 * A session id found under two folders keeps the first, matching the copy,
 * which keeps one transcript per id. Nothing but the folder path and the plan
 * tier goes into a key; see tool-kit's accountKey.ts.
 */
export const ACCOUNT_KEYS_FILE = "account-keys.json";

export function accountKeysFor(
  configDirs: { configDir: string; projectsDir: string }[],
  home?: string,
  env?: NodeJS.ProcessEnv
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { configDir, projectsDir } of configDirs) {
    const key = deriveAccountKey(configDir, home, env);
    if (!key) continue;
    let slugs: string[];
    try {
      slugs = readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      let names: string[];
      try {
        names = readdirSync(path.join(projectsDir, slug));
      } catch {
        continue;
      }
      for (const name of names) {
        const id = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
        if (!(id in out)) out[id] = key;
      }
    }
  }
  return out;
}

export async function writeAccountKeys(snapshotRoot: string, keys: Record<string, string>): Promise<void> {
  await fs.mkdir(snapshotRoot, { recursive: true });
  await fs.writeFile(path.join(snapshotRoot, ACCOUNT_KEYS_FILE), JSON.stringify(keys));
}

export async function readAccountKeys(snapshotRoot: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(snapshotRoot, ACCOUNT_KEYS_FILE), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
