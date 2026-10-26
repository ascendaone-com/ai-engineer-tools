import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { doctorRow, tidyHomePath } from "@ascenda-one/tool-kit";
import type { TerminalStyle, Tone } from "@ascenda-one/tool-kit";
import { copilotHome } from "./home.js";
import { readSessionRecord } from "./sessionRecord.js";
import { readSubagentParents } from "./subagents.js";
import type { SessionRecord } from "./sessionRecord.js";

/**
 * `doctor`'s answer to "which Copilot runtimes ran our hook, and did it
 * work". Two sources, joined on the session id:
 *
 *  - **Ours**: the per-session record our hook keeps (`sessionRecord.ts`).
 *    That a session is in it is the only evidence that our hook ran there.
 *  - **Copilot's**: each CLI session's `events.jsonl`, which logs every hook
 *    run as `hook.start` / `hook.end` without naming the command. Its counts
 *    are context. A failure's `error.message` holds the script path, so a
 *    failure that names our binary is ours, and any other is another hook's.
 *
 * What is read, and nothing more: lines containing `"hook.start"`,
 * `"hook.end"`, `"session.start"` or `"subagent.started"` are parsed; of
 * those, the type, the hook type, `success`, whether `error.message` contains
 * our binary name, the session id, and a subagent's id (`subagent.started`'s
 * `toolCallId`, a `subagentStart` hook input's `agentId`). No other field of
 * a hook's `input` (the payload, prompt included) is touched. From `workspace.yaml`, the `client_name` line alone; its `name` is
 * the session's first prompt. No message or path from either file is printed.
 *
 * A subagent's hooks arrive under its own id. Our hook files them under the
 * parent, and an older record that didn't is folded in here, using the
 * subagent ids the parent's log names and our own pairings.
 *
 * VS Code's own chat doesn't write to `session-state`, so a session in our
 * record that the CLI has no directory for, and that no log names as a
 * subagent, is reported as likely VS Code chat.
 */

export const RUNTIME_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A session log past this size is skipped rather than read into memory. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

export interface CopilotSessionScan {
  sessionId: string;
  /** `client_name` from `workspace.yaml`, or null when absent (a standalone CLI session). */
  clientName: string | null;
  /** `hook.start` for a hook we register. */
  hookRuns: number;
  /** `hook.end` with `success: true`, for a hook we register. */
  succeeded: number;
  /** Failures whose message names our binary. */
  oursFailed: number;
  /** Failures that don't. */
  othersFailed: number;
  /** Subagent ids this session's log names. */
  subagentIds: string[];
}

export interface ScanOptions {
  hookEvents: readonly string[];
  binaryName: string;
  root?: string;
  now?: number;
  windowDays?: number;
}

/** Every CLI session whose log changed in the window. A directory that can't be read is skipped. */
export function scanCopilotSessions(options: ScanOptions): CopilotSessionScan[] {
  const root = options.root ?? path.join(copilotHome(), "session-state");
  const since = (options.now ?? Date.now()) - (options.windowDays ?? RUNTIME_WINDOW_DAYS) * DAY_MS;
  const hooks = new Set(options.hookEvents);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const scans: CopilotSessionScan[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const log = path.join(dir, "events.jsonl");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(log);
    } catch {
      continue;
    }
    if (stat.mtimeMs < since || stat.size > MAX_LOG_BYTES) continue;
    try {
      scans.push(scanSession(name, fs.readFileSync(log, "utf8"), readClientName(dir), hooks, options.binaryName));
    } catch {
      continue;
    }
  }
  return scans;
}

function scanSession(dirName: string, text: string, clientName: string | null, hooks: Set<string>, binaryName: string): CopilotSessionScan {
  const scan: CopilotSessionScan = { sessionId: dirName, clientName, hookRuns: 0, succeeded: 0, oursFailed: 0, othersFailed: 0, subagentIds: [] };
  const subagents = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.includes('"hook.start"') && !line.includes('"hook.end"') && !line.includes('"session.start"') && !line.includes('"subagent.started"')) continue;
    let event: { type?: unknown; data?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : undefined;
    if (!data) continue;
    if (event.type === "session.start") {
      if (typeof data.sessionId === "string" && data.sessionId) scan.sessionId = data.sessionId;
      continue;
    }
    if (event.type === "subagent.started") {
      if (isId(data.toolCallId)) subagents.add(data.toolCallId);
      continue;
    }
    if (event.type === "hook.start" && data.hookType === "subagentStart") {
      const agentId = data.input && typeof data.input === "object" ? (data.input as Record<string, unknown>).agentId : undefined;
      if (isId(agentId)) subagents.add(agentId);
    }
    if (typeof data.hookType !== "string" || !hooks.has(data.hookType)) continue;
    if (event.type === "hook.start") {
      scan.hookRuns++;
    } else if (event.type === "hook.end") {
      if (data.success === true) scan.succeeded++;
      else if (failureNames(data.error, binaryName)) scan.oursFailed++;
      else scan.othersFailed++;
    }
  }
  scan.subagentIds = [...subagents];
  return scan;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Whether a failure's message names our binary. The message itself goes no further. */
