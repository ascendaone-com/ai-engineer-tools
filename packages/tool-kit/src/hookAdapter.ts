import { AscendaTelemetrySource } from "@ascenda-one/tool-contract";
import { recordWorkContext } from "./contextRegistry";
import { readHostCredentials } from "./credentials";
import { recordForgeProjectAlias } from "./forgeProject";
import { appendEventLog, resolveEventLogPath } from "./eventLog";
import { AscendaEventSender, MappedEvent, buildEventPayload } from "./eventSender";
import { recordSendOutcome, unresolvedStateFilePath, unresolvedToolInstallationId } from "./stateStore";
import { defaultTokenFilePath, listPersistedToolInstallationIds, persistEventWriteToken, readTokenFile } from "./tokenStore";
import { deriveWorkContext } from "./workContext";

/**
 * Shared runtime for CLI agent hook adapters (Codex, Cursor, Windsurf, Gemini).
 * Each adapter owns only its event mapping; identity resolution, delivery,
 * token rotation, the send journal and the local log behave identically
 * across all of them.
 *
 * Claude Code deliberately does not use this: it predates the shared runtime,
 * carries the intention and debrief invites on its stdout, and resolves its
 * identity from the top level of ~/.ascenda/credentials.json. The resolution
 * *rule* is the same one — environment, then credentials, then the token
 * store — so both answer a Dock-launched editor's empty environment the same
 * way (issue #48).
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
 * Which agent, for the parts of identity that are per host rather than per
 * tool type: the `tools.<host>` entry in the credentials file, and the
 * command a person is told to run when nothing names the installation.
 */
export type CliAgentIdentity = {
  /** The `metadata.host` value and credentials key, e.g. `cursor`. */
  host?: string;
  /** Printed in the not-configured error, e.g. `npx @ascenda-one/cursor-hooks setup`. */
  setupCommand?: string;
};

export type InstallationIdSource = "env" | "credentials" | "disk";

export type ResolvedInstallationId = {
  toolInstallationId: string;
  /** Which of the three places the id was found in — `status` prints this. */
  source: InstallationIdSource;
};

/**
 * Thrown when no source names the installation. Distinct from every other
 * configuration failure because the delivery path journals this one: an
 * attempt that exits without a trace looks, to a doctor or status command,
 * exactly like a collector that never ran — the failure mode that lost
 * twelve hours on 26 Aug 2026.
 */
export class MissingInstallationIdError extends Error {
  /** The token files that were considered — none, or too many to pick from. */
  readonly candidates: readonly string[];
  readonly toolType: string;

  constructor(toolType: string, candidates: readonly string[], setupCommand: string) {
    super(
      candidates.length === 0
        ? `Not configured: no ASCENDA_TOOL_INSTALLATION_ID, no pairing in ~/.ascenda/credentials.json, and no ${toolType} token in ~/.ascenda/tokens/. Run: ${setupCommand}`
        : `Not configured: no ASCENDA_TOOL_INSTALLATION_ID, no pairing in ~/.ascenda/credentials.json, and ${candidates.length} ${toolType} tokens in ~/.ascenda/tokens/ (${candidates.join(", ")}) — refusing to guess. Export ASCENDA_TOOL_INSTALLATION_ID to choose one, or run: ${setupCommand}`
    );
    this.name = "MissingInstallationIdError";
    this.toolType = toolType;
    this.candidates = candidates;
  }
}

/**
 * Which installation this hook is. Most specific first: the environment, then
 * the host's entry in the credentials file written by `setup`, then the token
 * store on disk.
 *
 * The disk fallback exists because a GUI-launched editor never sees a shell
 * rc file, so on macOS the environment is empty in the *normal* case. The id
 * is the token filename, so when exactly one token of this tool type is on
 * disk the answer is unambiguous. Zero or several still throw: minting a
 * guess would either fragment telemetry across identities or attribute one
 * machine's work to another's pairing, and both are worse than a journalled
 * skip. Every CLI agent pairs as `cli_agent`, so "exactly one" means one
 * paired CLI agent on the machine, whichever it is — `metadata.host` still
 * says which agent produced the event.
 */
export function resolveCliAgentInstallationId(toolType: string, identity: CliAgentIdentity = {}): ResolvedInstallationId {
  const fromEnv = process.env.ASCENDA_TOOL_INSTALLATION_ID?.trim();
  if (fromEnv) return { toolInstallationId: qualify(toolType, fromEnv), source: "env" };

  const fromCredentials = identity.host ? readHostCredentials(identity.host)?.toolInstallationId?.trim() : undefined;
  if (fromCredentials) return { toolInstallationId: qualify(toolType, fromCredentials), source: "credentials" };

  const candidates = listPersistedToolInstallationIds(toolType);
  if (candidates.length === 1) return { toolInstallationId: candidates[0], source: "disk" };
  throw new MissingInstallationIdError(toolType, candidates, identity.setupCommand ?? defaultSetupCommand(identity.host));
}

function defaultSetupCommand(host: string | undefined): string {
  return host ? `npx @ascenda-one/${host.replace(/_cli$/, "")}-hooks setup` : "the agent's setup command";
}

function qualify(toolType: string, value: string): string {
  return value.includes(":") ? value : `${toolType}:${value}`;
}

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

/**
 * Resolution order for every field, most specific first: the environment,
 * then the host's credentials entry written by `setup`, then the built-in
 * default. The credentials tier is what lets a hook run with an empty
 * environment; the id has one more tier, the token store — see
 * {@link resolveCliAgentInstallationId}.
 */
export function loadCliAgentConfig(toolType: string, sessionIdFromHook?: string, cwd?: string | null, identity: CliAgentIdentity = {}): CliAgentConfig {
  const credentials = identity.host ? readHostCredentials(identity.host) : undefined;
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? credentials?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const { toolInstallationId } = resolveCliAgentInstallationId(toolType, identity);

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

export type HookDeliveryOptions = CliAgentIdentity & {
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
 *
 * A send that cannot name its installation is journalled before anything
 * else happens, under the tool type's unresolved placeholder. Without that
 * line the journal's last entry stays the last *successful* ship, and a
 * status check reports a healthy collector while every event is lost.
 */
export async function deliverHookEvents(events: MappedEvent[], options: HookDeliveryOptions): Promise<void> {
  if (events.length === 0) return;
  const notice = options.onNotice ?? ((message: string) => console.error(message));

  let config: CliAgentConfig;
  try {
    config = loadCliAgentConfig(options.toolType, options.sessionId, options.cwd, options);
  } catch (error) {
    if (error instanceof MissingInstallationIdError) journalSkippedSend(options.host, error);

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

/**
 * Journals an attempt that could not name its installation, under the tool
 * type's placeholder id — the one journal that needs no id to locate.
 * `consecutiveFailures` and `failingSince` then read as "how many, since
 * when", which is what `status` prints.
 */
function journalSkippedSend(host: string | undefined, error: MissingInstallationIdError): void {
  const who = host ? `${host}: ` : "";
  recordSendOutcome(unresolvedStateFilePath(error.toolType), unresolvedToolInstallationId(error.toolType), "skipped_no_installation_id", {
    detail: error.candidates.length === 0
      ? `${who}no ASCENDA_TOOL_INSTALLATION_ID, no credentials.json pairing, no ${error.toolType} token file`
      : `${who}no ASCENDA_TOOL_INSTALLATION_ID, no credentials.json pairing, ${error.candidates.length} ${error.toolType} token files (${error.candidates.join(", ")})`
  });
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
