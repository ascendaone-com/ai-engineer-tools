import { defaultTokenFilePath, persistEventWriteToken, readTokenFile } from "@ascenda/tool-kit";
import { ASCENDA_TOOL_TYPE } from "./types.js";

export type AscendaCodexConfig = {
  apiBaseUrl: string;
  toolInstallationId: string;
  eventWriteToken: string;
  tokenFilePath: string;
  sessionId?: string | null;
  workspaceHash?: string | null;
  timeoutMs: number;
};

export function loadConfigFromEnv(sessionIdFromHook?: string): AscendaCodexConfig {
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? "https://api.ascenda.one").replace(/\/$/, "");
  const toolInstallationIdRaw = process.env.ASCENDA_TOOL_INSTALLATION_ID;
  if (!toolInstallationIdRaw) throw new Error("Missing ASCENDA_TOOL_INSTALLATION_ID");

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
    sessionId: process.env.ASCENDA_SESSION_ID ?? sessionIdFromHook ?? null,
    workspaceHash: process.env.ASCENDA_WORKSPACE_HASH ?? null,
    // Codex awaits command hooks; fail fast rather than stall the agent's turn.
    timeoutMs: parsePositiveInt(process.env.ASCENDA_HTTP_TIMEOUT_MS) ?? 3000
  };
}

function normalizeToolInstallationId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes(":")) return trimmed;
  return `${ASCENDA_TOOL_TYPE}:${trimmed}`;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
