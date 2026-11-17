import * as fs from "node:fs";
import * as path from "node:path";
import { ascendaHome, writeAtomically } from "@ascenda-one/tool-kit";
import { MAX_RESUME_AHEAD_MS } from "./usageLimitReset.js";

/**
 * The subscription quota Claude Code reports to a status line command, kept
 * as numbers on this machine. Claude Code's statusline input carries
 * `rate_limits.five_hour` and `rate_limits.seven_day`, each with
 * `used_percentage` (0 to 100) and `resets_at` (Unix epoch seconds). Either
 * window can be missing, and the whole object is missing for accounts that
 * have no subscription limit and before a session's first API response.
 *
 * Only those four numbers and the capture time are stored. Nothing else from
 * the statusline input is read, and nothing here is sent anywhere: the
 * snapshot feeds the `resumesAt` of a rate-limited halt (see `cli.ts`) and
 * is otherwise just a file for the desktop app to read.
 */

export interface QuotaWindow {
  /** 0 to 100, as Claude Code reports it. */
  usedPercentage: number;
  /** Unix epoch seconds. */
  resetsAt: number;
}

export interface QuotaSnapshot {
  /** Unix epoch seconds when a status line run last saw these numbers. */
  capturedAt: number;
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
}

export function quotaSnapshotPath(): string {
  return path.join(ascendaHome(), "claude-quota.json");
}

/**
 * The quota out of a statusline input, or undefined when it carries none
 * this can read. A window with a missing or non-numeric field is dropped
 * whole rather than half-kept.
 */
export function quotaFromStatusline(input: unknown, now: Date = new Date()): QuotaSnapshot | undefined {
  const limits = field(input, "rate_limits");
  if (!limits) return undefined;
  const fiveHour = windowFrom(field(limits, "five_hour"));
  const sevenDay = windowFrom(field(limits, "seven_day"));
  if (!fiveHour && !sevenDay) return undefined;
  return {
    capturedAt: Math.floor(now.getTime() / 1000),
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {})
  };
}

function field(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const found = (value as Record<string, unknown>)[key];
  return found && typeof found === "object" ? found as Record<string, unknown> : undefined;
}

function windowFrom(raw: Record<string, unknown> | undefined): QuotaWindow | undefined {
  if (!raw) return undefined;
  const used = raw.used_percentage;
  const resets = raw.resets_at;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return undefined;
  if (typeof resets !== "number" || !Number.isFinite(resets) || resets <= 0) return undefined;
  return { usedPercentage: used, resetsAt: Math.floor(resets) };
}

/** How long an unchanged reading is left alone before it is written again. */
const REFRESH_SECONDS = 60;

/**
 * Stores the snapshot. A reading identical to the stored one is rewritten
 * only once a minute, because Claude Code runs the status line on every
 * update. Returns whether the file was written. Never throws.
 */
export function recordQuota(snapshot: QuotaSnapshot, file: string = quotaSnapshotPath()): boolean {
  try {
    const previous = readQuota(file);
    const unchanged = previous
      && sameWindow(previous.fiveHour, snapshot.fiveHour)
      && sameWindow(previous.sevenDay, snapshot.sevenDay);
    if (unchanged && snapshot.capturedAt - previous.capturedAt < REFRESH_SECONDS) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomically(file, `${JSON.stringify(snapshot)}\n`, 0o600);
    return true;
  } catch {
    return false;
  }
}

function sameWindow(a: QuotaWindow | undefined, b: QuotaWindow | undefined): boolean {
  return a?.usedPercentage === b?.usedPercentage && a?.resetsAt === b?.resetsAt;
}

export function readQuota(file: string = quotaSnapshotPath()): QuotaSnapshot | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> | null;
    if (!parsed || typeof parsed.capturedAt !== "number") return undefined;
    const fiveHour = storedWindow(parsed.fiveHour);
    const sevenDay = storedWindow(parsed.sevenDay);
    return { capturedAt: parsed.capturedAt, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
  } catch {
    return undefined;
  }
}

function storedWindow(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { usedPercentage, resetsAt } = raw as Record<string, unknown>;
  return windowFrom({ used_percentage: usedPercentage, resets_at: resetsAt });
}

/**
 * The real reset time for a usage-limit hold, in epoch seconds, from the
 * stored quota; undefined when it names none.
 *
 * Only a window reading 100% counts as the one that stopped the session. A
 * window at 97% is not the cause, and borrowing its reset would be a guess.
 * Of the windows at 100% that haven't reset yet, the latest reset governs,
 * because the session can't run until every exhausted window has. The same
 * six-hour ceiling as the text path applies, so an exhausted weekly window
 * yields no hold.
 */
export function resumesAtFromQuota(snapshot: QuotaSnapshot | undefined, now: Date): number | undefined {
  if (!snapshot) return undefined;
  const nowSeconds = now.getTime() / 1000;
  const exhausted = [snapshot.fiveHour, snapshot.sevenDay]
    .filter((window): window is QuotaWindow => window !== undefined && window.usedPercentage >= 100 && window.resetsAt > nowSeconds);
  if (!exhausted.length) return undefined;
  const at = Math.max(...exhausted.map((window) => window.resetsAt));
  return at * 1000 - now.getTime() <= MAX_RESUME_AHEAD_MS ? at : undefined;
}
