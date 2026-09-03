import {
  defaultStateFilePath,
  defaultTokenFilePath,
  listPersistedToolInstallationIds,
  persistEventWriteToken,
  readTokenFile,
  unresolvedStateFilePath
} from "@ascenda-one/tool-kit";
import { MachineCredentials, readCredentials } from "./paths.js";
import { ASCENDA_TOOL_TYPE } from "./types.js";

export const DEFAULT_API_BASE_URL = "https://api.ascenda.one";

export type AscendaHookConfig = {
  apiBaseUrl: string;
  toolInstallationId: string;
  eventWriteToken: string;
  tokenFilePath: string;
  stateFilePath: string;
  sessionId?: string | null;
  workspaceHash?: string | null;
  projectHash?: string | null;
};

/**
 * Where the send journal lives for a given installation, resolved the same way
 * whether or not a token exists. `doctor` and the failure notice both need this
 * path when {@link loadConfigFromEnv} would throw — an unpaired or rejected
 * installation is precisely when someone wants to read the journal.
 *
 * With no id at all, the path is the tool type's unresolved-installation
 * journal: an attempt that could not name its installation still has to be
 * written somewhere `doctor` will look, and needs no id to get there.
 */
export function resolveStateFilePath(toolInstallationId?: string): string {
  return process.env.ASCENDA_STATE_FILE
    ?? (toolInstallationId ? defaultStateFilePath(toolInstallationId) : unresolvedStateFilePath(ASCENDA_TOOL_TYPE));
}

export type InstallationIdSource = "env" | "credentials" | "disk";

export type ResolvedInstallationId = {
  toolInstallationId: string;
  /** Which of the three places the id was found in — `doctor` prints this. */
  source: InstallationIdSource;
};

/**
 * Thrown when no source names the installation. Distinct from every other
 * configuration failure because the hook journals this one: an attempt that
 * exits here without a trace looks, to `doctor`, exactly like a collector
 * that never ran — the failure mode that lost twelve hours on 26 Aug 2026.
 */
export class MissingInstallationIdError extends Error {
  /** The token files that were considered — none, or too many to pick from. */
  readonly candidates: readonly string[];

  constructor(candidates: readonly string[]) {
    super(
      candidates.length === 0
        ? "Not configured: no ASCENDA_TOOL_INSTALLATION_ID, no pairing in ~/.ascenda/credentials.json, and no claude_code token in ~/.ascenda/tokens/. Run: npx @ascenda-one/claude-code-hooks setup"
        : `Not configured: no ASCENDA_TOOL_INSTALLATION_ID, no pairing in ~/.ascenda/credentials.json, and ${candidates.length} claude_code tokens in ~/.ascenda/tokens/ (${candidates.join(", ")}) — refusing to guess. Export ASCENDA_TOOL_INSTALLATION_ID to choose one, or run: npx @ascenda-one/claude-code-hooks setup`
    );
    this.name = "MissingInstallationIdError";
    this.candidates = candidates;
  }
}

/**
 * Which installation this hook is. Most specific first: the environment, then
 * the credentials written by `setup`, then the token store on disk.
 *
 * The disk fallback exists because a GUI-launched editor never sees a shell
 * rc file, so on macOS the environment is empty in the *normal* case. The id
 * is the token filename, so when exactly one token of this tool type is on
 * disk the answer is unambiguous. Zero or several still throw: minting a
 * guess would either fragment telemetry across identities or attribute one
 * machine's work to another's pairing, and both are worse than a journalled
 * skip.
 */
export function resolveToolInstallationId(credentials: MachineCredentials | undefined = readCredentials()): ResolvedInstallationId {
  const fromEnv = process.env.ASCENDA_TOOL_INSTALLATION_ID?.trim();
  if (fromEnv) return { toolInstallationId: normalizeToolInstallationId(fromEnv), source: "env" };

  const fromCredentials = credentials?.toolInstallationId?.trim();
  if (fromCredentials) return { toolInstallationId: normalizeToolInstallationId(fromCredentials), source: "credentials" };

  const candidates = listPersistedToolInstallationIds(ASCENDA_TOOL_TYPE);
  if (candidates.length === 1) return { toolInstallationId: candidates[0], source: "disk" };
  throw new MissingInstallationIdError(candidates);
}

/**
 * Resolution order, most specific first: environment, then the machine
 * credentials written by `setup`, then the built-in default. The credentials
 * fallback is what lets a hook run with an empty environment; the id has one
 * more fallback, the token store — see {@link resolveToolInstallationId}.
 */
export function loadConfigFromEnv(): AscendaHookConfig {
  const credentials = readCredentials();
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? credentials?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const { toolInstallationId } = resolveToolInstallationId(credentials);
  const tokenFilePath = process.env.ASCENDA_EVENT_WRITE_TOKEN_FILE
    ?? defaultTokenFilePath(toolInstallationId);

  const fileToken = readTokenFile(tokenFilePath);
  const eventWriteToken = fileToken ?? process.env.ASCENDA_EVENT_WRITE_TOKEN;
  if (!eventWriteToken) throw new Error("Missing ASCENDA_EVENT_WRITE_TOKEN (or token file)");

  // Seed token file so tool-scoped renew can persist rotations unattended.
  if (!fileToken) persistEventWriteToken(tokenFilePath, eventWriteToken);

  return {
    apiBaseUrl,
    toolInstallationId,
    eventWriteToken,
    tokenFilePath,
    stateFilePath: resolveStateFilePath(toolInstallationId),
    sessionId: process.env.ASCENDA_SESSION_ID ?? null,
    // Overrides only. When unset, main() fills these from the hook payload's
    // own cwd — the payload knows where the work happened; the environment
    // this hook inherits does not have to.
    workspaceHash: envHashOverride("ASCENDA_WORKSPACE_HASH"),
    projectHash: envHashOverride("ASCENDA_PROJECT_HASH")
  };
}

/** An empty or whitespace variable is "unset", not "override with nothing". */
export function envHashOverride(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function normalizeToolInstallationId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes(":")) return trimmed;
  if (trimmed.startsWith("claude_tool_")) return `${ASCENDA_TOOL_TYPE}:${trimmed.slice("claude_tool_".length)}`;
  return `${ASCENDA_TOOL_TYPE}:${trimmed}`;
}
