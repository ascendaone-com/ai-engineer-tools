import { AscendaTelemetrySource } from "@ascenda-one/tool-contract";
import { recordWorkContext } from "./contextRegistry";
import { isLocalOnlyHostInstall, readHostCredentials } from "./credentials";
import { recordForgeProjectAlias } from "./forgeProject";
import { appendEventLog, resolveEventLogPath } from "./eventLog";
import { deriveForgeKeysForCwd } from "./forgeKeys";
import { AscendaEventSender, MappedEvent, buildEventPayload } from "./eventSender";
import { readCollectorState, recordSendOutcome, unresolvedStateFilePath, unresolvedToolInstallationId } from "./stateStore";
import { hookDeliveryInline, runOutboxFlush, startBackgroundFlush } from "./backgroundDelivery";
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
 * store on disk. Qualified ids must belong to this tool type: a shell-wide
 * Claude Code override must not redirect CLI-agent events to its pairing.
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
  if (fromEnv && belongsToToolType(toolType, fromEnv)) return { toolInstallationId: qualify(toolType, fromEnv), source: "env" };

  const fromCredentials = identity.host ? readHostCredentials(identity.host)?.toolInstallationId?.trim() : undefined;
  if (fromCredentials && belongsToToolType(toolType, fromCredentials)) return { toolInstallationId: qualify(toolType, fromCredentials), source: "credentials" };

  const candidates = listPersistedToolInstallationIds(toolType);
  if (candidates.length === 1) return { toolInstallationId: candidates[0], source: "disk" };
  throw new MissingInstallationIdError(toolType, candidates, identity.setupCommand ?? defaultSetupCommand(identity.host));
}

function defaultSetupCommand(host: string | undefined): string {
  return host ? `npx @ascenda-one/${host.replace(/_cli$/, "")}-hooks setup` : "the agent's setup command";
}

function belongsToToolType(toolType: string, value: string): boolean {
  return !value.includes(":") || value.startsWith(`${toolType}:`);
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
  const pairing = loadCliAgentPairing(toolType, identity);
  const contextHashes = resolveContextHashes(cwd);

  return {
    ...pairing,
    // An empty ASCENDA_SESSION_ID is "unset", not "override with nothing":
    // read raw, `ASCENDA_SESSION_ID=""` beat a real hook session and shipped
    // an empty string, grouping unrelated rows under a value naming no session.
    sessionId: process.env.ASCENDA_SESSION_ID?.trim() || sessionIdFromHook || null,
    workspaceHash: contextHashes.workspaceHash,
    projectHash: contextHashes.projectHash
  };
}

/**
 * Where to send and with what, and nothing about the work: all an outbox
 * flusher needs, since every queued payload already carries its own session
 * and context. Kept apart so a flusher doesn't repeat the hook's git lookups.
 */
function loadCliAgentPairing(toolType: string, identity: CliAgentIdentity): Pick<CliAgentConfig, "apiBaseUrl" | "toolInstallationId" | "eventWriteToken" | "tokenFilePath" | "timeoutMs"> {
  const credentials = identity.host ? readHostCredentials(identity.host) : undefined;
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? credentials?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const { toolInstallationId } = resolveCliAgentInstallationId(toolType, identity);

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
  /**
   * The prompt id the collector minted for the turn in progress, for agents
   * that give none. Stamped on every event that doesn't already carry one.
   */
  promptId?: string;
  /**
   * Stamp `repoKey` and `branchKey` from {@link cwd} (or the process's own
   * directory). For adapters whose mapper doesn't derive them itself. The
   * machine's switch and the limits in forgeKeys.ts apply.
   */
  forgeKeys?: boolean;
};

/** The events with the repository and branch keys for `cwd` set on each, unless an event has its own. */
export function withForgeKeys<T extends { metadata?: Record<string, unknown> }>(events: T[], cwd: string | null | undefined): T[] {
  const keys = deriveForgeKeysForCwd(cwd ?? process.cwd());
  if (!keys.repoKey) return events;
  return events.map((event) => ({ ...event, metadata: { ...keys, ...event.metadata } }));
}

/** The events with `promptId` set on each, unless an event brought its own. */
export function withPromptId<T extends { metadata?: Record<string, unknown> }>(events: T[], promptId: string | undefined): T[] {
  if (!promptId) return events;
  return events.map((event) => ({ ...event, metadata: { promptId, ...event.metadata } }));
}

/**
 * Send mapped events, or, when the install is not paired, record what would
 * have been sent in the local event log. Returns silently either way;
 * a telemetry problem is never the user's problem.
 *
 * A send that cannot name its installation is journalled before anything
 * else happens, under the tool type's unresolved placeholder. Without that
 * line the journal's last entry stays the last *successful* ship, and a
 * status check reports a healthy collector while every event is lost.
 */
