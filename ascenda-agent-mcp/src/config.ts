import { defaultTokenFilePath, persistEventWriteToken, readTokenFile } from "@ascenda-one/tool-kit";
import { randomUUID } from "node:crypto";

export type AscendaMcpConfig = {
  apiBaseUrl: string;
  toolInstallationId: string;
  eventWriteToken: string;
  tokenFilePath: string;
  /**
   * Stable for the life of this server process — every semantic event a
   * skill emits during one Claude Code / Cursor session shares it, so the
   * backend can group them into one session's trajectory.
   */
  sessionId: string;
  workspaceHash?: string | null;
};

/**
 * Unlike the hook CLIs (one process per invocation, one tool type each),
 * this server is long-lived and host-agnostic — the same binary runs under
 * Claude Code, Cursor, or anything else that can launch an MCP server. It
 * therefore does **not** mint a tool-type prefix the way
 * `ascenda-claude-code-hooks`/`ascenda-codex-hooks` do: minting one here
 * would pair this process as a *third* tool even when the same physical
 * installation already paired through a hook or an IDE extension, silently
 * fragmenting one person's telemetry across multiple tool identities.
 *
 * The user is expected to reuse the fully-qualified id already shown by
 * their existing pairing (`ascenda-claude-hook doctor`-equivalent output,
 * or the extension's "Ascenda: Show Status" command) — an id that already
 * contains `:`. An unqualified value is refused rather than guessed.
 */
export function loadConfigFromEnv(): AscendaMcpConfig {
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? "https://api.ascenda.one").replace(/\/$/, "");

  const toolInstallationId = process.env.ASCENDA_TOOL_INSTALLATION_ID?.trim();
  if (!toolInstallationId) {
    throw new Error("Missing ASCENDA_TOOL_INSTALLATION_ID");
  }
  if (!toolInstallationId.includes(":")) {
    throw new Error(
      "ASCENDA_TOOL_INSTALLATION_ID must be the fully-qualified id from your existing pairing " +
        '(e.g. "claude_code:abc123"), not a bare id. This server reuses an existing pairing rather ' +
        "than minting a new one — copy the value your hook adapter or IDE extension already shows."
    );
  }

  const tokenFilePath = process.env.ASCENDA_EVENT_WRITE_TOKEN_FILE ?? defaultTokenFilePath(toolInstallationId);
  const fileToken = readTokenFile(tokenFilePath);
  const eventWriteToken = fileToken ?? process.env.ASCENDA_EVENT_WRITE_TOKEN;
  if (!eventWriteToken) {
    throw new Error("Missing ASCENDA_EVENT_WRITE_TOKEN (or token file) — pair this tool installation first.");
  }
  if (!fileToken) persistEventWriteToken(tokenFilePath, eventWriteToken);

  return {
    apiBaseUrl,
    toolInstallationId,
    eventWriteToken,
    tokenFilePath,
    sessionId: process.env.ASCENDA_SESSION_ID ?? randomUUID(),
    workspaceHash: process.env.ASCENDA_WORKSPACE_HASH ?? null
  };
}
