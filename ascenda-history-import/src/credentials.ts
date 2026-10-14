/**
 * Where the importer gets its identity and write token.
 *
 * Most specific first: explicit flags, then the environment (the only source
 * before this file existed, and unchanged), then what the hook packages'
 * `setup` and `pair` left in `~/.ascenda`. The last step is what lets a
 * machine with no Flow app and no exported variables run
 * `ascenda-history-import import --ship` straight after pairing.
 *
 * The token is renewed through the same contract and the same token file the
 * hooks use. There is no second token store here, so a renewal done by the
 * importer is picked up by the hooks and the other way round.
 */
import {
  TOKEN_RENEW_LEAD_MS,
  ascendaHome,
  defaultTokenFilePath,
  listPersistedToolInstallationIds,
  persistEventWriteToken,
  readHostCredentials,
  readMachineCredentials,
  readTokenExpiry,
  readTokenFile,
  renewToolToken
} from "@ascenda-one/tool-kit";

export const DEFAULT_API_BASE_URL = "https://api.ascenda.one";

export interface ShipConfig {
  apiBaseUrl: string;
  toolInstallationId: string;
  eventWriteToken: string;
  /** Where the token lives, when it came from a file. Renewals are written back here. */
  tokenFilePath?: string;
}

export interface ShipFlags {
  installationId?: string;
  tokenFile?: string;
  apiBaseUrl?: string;
}

export type ConfigSource = "flag" | "env" | "credentials" | "disk";

export class ShipConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipConfigError";
  }
}

/** The tool types the hook packages pair as, for the re-pair hint. */
function pairCommand(toolInstallationId: string): string {
  const type = toolInstallationId.split(":")[0];
  return type === "claude_code"
    ? "npx @ascenda-one/claude-code-hooks pair"
    : `npx @ascenda-one/claude-code-hooks pair --tool-type ${type}`;
}

function normalizeId(raw: string): string {
  const id = raw.trim();
  return id.includes(":") ? id : `claude_code:${id}`;
}

const SETUP_HINT = "Run: npx @ascenda-one/claude-code-hooks setup";

/**
 * Which installation to ship as. Flag, env, the top-level pairing the Claude
 * Code `setup` writes, a lone `tools.<host>` pairing that has a token, then a
 * lone claude_code token on disk. Two candidates at the same step are
 * ambiguous and stop the run: shipping a machine's history under the wrong
 * pairing attributes it to the wrong tool, and nothing can undo that.
 */
function resolveInstallationId(flags: ShipFlags): { id: string; source: ConfigSource } {
  if (flags.installationId?.trim()) return { id: normalizeId(flags.installationId), source: "flag" };
  const fromEnv = process.env.ASCENDA_TOOL_INSTALLATION_ID?.trim();
  if (fromEnv) return { id: normalizeId(fromEnv), source: "env" };

  const credentials = readMachineCredentials();
  const top = credentials?.toolInstallationId?.trim();
  if (top && !credentials?.localOnly) return { id: normalizeId(top), source: "credentials" };

  const hostIds = Object.keys(credentials?.tools ?? {})
    .map((host) => readHostCredentials(host)?.toolInstallationId?.trim())
    .filter((id): id is string => Boolean(id) && Boolean(readTokenFile(defaultTokenFilePath(id as string))));
  if (hostIds.length === 1) return { id: normalizeId(hostIds[0]), source: "credentials" };
  if (hostIds.length > 1) {
    throw new ShipConfigError(
      `${hostIds.length} paired tools in ~/.ascenda/credentials.json (${hostIds.join(", ")}) and no way to choose. ` +
        "Pass --installation-id <id> or set ASCENDA_TOOL_INSTALLATION_ID."
    );
  }

  const onDisk = listPersistedToolInstallationIds("claude_code");
  if (onDisk.length === 1) return { id: onDisk[0], source: "disk" };
  if (onDisk.length > 1) {
    throw new ShipConfigError(
      `${onDisk.length} claude_code tokens in ${ascendaHome()}/tokens (${onDisk.join(", ")}). ` +
        "Pass --installation-id <id> to choose one."
    );
  }

  if (credentials?.localOnly) {
    throw new ShipConfigError(
      "This machine was set up without pairing (local only), so there is nothing to ship as. " +
        `Pair it first: ${pairCommand("claude_code:x")}`
    );
  }
  throw new ShipConfigError(
    "No paired tool found: no --installation-id, no ASCENDA_TOOL_INSTALLATION_ID, nothing in " +
      `${ascendaHome()}/credentials.json and no token in ${ascendaHome()}/tokens. ${SETUP_HINT}`
  );
}

