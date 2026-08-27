import { defaultStateFilePath, defaultTokenFilePath, persistEventWriteToken, readTokenFile } from "@ascenda-one/tool-kit";
import { readCredentials } from "./paths.js";
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
 */
export function resolveStateFilePath(toolInstallationId: string): string {
  return process.env.ASCENDA_STATE_FILE ?? defaultStateFilePath(toolInstallationId);
}

/**
 * Resolution order, most specific first: environment, then the machine
 * credentials written by `setup`, then the built-in default. The credentials
 * fallback is what lets a hook run with an empty environment.
 */
export function loadConfigFromEnv(): AscendaHookConfig {
  const credentials = readCredentials();
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? credentials?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const toolInstallationIdRaw = process.env.ASCENDA_TOOL_INSTALLATION_ID ?? credentials?.toolInstallationId;
  if (!toolInstallationIdRaw) {
    throw new Error("Not configured: no ASCENDA_TOOL_INSTALLATION_ID and no pairing in ~/.ascenda/credentials.json. Run: npx @ascenda-one/claude-code-hooks setup");
  }

  const toolInstallationId = normalizeToolInstallationId(toolInstallationIdRaw);
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
