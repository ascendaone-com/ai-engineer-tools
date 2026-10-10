import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentEventV0 } from "@ascenda-one/agent-events";
import { AscendaEventPayload, IngestResult } from "@ascenda-one/tool-contract";
import { toAgentEvent } from "./agentEvent";
import { readMachineCredentials } from "./credentials";
import { ascendaHome } from "./tokenStore";

/**
 * Local sink: one JSON object per line, holding the payload that was (or, on
 * an unpaired install, would have been) put on the wire plus how delivery
 * went. Three jobs the ingest path cannot do: see what a tool emits with no
 * backend running, audit what left the machine against the metadata-only
 * claim, and give anything else on this machine an event stream to read
 * without an Ascenda account.
 *
 * Where it goes, first match wins:
 *
 *  1. `ASCENDA_EVENT_LOG_FILE` — a path, or `off`.
 *  2. `eventLogPath` at the top of ~/.ascenda/credentials.json, written by
 *     `setup --event-log`. A path, or `off`. This is what reaches a hook
 *     spawned with no shell environment, which on macOS is the normal case.
 *  3. On an install that was set up without pairing, ~/.ascenda/events.jsonl.
 *     Unpaired means local, and local should produce something a person can
 *     read. A paired install stays off unless one of the above turns it on.
 *
 * Each line carries two shapes. `payload` is the wire payload, which follows
 * the backend's contract and can change in any release. `event` is the
 * public agent event (`@ascenda-one/agent-events`, v0), the part outside
 * readers should build on.
 *
 * Nothing here may throw: a sink that can break telemetry, or the user's
 * turn, is worse than no sink.
 */
export const EVENT_LOG_ENV_VAR = "ASCENDA_EVENT_LOG_FILE";

/** The value that turns the log off in either setting, including on an unpaired install. */
export const EVENT_LOG_OFF = "off";

/** Rotate at 5 MB — roughly 20k events, weeks of normal use. */
const MAX_BYTES = 5 * 1024 * 1024;

export type EventLogEntry = {
  loggedAt: string;
  delivery: IngestResult | "not_sent";
  payload: AscendaEventPayload;
  /** Filled in by {@link appendEventLog} when the caller leaves it out. */
  event?: AgentEventV0;
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

/** Where an unpaired install writes when nothing else is configured. */
export function defaultEventLogPath(): string {
  return path.join(ascendaHome(), "events.jsonl");
}

/**
 * Which rule decided. `disabled` is someone saying `off`; plain `off` is
 * nothing configured on a paired install. `status` and `doctor` print the
 * difference, because "never configured" and "configured somewhere this
 * process can't see" look identical otherwise.
 */
export type EventLogSource = "env" | "credentials" | "unpaired-default" | "disabled" | "off";

export type EventLogSetting = { path: string | undefined; source: EventLogSource };

export type EventLogOptions = {
  /** The install was set up without pairing, so the log is on unless turned off. */
  localOnly?: boolean;
};

export function resolveEventLog(options: EventLogOptions = {}): EventLogSetting {
  for (const [source, raw] of [
    ["env", process.env[EVENT_LOG_ENV_VAR]],
    ["credentials", readMachineCredentials()?.eventLogPath]
  ] as const) {
    const value = raw?.trim();
    if (!value) continue;
    if (value.toLowerCase() === EVENT_LOG_OFF) return { path: undefined, source: "disabled" };
    return { path: expandUserPath(value), source };
  }
  if (options.localOnly) return { path: defaultEventLogPath(), source: "unpaired-default" };
  return { path: undefined, source: "off" };
}

export function resolveEventLogPath(options: EventLogOptions = {}): string | undefined {
  return resolveEventLog(options).path;
}

/**
 * One line for `status` and `doctor`. `command` is how this adapter's setup
 * is run, so the hint names something the person can type.
 */
export function describeEventLog(setting: EventLogSetting, command: string): string {
  switch (setting.source) {
    case "env":
      return `${setting.path} (from ${EVENT_LOG_ENV_VAR})`;
    case "credentials":
      return `${setting.path} (set by ${command} --event-log)`;
    case "unpaired-default":
      return `${setting.path} (on because this install isn't paired; ${command} --event-log off to stop)`;
    case "disabled":
      return `off (turned off; ${command} --event-log to turn it on)`;
    case "off":
      return `off (${command} --event-log to keep a local copy of every event)`;
  }
}

/**
 * Parses `--event-log`'s optional value: bare turns it on at the default
 * path, a path turns it on there, `off` turns it off. Returns how many extra
 * argv entries it consumed, so callers can advance their index.
 */
export function parseEventLogFlag(argv: readonly string[], index: number): { value: string; consumed: number } {
  const peek = argv[index + 1];
  if (peek !== undefined && !peek.startsWith("-")) return { value: peek, consumed: 1 };
  return { value: defaultEventLogPath(), consumed: 0 };
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
    const line: EventLogEntry = { ...entry, event: entry.event ?? toAgentEvent(entry.payload) };
    fs.appendFileSync(logFilePath, `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(logFilePath, 0o600);
  } catch {
    // Unwritable path, full disk, read-only mount: the event still shipped.
  }
}

/**
 * One generation only, so the log never takes more than about 10 MB. It is a
 * local stream and an audit aid, not a durable record: a reader that wants
 * history keeps its own, and bounding disk use on a machine that never asked
 * for a log matters more than keeping old lines.
 */
function rotateIfLarge(logFilePath: string): void {
  try {
    if (fs.statSync(logFilePath).size < MAX_BYTES) return;
    fs.renameSync(logFilePath, `${logFilePath}.1`);
  } catch {
    // Missing file is the common case on the first write.
  }
}
