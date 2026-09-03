import { AscendaTelemetrySource } from "@ascenda-one/tool-contract";
import { recordWorkContext } from "./contextRegistry";
import { recordForgeProjectAlias } from "./forgeProject";
import { appendEventLog, resolveEventLogPath } from "./eventLog";
import { AscendaEventSender, MappedEvent, buildEventPayload } from "./eventSender";
import { defaultTokenFilePath, persistEventWriteToken, readTokenFile } from "./tokenStore";
import { deriveWorkContext } from "./workContext";

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
  projectHash?: string | null;
  timeoutMs: number;
};

/**
 * Where this work happened, as wire-ready hashes. Env overrides win (a CI or
 * privacy-conscious setup can pin or suppress the identity); otherwise both
 * are derived from the working directory by the shared rule in workContext.ts,
 * and the labels land in the local registry so the digests stay nameable on
 * this machine. Hook adapters run IN the project directory, so the process cwd
 * is the honest default.
 */
export function resolveContextHashes(cwd?: string | null): { workspaceHash: string | null; projectHash: string | null } {
  // An empty or whitespace variable is "unset", not "override with nothing".
  const workspaceOverride = process.env.ASCENDA_WORKSPACE_HASH?.trim() || null;
  const projectOverride = process.env.ASCENDA_PROJECT_HASH?.trim() || null;
  if (workspaceOverride && projectOverride) return { workspaceHash: workspaceOverride, projectHash: projectOverride };

  const context = deriveWorkContext(cwd ?? process.cwd());
  if (context) {
    recordWorkContext(context);
    // The same repository as a forge sees it, registered beside this one. Local
    // dictionary write only, and silent on every failure — see forgeProject.ts.
    recordForgeProjectAlias(context);
  }
  return {
    workspaceHash: workspaceOverride ?? context?.workspaceHash ?? null,
    projectHash: projectOverride ?? context?.projectHash ?? null
  };
}

export function loadCliAgentConfig(toolType: string, sessionIdFromHook?: string, cwd?: string | null): CliAgentConfig {
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

  const contextHashes = resolveContextHashes(cwd);

  return {
    apiBaseUrl,
    toolInstallationId,
    eventWriteToken,
    tokenFilePath,
    sessionId: process.env.ASCENDA_SESSION_ID ?? sessionIdFromHook ?? null,
    workspaceHash: contextHashes.workspaceHash,
    projectHash: contextHashes.projectHash,
    // Agents await command hooks; fail fast rather than stall the user's turn.
    timeoutMs: parsePositiveInt(process.env.ASCENDA_HTTP_TIMEOUT_MS) ?? 3000
  };
}

export type HookDeliveryOptions = {
  toolType: string;
  source: AscendaTelemetrySource;
  sessionId?: string;
  /** Working directory of the observed work. Defaults to the hook process's own cwd. */
  cwd?: string | null;
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
    config = loadCliAgentConfig(options.toolType, options.sessionId, options.cwd);
  } catch (error) {
    const logFile = resolveEventLogPath();
    if (!logFile) throw error;
    const contextHashes = resolveContextHashes(options.cwd);
    for (const event of events) {
      appendEventLog(logFile, {
        loggedAt: new Date().toISOString(),
        delivery: "not_sent",
        payload: buildEventPayload({
          toolInstallationId: `${options.toolType}:unpaired`,
          source: options.source,
          sessionId: options.sessionId ?? null,
          workspaceHash: contextHashes.workspaceHash,
          projectHash: contextHashes.projectHash
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
    projectHash: config.projectHash,
    timeoutMs: config.timeoutMs
  });

  for (const event of events) {
    const result = await sender.send(event);
    if (result === "accepted") continue;
    if (result === "consent_missing") {
      notice("Ascenda telemetry paused: renew IDE telemetry consent in the Ascenda app.");
    } else if (result === "auth_failed") {
      notice("Ascenda telemetry paused: connection revoked or expired. Re-pair via an Ascenda IDE extension or pairing-sim.");
    } else if (result === "transport_error") {
      notice("Ascenda telemetry paused: the ingest endpoint could not be reached; the event is kept in the outbox. Your work is unaffected.");
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