export function loadShipConfig(flags: ShipFlags = {}): ShipConfig {
  const { id: toolInstallationId } = resolveInstallationId(flags);
  const credentials = readMachineCredentials();
  const apiBaseUrl = (
    flags.apiBaseUrl ??
    process.env.ASCENDA_API_BASE_URL ??
    credentials?.apiBaseUrl ??
    DEFAULT_API_BASE_URL
  ).replace(/\/$/, "");

  const tokenFilePath =
    flags.tokenFile ?? process.env.ASCENDA_EVENT_WRITE_TOKEN_FILE ?? defaultTokenFilePath(toolInstallationId);
  const eventWriteToken = readTokenFile(tokenFilePath) ?? process.env.ASCENDA_EVENT_WRITE_TOKEN?.trim();
  if (!eventWriteToken) {
    throw new ShipConfigError(
      `No event write token for ${toolInstallationId}: nothing at ${tokenFilePath} and ASCENDA_EVENT_WRITE_TOKEN is unset. ` +
        `Pair it: ${pairCommand(toolInstallationId)}`
    );
  }
  return {
    apiBaseUrl,
    toolInstallationId,
    eventWriteToken,
    ...(readTokenFile(tokenFilePath) ? { tokenFilePath } : {})
  };
}

export interface PrepareTokenOptions {
  now?: () => number;
  renew?: typeof renewToolToken;
  /** Renew when less than this is left. Defaults to the hooks' own lead. */
  leadMs?: number;
}

export interface PrepareTokenResult {
  config: ShipConfig;
  /** One line to print, or null when the token needed nothing. */
  note: string | null;
}

/**
 * Makes sure the token is good for the shipment. Inside the renewal window it
 * is rotated through `/v1/tool-events/renew-token` and written back to the
 * hooks' token file. Past expiry the server won't renew it, so this throws a
 * {@link ShipConfigError} that says how to pair again.
 *
 * A renewal that can't reach the server is not fatal while the old token is
 * still valid: the shipment goes ahead on it.
 */
export async function prepareToken(config: ShipConfig, options: PrepareTokenOptions = {}): Promise<PrepareTokenResult> {
  const now = options.now ?? Date.now;
  const lead = options.leadMs ?? TOKEN_RENEW_LEAD_MS;
  // A token handed over in the environment has no file to write a rotation to
  // and no age to read, so it is used as given.
  if (!config.tokenFilePath) return { config, note: null };

  const expiresAt = readTokenExpiry(config.tokenFilePath);
  if (expiresAt === undefined) return { config, note: null };
  if (now() >= expiresAt) {
    throw new ShipConfigError(
      `The event token for ${config.toolInstallationId} expired on ${new Date(expiresAt).toISOString().slice(0, 10)}, ` +
        `and an expired token can't renew itself. Pair again: ${pairCommand(config.toolInstallationId)}`
    );
  }
  if (now() < expiresAt - lead) return { config, note: null };

  const renew = options.renew ?? renewToolToken;
  try {
    const renewed = await renew(config.apiBaseUrl, config.eventWriteToken, AbortSignal.timeout(15_000));
    if (!renewed) {
      // The server refused a token we think is live. A hook may have rotated
      // it first, which revokes this copy but leaves the new one on disk.
      const onDisk = readTokenFile(config.tokenFilePath);
      if (onDisk && onDisk !== config.eventWriteToken) {
        return { config: { ...config, eventWriteToken: onDisk }, note: "token already renewed by another process" };
      }
      throw new ShipConfigError(
        `The server rejected the event token for ${config.toolInstallationId} when renewing it. ` +
          `Pair again: ${pairCommand(config.toolInstallationId)}`
      );
    }
    persistEventWriteToken(config.tokenFilePath, renewed.eventWriteToken, renewed.expiresAt);
    return {
      config: { ...config, eventWriteToken: renewed.eventWriteToken },
      note: `renewed the event token (now valid until ${renewed.expiresAt.slice(0, 10)})`
    };
  } catch (error) {
    if (error instanceof ShipConfigError) throw error;
    return { config, note: "couldn't renew the event token (server unreachable); using the current one" };
  }
}
