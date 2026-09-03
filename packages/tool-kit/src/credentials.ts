import * as fs from "fs";
import * as path from "path";
import { ascendaHome } from "./tokenStore";

/**
 * `~/.ascenda/credentials.json` — what a hook needs to name itself when it
 * runs with an empty environment, which on macOS is the normal case: a
 * GUI-launched editor never sees a shell rc file (issue #48).
 *
 * The top-level fields are Claude Code's, unchanged since `setup` first wrote
 * them. Every other agent lives under `tools.<host>` so five setups on one
 * machine do not overwrite each other, and so a Cursor hook never ships under
 * a Codex pairing because both pair as `cli_agent`.
 */
export type HostCredentials = {
  apiBaseUrl?: string;
  toolInstallationId?: string;
  pairedAt?: string;
};

export type MachineCredentials = HostCredentials & {
  tools?: Record<string, HostCredentials>;
};

export function credentialsFilePath(): string {
  return path.join(ascendaHome(), "credentials.json");
}

export function readMachineCredentials(): MachineCredentials | undefined {
  try {
    const raw = fs.readFileSync(credentialsFilePath(), "utf8").trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as MachineCredentials;
  } catch {
    // Missing or unreadable credentials are not an error: the environment and
    // the token store are still valid sources.
    return undefined;
  }
}

/** Replaces the whole file. Prefer the merging writers below. */
export function writeMachineCredentials(credentials: MachineCredentials): void {
  const file = credentialsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(path.dirname(file), 0o700);
    fs.chmodSync(file, 0o600);
  }
}

/** Claude Code's top-level pairing, written without disturbing `tools`. */
export function writeTopLevelCredentials(credentials: HostCredentials): void {
  const existing = readMachineCredentials();
  writeMachineCredentials({ ...credentials, ...(existing?.tools ? { tools: existing.tools } : {}) });
}

export function readHostCredentials(host: string): HostCredentials | undefined {
  const entry = readMachineCredentials()?.tools?.[host];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  return entry;
}

/** One agent's pairing, written without disturbing the others or the top level. */
export function writeHostCredentials(host: string, credentials: HostCredentials): void {
  const existing = readMachineCredentials() ?? {};
  writeMachineCredentials({ ...existing, tools: { ...(existing.tools ?? {}), [host]: credentials } });
}

export function removeHostCredentials(host: string): void {
  const existing = readMachineCredentials();
  if (!existing?.tools || !(host in existing.tools)) return;
  const tools = { ...existing.tools };
  delete tools[host];
  const next: MachineCredentials = { ...existing };
  if (Object.keys(tools).length) next.tools = tools;
  else delete next.tools;
  writeMachineCredentials(next);
}
