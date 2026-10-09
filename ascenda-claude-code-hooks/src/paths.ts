import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ascendaHome, credentialsFilePath as credentialsFile, readMachineCredentials, writeMachineCredentials, writeTopLevelCredentials } from "@ascenda-one/tool-kit";
import type { HostCredentials } from "@ascenda-one/tool-kit";

export { credentialsFilePath } from "@ascenda-one/tool-kit";

/**
 * What every registered hook command runs: the shell launcher `setup`
 * writes (see launcher.ts), which finds a Node and runs the bundle beside
 * it. No sudo, no npm -g.
 */
export function hookBinPath(): string {
  return path.join(ascendaHome(), "bin", "ascenda-claude-hook");
}

/** The self-contained hook bundle the launcher runs. */
export function hookBundlePath(): string {
  return path.join(ascendaHome(), "bin", "ascenda-claude-hook.mjs");
}

/** The Node the launcher last found, one absolute path. Rewritten by the launcher when it goes. */
export function hookNodeRecordPath(): string {
  return path.join(ascendaHome(), "bin", "ascenda-claude-hook.node");
}

/** Present while the launcher can find no Node; holds when it last looked. */
export function hookNoNodePath(): string {
  return path.join(ascendaHome(), "bin", "ascenda-claude-hook.no-node");
}

/**
 * Written by `setup` so hook processes need no environment at all: Claude Code
 * spawns hooks with whatever environment it was launched from, so requiring
 * exports means telemetry silently stops whenever the editor is started from a
 * launcher rather than a configured shell.
 *
 * Claude Code's pairing is the top level of ~/.ascenda/credentials.json; the
 * CLI agents' setups write under `tools.<host>` in the same file, and the
 * writer here leaves that section alone.
 */
export type MachineCredentials = HostCredentials;

export function readCredentials(): MachineCredentials | undefined {
  const credentials = readMachineCredentials();
  if (!credentials) return undefined;
  const { tools: _tools, ...topLevel } = credentials;
  return topLevel;
}

export function writeCredentials(credentials: MachineCredentials): void {
  writeTopLevelCredentials(credentials);
}

/**
 * Drops Claude Code's pairing record, keeping every other agent's.
 *
 * `uninstall` used to delete the whole file, which took the `tools` section
 * with it: uninstalling one agent left the others pointing at an identity
 * that no longer existed on disk. The file goes only when nothing else is in
 * it.
 */
export function removeCredentials(): void {
  const credentials = readMachineCredentials();
  if (!credentials) return;
  if (credentials.tools && Object.keys(credentials.tools).length > 0) {
    writeMachineCredentials({ tools: credentials.tools });
    return;
  }
  fs.rmSync(credentialsFile(), { force: true });
}

/**
 * How to run this tool again from a terminal: the installed launcher, not
 * npx. It needs no Node on PATH, and it is the version that was just
 * installed rather than whatever npm has as latest.
 */
export function selfCommand(): string {
  if (process.platform === "win32") return "npx @ascenda-one/claude-code-hooks";
  const home = os.homedir();
  const bin = hookBinPath();
  return bin.startsWith(`${home}/`) ? `~${bin.slice(home.length)}` : bin;
}
