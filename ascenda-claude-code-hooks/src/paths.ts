import * as path from "path";
import { ascendaHome, readMachineCredentials, writeTopLevelCredentials } from "@ascenda-one/tool-kit";
import type { HostCredentials } from "@ascenda-one/tool-kit";

export { credentialsFilePath } from "@ascenda-one/tool-kit";

/** Where `setup` places the self-contained hook bundle. No sudo, no npm -g. */
export function hookBinPath(): string {
  return path.join(ascendaHome(), "bin", "ascenda-claude-hook");
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
