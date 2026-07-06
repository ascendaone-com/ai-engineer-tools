import { defaultTokenFilePath, persistEventWriteToken, readTokenFile } from "@ascenda/tool-kit";
import { ASCENDA_TOOL_TYPE } from "./types.js";

export type AscendaHookConfig = {
  apiBaseUrl: string;
  toolInstallationId: string;
  eventWriteToken: string;
  tokenFilePath: string;
  sessionId?: string | null;
  workspaceHash?: string | null;
};

export function loadConfigFromEnv(): AscendaHookConfig {
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
    sessionId: process.env.ASCENDA_SESSION_ID ?? null,
    workspaceHash: process.env.ASCENDA_WORKSPACE_HASH ?? null
  };
}

function normalizeToolInstallationId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes(":")) return trimmed;
  if (trimmed.startsWith("claude_tool_")) return `${ASCENDA_TOOL_TYPE}:${trimmed.slice("claude_tool_".length)}`;
  return `${ASCENDA_TOOL_TYPE}:${trimmed}`;
}