function failureNames(error: unknown, binaryName: string): boolean {
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  return typeof message === "string" && message.includes(binaryName);
}

/** The `client_name` line of `workspace.yaml`, read on its own. Never a YAML parse: `name` is prompt text. */
function readClientName(dir: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "workspace.yaml"), "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^client_name:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!match) continue;
    let value = match[1];
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    // A short identifier or nothing: this value is printed.
    return /^[A-Za-z0-9._-]{1,40}$/.test(value) ? value : null;
  }
  return null;
}

export interface RuntimeLinesOptions extends ScanOptions {
  ui: TerminalStyle;
  /** The user-level hooks file, named when a runtime ran none of ours. */
  hooksFile: string;
  record?: SessionRecord;
  /** Our subagent pairings, agent id to session id. Read from disk when absent. */
  subagentParents?: Record<string, string>;
}

export function copilotRuntimeLines(options: RuntimeLinesOptions): string[] {
  const { ui } = options;
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? RUNTIME_WINDOW_DAYS;
  const root = options.root ?? path.join(copilotHome(), "session-state");
  const scans = scanCopilotSessions({ ...options, root, now, windowDays });
  const parents: Record<string, string> = { ...(options.subagentParents ?? readSubagentParents()) };
  for (const scan of scans) for (const id of scan.subagentIds) parents[id] ??= scan.sessionId;
  const record = foldSubagents(options.record ?? readSessionRecord(), parents);
  const since = now - windowDays * DAY_MS;
  const lines = [`  ${ui.bold("Copilot runtimes")}  ${ui.dim(`last ${windowDays} days`)}`];

  const runsOf = (id: string) => Object.values(record[id]?.events ?? {}).reduce((sum, count) => sum + count, 0);
  const groups = new Map<string, CopilotSessionScan[]>();
  for (const scan of scans) {
    const runtime = scan.clientName ?? "standalone";
    groups.set(runtime, [...(groups.get(runtime) ?? []), scan]);
  }

  for (const [runtime, sessions] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const ran = sessions.filter((session) => record[session.sessionId]);
    const runs = ran.reduce((sum, session) => sum + runsOf(session.sessionId), 0);
    const failed = sessions.reduce((sum, session) => sum + session.oursFailed, 0);
    const logged = sessions.reduce((sum, session) => sum + session.hookRuns, 0);
    let value = `${plural(sessions.length, "session")}, ours ran in ${ran.length}`;
    let tone: Tone = "ok";
    if (ran.length) value += ` (${plural(runs, "run")}, ${failed} failed)`;
    else if (failed) value += `, and failed ${plural(failed, "time")} before it could record`;
    else {
      value += `. Is ${tidyHomePath(options.hooksFile, os.homedir())} loaded?`;
      tone = "warn";
    }
    if (failed) tone = "bad";
    lines.push(`${doctorRow(ui, tone, runtime, value)} ${ui.dim(`· the CLI logged ${plural(logged, "hook run")}`)}`);
  }

  const othersFailed = scans.reduce((sum, scan) => sum + scan.othersFailed, 0);
  if (othersFailed) lines.push(doctorRow(ui, "info", "other hooks", `${plural(othersFailed, "failure")} from another hook, not ours`));

  const scanned = new Set(scans.map((scan) => scan.sessionId));
  const outside = Object.entries(record).filter(([id, entry]) =>
    !scanned.has(id) && !parents[id] && Date.parse(entry.lastAt) >= since && !fs.existsSync(path.join(root, id)));
  if (outside.length) {
    lines.push(doctorRow(ui, "info", "outside the CLI", `${plural(outside.length, "session")} our hook saw that the CLI's log doesn't have, likely VS Code chat`));
  }

  if (lines.length === 1) {
    lines.push(doctorRow(ui, "info", "no sessions", `None in the last ${windowDays} days. Run a short Copilot session, then run doctor again.`));
  }
  return lines;
}

/** The record with each subagent's entry merged into its session's. */
function foldSubagents(record: SessionRecord, parents: Record<string, string>): SessionRecord {
  const folded: SessionRecord = {};
  for (const [id, entry] of Object.entries(record)) {
    const into = parents[id] ?? id;
    const target = folded[into] ?? { firstAt: entry.firstAt, lastAt: entry.lastAt, events: {} };
    if (entry.firstAt < target.firstAt) target.firstAt = entry.firstAt;
    if (entry.lastAt > target.lastAt) target.lastAt = entry.lastAt;
    for (const [hook, count] of Object.entries(entry.events)) target.events[hook] = (target.events[hook] ?? 0) + count;
    folded[into] = target;
  }
  return folded;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
