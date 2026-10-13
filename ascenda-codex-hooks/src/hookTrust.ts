import * as fs from "fs";
import * as path from "path";
import type { HookPosition, HookTrustReport } from "@ascenda-one/tool-kit";

/**
 * Codex runs a hook only after it has been approved, and records the approval
 * in `config.toml` beside the hooks file as a table named for the hook:
 *
 *     [hooks.state."<hooks file>:<event>:<group>:<handler>"]
 *
 * A hook with no such table is skipped without a message, and one whose
 * command has changed since it was approved has to be approved again. Either
 * way nothing runs and nothing is sent, which no signal from the hook itself
 * can show. This reads the keys so `status` and `doctor` can.
 *
 * Windows writes the key as a TOML literal string, in single quotes, because
 * its path is full of backslashes; the other platforms use double quotes. Both
 * are read. The key is split from the right: a Windows path has its own colon.
 *
 * What it cannot do is compare the approved command with the current one:
 * Codex keeps its own fingerprint of that, and recomputing it here would be a
 * guess. So a table that exists is taken as approved, and a changed command is
 * only suspected, from the hooks file being newer than `config.toml`.
 */

const HEADER = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]/;

export type ApprovalKey = { file: string; event: string; group: number; handler: number };

/** Every hook approval in a `config.toml`'s text. Keys that don't have the four-part shape are ignored. */
export function parseApprovalKeys(toml: string): ApprovalKey[] {
  const keys: ApprovalKey[] = [];
  for (const line of toml.split(/\r?\n/)) {
    const match = HEADER.exec(line);
    if (!match) continue;
    const quoted = match[1];
    const key = quoted.startsWith("'") ? quoted.slice(1, -1) : unescapeBasicString(quoted.slice(1, -1));
    const parts = /^(.*):([^:]+):(\d+):(\d+)$/.exec(key);
    if (!parts) continue;
    keys.push({ file: parts[1], event: parts[2], group: Number(parts[3]), handler: Number(parts[4]) });
  }
  return keys;
}

function unescapeBasicString(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

/** Codex spells events in snake_case in some places and TitleCase in others, so compare on letters alone. */
const eventId = (event: string): string => event.toLowerCase().replace(/[^a-z]/g, "");

const fileId = (file: string): string => {
  const slashed = file.replace(/\\/g, "/");
  return process.platform === "win32" || /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
};

export function checkCodexHookTrust(settingsFile: string, ours: HookPosition[]): HookTrustReport {
  const approvalsFile = path.join(path.dirname(settingsFile), "config.toml");
  let toml = "";
  try {
    toml = fs.readFileSync(approvalsFile, "utf8");
  } catch (error) {
    // No config.toml means nothing has been approved, which is a finding.
    // Anything else (permissions, a directory) means we cannot tell.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { approvalsFile, untrusted: [], stale: [], unreadable: true };
  }

  const here = fileId(path.resolve(settingsFile));
  const keys = parseApprovalKeys(toml).filter((key) => fileId(key.file) === here);
  const approved = (position: HookPosition) =>
    keys.some((key) => eventId(key.event) === eventId(position.event) && key.group === position.group && key.handler === position.handler);

  const untrusted = ours.filter((position) => !approved(position));

  const ourEvents = new Set(ours.map((position) => eventId(position.event)));
  const stale: string[] = [];
  for (const key of keys) {
    if (!ourEvents.has(eventId(key.event))) continue;
    if (ours.some((position) => eventId(position.event) === eventId(key.event) && position.group === key.group && position.handler === key.handler)) continue;
    stale.push(`An approval for ${key.event} (group ${key.group}, handler ${key.handler}) points at a hook that has moved or gone.`);
  }

  if (untrusted.length === 0 && stale.length === 0 && changedAfterApproval(settingsFile, approvalsFile)) {
    stale.push("The hooks file was changed after the last approval was recorded, so a changed command may be waiting for re-approval.");
  }
  return { approvalsFile, untrusted, stale };
}

function changedAfterApproval(hooksFile: string, approvalsFile: string): boolean {
  try {
    return fs.statSync(hooksFile).mtimeMs > fs.statSync(approvalsFile).mtimeMs;
  } catch {
    return false;
  }
}
