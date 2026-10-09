import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * When a usage limit lifts, for the `resumesAt` on a rate-limited `halted`
 * (P-D64.2). Claude Code says it only in prose, "resets 4:30pm
 * (Asia/Nicosia)", so the time is read out of that sentence here, in memory,
 * and only the number leaves. The sentence itself is never stored, logged or
 * sent.
 *
 * Everything here answers `undefined` when unsure. A wrong time would hold a
 * Mac awake for nothing, and a missing one just means the app treats the
 * halt like any other.
 */

/**
 * The furthest ahead a reset may be and still be sent. The session limit
 * resets within five hours; anything later is a weekly limit, which nobody
 * should keep a Mac awake for.
 */
export const MAX_RESUME_AHEAD_MS = 6 * 60 * 60 * 1000;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "resets 4:30pm", "reset at 4pm", "resets Oct 9, 4pm", "resets 16:30",
// each optionally followed by "(Area/City)". Matched case-insensitively.
const RESET_CLAUSE = new RegExp(
  "\\bresets?(?:\\s+at)?\\s+" +
  // An optional date: "Oct 9", "Oct 9,", "October 9 at".
  "(?:([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?:at\\s+)?)?" +
  // The time: "4", "4:30", "16:30", then an optional am/pm.
  "(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?" +
  // An optional zone in brackets.
  "(?:\\s*\\(([^)]+)\\))?",
  "i"
);

// Older Claude Code builds put the reset epoch straight after a pipe:
// "Claude AI usage limit reached|1760000000".
const PIPE_EPOCH = /usage limit reached\|(\d{10,13})\b/i;

/**
 * The reset instant named in `text`, in epoch milliseconds, or `undefined`
 * if there isn't one this can read with confidence.
 *
 * A time with no date is the next one: earlier than now today means
 * tomorrow. A month name without a year means this year, or next year when
 * that date has already gone. A weekday name ("resets Thu 4pm") isn't read.
 * The zone in brackets wins; without one the time is this machine's.
 */
export function parseUsageLimitReset(text: string, now: Date, localZone?: string): number | undefined {
  const piped = PIPE_EPOCH.exec(text);
  if (piped) {
    const raw = Number(piped[1]);
    return piped[1].length > 10 ? raw : raw * 1000;
  }

  const match = RESET_CLAUSE.exec(text);
  if (!match) return undefined;
  const [, monthWord, dayText, hourText, minuteText, meridiem, zoneText] = match;

  const hour = to24Hour(Number(hourText), meridiem, minuteText !== undefined);
  if (hour === undefined) return undefined;
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return undefined;

  const zone = zoneText?.trim() || localZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = wallDate(now, zone);
  if (!today) return undefined;

  if (monthWord !== undefined) {
    const month = MONTHS.indexOf(monthWord.slice(0, 3).toLowerCase());
    if (month < 0 || !matchesMonthName(monthWord, month)) return undefined;
    const day = Number(dayText);
    if (day < 1 || day > 31) return undefined;
    let at = zonedToEpoch({ year: today.year, month: month + 1, day, hour, minute }, zone);
    if (at !== undefined && at <= now.getTime()) {
      at = zonedToEpoch({ year: today.year + 1, month: month + 1, day, hour, minute }, zone);
    }
    return at;
  }

  const sameDay = zonedToEpoch({ ...today, hour, minute }, zone);
  if (sameDay === undefined) return undefined;
  if (sameDay > now.getTime()) return sameDay;
  return zonedToEpoch({ ...nextDay(today), hour, minute }, zone);
}

/**
 * The `resumesAt` for a rate-limited halt: epoch seconds on the minute, or
 * `undefined` when the text names no reset, or one more than
 * {@link MAX_RESUME_AHEAD_MS} away.
 */
export function resumesAtFor(text: string | undefined, now: Date, localZone?: string): number | undefined {
  if (!text) return undefined;
  const at = parseUsageLimitReset(text, now, localZone);
  if (at === undefined) return undefined;
  const ahead = at - now.getTime();
  if (ahead <= 0 || ahead > MAX_RESUME_AHEAD_MS) return undefined;
  return Math.round(at / 60_000) * 60;
}

/** Hours 1–12 with am/pm, or 0–23 written with minutes ("16:30"). */
function to24Hour(hour: number, meridiem: string | undefined, hasMinutes: boolean): number | undefined {
  if (meridiem === undefined) {
    // A bare "resets 4" is too thin to trust; "resets 16:30" is a clock.
    if (!hasMinutes || hour > 23) return undefined;
    return hour;
  }
  if (hour < 1 || hour > 12) return undefined;
  const pm = meridiem.toLowerCase().startsWith("p");
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

/** "Oct", "Oct.", "October" are October; "Octopus" isn't. */
function matchesMonthName(word: string, month: number): boolean {
  const full = new Date(Date.UTC(2000, month, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase();
  return full.startsWith(word.toLowerCase());
}

interface WallDate { year: number; month: number; day: number }
interface WallTime extends WallDate { hour: number; minute: number }

/** The calendar date `instant` falls on in `zone`, or undefined for an unknown zone. */
function wallDate(instant: Date, zone: string): WallDate | undefined {
  const parts = wallParts(instant.getTime(), zone);
  return parts && { year: parts.year, month: parts.month, day: parts.day };
}

function nextDay(date: WallDate): WallDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function wallParts(epochMs: number, zone: string): WallTime | undefined {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric"
    });
  } catch {
    return undefined;
  }
  const value = (type: string) => Number(format.formatToParts(epochMs).find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

/**
 * The instant a wall-clock time in `zone` names. Two passes, so a time
 * either side of a daylight-saving change lands on the right offset. A date
 * that doesn't exist (31 February) is refused.
 */
function zonedToEpoch(time: WallTime, zone: string): number | undefined {
  const asUtc = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute);
  const check = new Date(asUtc);
  if (check.getUTCDate() !== time.day) return undefined;
  let guess = asUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallParts(guess, zone);
    if (!seen) return undefined;
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    guess += asUtc - seenUtc;
  }
  return guess;
}

/** Where Claude Code's managed settings live on this platform. */
export function managedSettingsPath(): string {
  if (process.env.ASCENDA_CLAUDE_MANAGED_SETTINGS) return process.env.ASCENDA_CLAUDE_MANAGED_SETTINGS;
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

export interface AutoContinueSources {
  managedPath?: string;
  projectDir?: string;
  home?: string;
}

/**
 * Whether Claude Code will carry on by itself when the limit lifts:
 * `autoContinueAtUsageLimit` read with Claude Code's own precedence,
 * managed, then project-local, then project, then user. The first file that
 * sets the key decides, so a managed `false` beats a user `true`. Only a
 * literal `true` turns it on. A file that's missing or isn't JSON is
 * skipped.
 */
export function autoContinueEnabled(sources: AutoContinueSources = {}): boolean {
  const home = sources.home ?? os.homedir();
  const files = [
    sources.managedPath ?? managedSettingsPath(),
    ...(sources.projectDir
      ? [path.join(sources.projectDir, ".claude", "settings.local.json"), path.join(sources.projectDir, ".claude", "settings.json")]
      : []),
    path.join(home, ".claude", "settings.json")
  ];
  for (const file of files) {
    const value = readSetting(file, "autoContinueAtUsageLimit");
    if (value !== undefined) return value === true;
  }
  return false;
}

function readSetting(file: string, key: string): unknown {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && key in parsed) return (parsed as Record<string, unknown>)[key];
  } catch {
    // Missing, unreadable or not JSON: says nothing either way.
  }
  return undefined;
}