export async function deliverHookEvents(events: MappedEvent[], options: HookDeliveryOptions): Promise<void> {
  if (events.length === 0) return;
  events = withPromptId(events, options.promptId);
  if (options.forgeKeys) events = withForgeKeys(events, options.cwd);
  const notice = options.onNotice ?? ((message: string) => console.error(message));

  // An install that was asked not to pair has nothing to deliver with, and
  // that is not a fault worth reporting: without this it journals a skipped
  // send on every event for the life of the install, and `doctor` reads a
  // chosen state as a broken one. The live signal to a socket on this
  // machine has already run by the time we reach here. What's left is the
  // local event log, which is on by default for exactly this install.
  const hasToken = (id: string) =>
    readTokenFile(process.env.ASCENDA_EVENT_WRITE_TOKEN_FILE ?? defaultTokenFilePath(id)) !== undefined;
  if (options.host && isLocalOnlyHostInstall(options.host, hasToken)) {
    const logFile = resolveEventLogPath({ localOnly: true });
    if (logFile) logUnsent(logFile, events, options);
    return;
  }

  let config: CliAgentConfig;
  try {
    config = loadCliAgentConfig(options.toolType, options.sessionId, options.cwd, options);
  } catch (error) {
    if (error instanceof MissingInstallationIdError) journalSkippedSend(options.host, error);

    const logFile = resolveEventLogPath();
    if (!logFile) throw error;
    logUnsent(logFile, events, options);
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

  if (hookDeliveryInline()) {
    for (const event of events) {
      const result = await sender.send(event);
      if (result === "accepted") continue;
      const message = noticeFor(result);
      if (message) notice(message);
      return;
    }
    return;
  }

  // Into the outbox and back to the agent; a detached flusher sends it. See
  // backgroundDelivery.ts. The notice comes from the journal the last flush
  // wrote, so an outage is reported one hook later than an inline send would.
  for (const event of events) sender.queue(event);
  startBackgroundFlush({ outboxFilePath: sender.outboxFilePath() });
  const last = readCollectorState(sender.stateFilePath())?.lastOutcome;
  const message = last ? noticeFor(last) : undefined;
  if (message) notice(message);
}

/** The line a user sees for a send that isn't getting through, or none for one that is. */
function noticeFor(result: string): string | undefined {
  if (result === "accepted" || result === "duplicate") return undefined;
  if (result === "consent_missing") return "Ascenda telemetry paused: renew IDE telemetry consent in the Ascenda app.";
  if (result === "auth_failed") return "Ascenda telemetry paused: connection revoked or expired. Re-pair via an Ascenda IDE extension or pairing-sim.";
  if (result === "transport_error") return "Ascenda telemetry paused: the ingest endpoint could not be reached; the event is kept in the outbox. Your work is unaffected.";
  if (result === "outbox_discarded") return undefined;
  return `Ascenda telemetry rejected: ${result}`;
}

/**
 * What a hook binary runs when started with `OUTBOX_FLUSH_COMMAND`: load the
 * same pairing the hook used and drain its outbox. Silent either way. An
 * install with no pairing has no outbox to drain.
 */
export async function flushHookOutbox(options: Pick<HookDeliveryOptions, "toolType" | "source" | "host" | "setupCommand">): Promise<void> {
  let config: ReturnType<typeof loadCliAgentPairing>;
  try {
    config = loadCliAgentPairing(options.toolType, options);
  } catch {
    return;
  }
  const sender = new AscendaEventSender({
    apiBaseUrl: config.apiBaseUrl,
    toolInstallationId: config.toolInstallationId,
    source: options.source,
    eventWriteToken: config.eventWriteToken,
    tokenFilePath: config.tokenFilePath,
    timeoutMs: config.timeoutMs
  });
  await runOutboxFlush(sender);
}

/**
 * Records events no send was attempted for, because this install has no
 * pairing or none could be resolved. The id is a placeholder because there
 * is no pairing to name: `not_sent` plus this value is what tells these
 * lines from delivered ones.
 */
function logUnsent(logFile: string, events: MappedEvent[], options: HookDeliveryOptions): void {
  const contextHashes = resolveContextHashes(options.cwd);
  for (const event of events) {
    appendEventLog(logFile, {
      loggedAt: new Date().toISOString(),
      delivery: "not_sent",
      payload: buildEventPayload({
        toolInstallationId: `${options.toolType}:unpaired`,
        source: options.source,
        sessionId: process.env.ASCENDA_SESSION_ID?.trim() || options.sessionId || null,
        workspaceHash: contextHashes.workspaceHash,
        projectHash: contextHashes.projectHash
      }, event)
    });
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
