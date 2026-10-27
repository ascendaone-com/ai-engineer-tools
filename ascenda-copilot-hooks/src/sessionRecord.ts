import * as fs from "fs";
import * as path from "path";
import { ascendaHome } from "@ascenda-one/tool-kit";

/**
 * Which Copilot sessions ran our hook, for `doctor`. Copilot's own session
 * log records every hook run but never the command, so it can't tell our hook
 * from another on the same event. This file is our side of that join.
 *
 * One small local file, never shipped: per session id, when our hook first
 * and last ran and how many times per hook. Nothing else from the payload.
 * The most recent {@link KEPT_SESSIONS} sessions are kept.
 */
export interface SessionRecordEntry {
  firstAt: string;
  lastAt: string;
  events: Record<string, number>;
}

export type SessionRecord = Record<string, SessionRecordEntry>;

const KEPT_SESSIONS = 50;

/** A session id Copilot generates. Anything else isn't one, and isn't kept. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function sessionRecordPath(): string {
  return path.join(process.env.ASCENDA_STATE_DIR ?? path.join(ascendaHome(), "state"), "copilot_cli-sessions.json");
}

/**
 * Counts one run of `hookName` under `sessionId`. Never throws: a health
 * record must never cost a turn. Two hooks writing at once can lose a count;
 * the rename means neither leaves a torn file.
 */
export function recordSessionHook(sessionId: string | undefined, hookName: string, hookEvents: readonly string[], now = new Date()): void {
  if (!sessionId || !SESSION_ID.test(sessionId) || !hookEvents.includes(hookName)) return;
  try {
    const record = readSessionRecord();
    const at = now.toISOString();
    const entry = record[sessionId] ?? { firstAt: at, lastAt: at, events: {} };
    entry.lastAt = at;
    entry.events[hookName] = (entry.events[hookName] ?? 0) + 1;
    record[sessionId] = entry;

    const kept = Object.entries(record)
      .sort(([, a], [, b]) => b.lastAt.localeCompare(a.lastAt))
      .slice(0, KEPT_SESSIONS);
    const file = sessionRecordPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(kept))}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Best effort.
  }
}

/** The record, with any entry that isn't the expected shape dropped. Missing or unreadable reads as empty. */
export function readSessionRecord(): SessionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sessionRecordPath(), "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record: SessionRecord = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SESSION_ID.test(id) || !value || typeof value !== "object") continue;
    const { firstAt, lastAt, events } = value as Partial<SessionRecordEntry>;
    if (typeof firstAt !== "string" || typeof lastAt !== "string" || !events || typeof events !== "object") continue;
    const counts: Record<string, number> = {};
    for (const [hook, count] of Object.entries(events)) if (typeof count === "number" && count > 0) counts[hook] = count;
    record[id] = { firstAt, lastAt, events: counts };
  }
  return record;
}
