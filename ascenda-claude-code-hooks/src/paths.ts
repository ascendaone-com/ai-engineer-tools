import * as fs from "fs";
import * as path from "path";
import { ascendaHome } from "@ascenda-one/tool-kit";

/** Where `setup` places the self-contained hook bundle. No sudo, no npm -g. */
export function hookBinPath(): string {
  return path.join(ascendaHome(), "bin", "ascenda-claude-hook");
}

export function credentialsFilePath(): string {
  return path.join(ascendaHome(), "credentials.json");
}

/**
 * Written by `setup` so hook processes need no environment at all: Claude Code
 * spawns hooks with whatever environment it was launched from, so requiring
 * exports means telemetry silently stops whenever the editor is started from a
 * launcher rather than a configured shell.
 */
export type MachineCredentials = {
  apiBaseUrl?: string;
  toolInstallationId?: string;
  pairedAt?: string;
};

export function readCredentials(): MachineCredentials | undefined {
  try {
    const raw = fs.readFileSync(credentialsFilePath(), "utf8").trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as MachineCredentials;
  } catch {
    // Missing or unreadable credentials are not an error: env vars and the
    // token file are still valid sources.
    return undefined;
  }
}

export function writeCredentials(credentials: MachineCredentials): void {
  const file = credentialsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(path.dirname(file), 0o700);
    fs.chmodSync(file, 0o600);
  }
}
