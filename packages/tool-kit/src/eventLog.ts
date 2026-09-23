import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AscendaEventPayload, IngestResult } from "@ascenda-one/tool-contract";
import { readMachineCredentials } from "./credentials";

/**
 * Opt-in local sink: one JSON object per line, holding the exact payload that
 * was put on the wire plus how delivery went. Two jobs, both of which the
 * ingest path cannot do — see what a tool emits with no backend running, and
 * audit what actually left the machine against the metadata-only claim.
 *
 * Off unless ASCENDA_EVENT_LOG_FILE is set, or `eventLogPath` is persisted in
 * ~/.ascenda/credentials.json (see {@link resolveEventLogPath}). Nothing here
 * may throw: a sink that can break telemetry, or the user's turn, is worse
 * than no sink.
 */
export const EVENT_LOG_ENV_VAR = "ASCENDA_EVENT_LOG_FILE";

/** Rotate at 5 MB — roughly 20k events, weeks of normal use. */
const MAX_BYTES = 5 * 1024 * 1024;

export type EventLogEntry = {
  loggedAt: string;
  delivery: IngestResult | "not_sent";
  payload: AscendaEventPayload;
  /**
   * Set when the outbox was involved: `queued` means this attempt failed and
   * the payload was kept for a later drain (so a `transport_error` line is
   * not a lost event); `drained` means this line is that later delivery.
   */
  outbox?: "queued" | "drained";
};

/**
 * `~` is expanded here rather than left to the shell: hook commands and editor
 * settings never pass through one, so a configured `~/logs/events.jsonl` would
 * otherwise create a literal `~` directory next to the project.
 */
export function expandUserPath(configured: string | undefined): string | undefined {
  const value = configured?.trim();
  if (!value) return undefined;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

/**
 * Env var first, then the path (if any) `setup`/`pair` persisted to
 * `~/.ascenda/credentials.json` — the same fallback the IDE extension's
 * `ascenda.eventLogFile` setting already uses, and for the same reason: a
 * process spawned with no shell environment (a Desktop-app hook, a
 * GUI-launched editor) never sees an rc-file export, so the env var alone
 * left exactly those sessions unable to turn this on. Checking the file
 * costs one read per hook invocation and is never itself a reason to enable
 * logging — an absent or unreadable file resolves to `undefined`, same as
 * today.
 */
export function resolveEventLogPath(): string | undefined {
  return expandUserPath(process.env[EVENT_LOG_ENV_VAR]) ?? expandUserPath(readMachineCredentials()?.eventLogPath);
}

export type EventLogSource = "env" | "credentials" | "off";

/** Which of the two sources above is active, for `doctor`/`status` to name. */
export function resolveEventLogSource(): EventLogSource {
  if (expandUserPath(process.env[EVENT_LOG_ENV_VAR])) return "env";
  if (expandUserPath(readMachineCredentials()?.eventLogPath)) return "credentials";
  return "off";
}

export function appendEventLog(logFilePath: string, entry: EventLogEntry): void {
  try {
    rotateIfLarge(logFilePath);
    const dir = path.dirname(logFilePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Agent hooks are separate processes and overlap (PreToolUse and the
    // previous PostToolUse can race). O_APPEND makes a single write atomic up
    // to PIPE_BUF, and a metadata-only line is a few hundred bytes, so lines
    // interleave only if a caller stuffs an unusually large metadata bag in.
    fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(logFilePath, 0o600);
  } catch {
    // Unwritable path, full disk, read-only mount: the event still shipped.
  }
}

/**
 * One generation only. The log is a debugging and audit aid, not a durable
 * record — the backend holds that — so bounding disk use matters more than
 * keeping history.
 */
function rotateIfLarge(logFilePath: string): void {
  try {
    if (fs.statSync(logFilePath).size < MAX_BYTES) return;
    fs.renameSync(logFilePath, `${logFilePath}.1`);
  } catch {
    // Missing file is the common case on the first write.
  }
}
