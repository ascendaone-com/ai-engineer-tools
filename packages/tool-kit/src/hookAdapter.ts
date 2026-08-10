import { AscendaTelemetrySource } from "@ascenda-one/tool-contract";
import { appendEventLog, resolveEventLogPath } from "./eventLog";
import { AscendaEventSender, MappedEvent, buildEventPayload } from "./eventSender";
import { defaultTokenFilePath, persistEventWriteToken, readTokenFile } from "./tokenStore";

/**
 * Shared runtime for CLI agent hook adapters (Codex, Cursor, Windsurf, Gemini).
 * Each adapter owns only its event mapping; identity resolution, delivery,
 * token rotation and the local log behave identically across all of them.
 *
 * Claude Code deliberately does not use this: it has its own `setup` command
 * and resolves identity from ~/.ascenda/credentials.json so its hooks can run
 * with a completely empty environment.
 */
export const DEFAULT_API_BASE_URL = "https://api.ascenda.one";

export type CliAgentConfig = {
  apiBaseUrl: string;
  toolInstallationId: string;
  eventWriteToken: string;
  tokenFilePath: string;
  sessionId?: string | null;
  workspaceHash?: string | null;
  timeoutMs: number;
};

export function loadCliAgentConfig(toolType: string, sessionIdFromHook?: string): CliAgentConfig {
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const toolInstallationIdRaw = process.env.ASCENDA_TOOL_INSTALLATION_ID;
  if (!toolInstallationIdRaw) throw new Error("Missing ASCENDA_TOOL_INSTALLATION_ID");

  const toolInstallationId = toolInstallationIdRaw.trim().includes(":")
    ? toolInstallationIdRaw.trim()
    : `${toolType}:${toolInstallationIdRaw.trim()}`;

  const tokenFilePath = process.env.ASCENDA_EVENT_WRITE_TOKEN_FILE ?? defaultTokenFilePath(toolInstallationId);
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
    // Agents await command hooks; fail fast rather than stall the user's turn.
    timeoutMs: parsePositiveInt(process.env.ASCENDA_HTTP_TIMEOUT_MS) ?? 3000
  };
}

export type HookDeliveryOptions = {
  toolType: string;
  source: AscendaTelemetrySource;
  sessionId?: string;
  /** Surfaced to the user by agents that render hook stdout; defaults to stderr. */
  onNotice?: (message: string) => void;
};

/**
 * Send mapped events, or — when the install is not paired and a local log is
 * configured — record what would have been sent. Returns silently either way;
 * a telemetry problem is never the user's problem.
 */
export async function deliverHookEvents(events: MappedEvent[], options: HookDeliveryOptions): Promise<void> {
  if (events.length === 0) return;
  const notice = options.onNotice ?? ((message: string) => console.error(message));

  let config: CliAgentConfig;
  try {
    config = loadCliAgentConfig(options.toolType, options.sessionId);
  } catch (error) {
    const logFile = resolveEventLogPath();
    if (!logFile) throw error;
    for (const event of events) {
      appendEventLog(logFile, {
        loggedAt: new Date().toISOString(),
        delivery: "not_sent",
        payload: buildEventPayload({
          toolInstallationId: `${options.toolType}:unpaired`,
          source: options.source,
          sessionId: options.sessionId ?? null,
          workspaceHash: process.env.ASCENDA_WORKSPACE_HASH ?? null
        }, event)
      });
    }
    return;
  }

  const sender = new AscendaEventSender({
    apiBaseUrl: config.apiBaseUrl,
    toolInstallationId: config.toolInstallationId,
    source: options.source,
    eventWriteToken: config.eventWriteToken,
    tokenFilePath: config.tokenFilePath,
    sessionId: config.sessionId,
    workspaceHash: config.workspaceHash,
    timeoutMs: config.timeoutMs
  });

  for (const event of events) {
    const result = await sender.send(event);
    if (result === "accepted") continue;
    if (result === "consent_missing") {
      notice("Ascenda telemetry paused: renew IDE telemetry consent in the Ascenda app.");
    } else if (result === "auth_failed") {
      notice("Ascenda telemetry paused: connection revoked or expired. Re-pair via an Ascenda IDE extension or pairing-sim.");
    } else {
      notice(`Ascenda telemetry rejected: ${result}`);
    }
    return;
  }
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
