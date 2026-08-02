import { defaultTokenFilePath, persistEventWriteToken, readTokenFile } from "@ascenda-one/tool-kit";

export const ASCENDA_TOOL_TYPE = "github_collector";

export type ForgeCollectorConfig = {
  apiBaseUrl: string;
  toolInstallationId: string;
  eventWriteToken: string;
  tokenFilePath: string;
  viewerLogin: string;
};

export function loadConfigFromEnv(): ForgeCollectorConfig {
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? "https://api.ascenda.one").replace(/\/$/, "");

  const toolInstallationIdRaw = process.env.ASCENDA_TOOL_INSTALLATION_ID;
  if (!toolInstallationIdRaw) throw new Error("Missing ASCENDA_TOOL_INSTALLATION_ID");
  const toolInstallationId = normalizeToolInstallationId(toolInstallationIdRaw);

  // The whole collector is first-person, so without knowing who "I" am there
  // is nothing it may legitimately emit. Failing here is the point: defaulting
  // to the payload's actor would silently start recording other people.
  const viewerLogin = process.env.ASCENDA_FORGE_LOGIN?.trim();
  if (!viewerLogin) {
    throw new Error(
      "Missing ASCENDA_FORGE_LOGIN — the collector only ever emits your own " +
      "review activity, so it cannot run without knowing whose it is."
    );
  }

  const tokenFilePath = process.env.ASCENDA_EVENT_WRITE_TOKEN_FILE
    ?? defaultTokenFilePath(toolInstallationId);

  const fileToken = readTokenFile(tokenFilePath);
  const eventWriteToken = fileToken ?? process.env.ASCENDA_EVENT_WRITE_TOKEN;
  if (!eventWriteToken) throw new Error("Missing ASCENDA_EVENT_WRITE_TOKEN (or token file)");
  if (!fileToken) persistEventWriteToken(tokenFilePath, eventWriteToken);

  return { apiBaseUrl, toolInstallationId, eventWriteToken, tokenFilePath, viewerLogin };
}

function normalizeToolInstallationId(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes(":") ? trimmed : `${ASCENDA_TOOL_TYPE}:${trimmed}`;
}
