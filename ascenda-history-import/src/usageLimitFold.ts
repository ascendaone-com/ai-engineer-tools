/**
 * The provider's usage-limit readings across one Codex session.
 *
 * Current Codex builds write a `rate_limits` object beside `info` on each
 * `event_msg/token_count` line: a `primary` (short, five-hour on every line
 * seen) and a `secondary` (long, weekly) window, each with `used_percent`,
 * `window_minutes` and `resets_at` (or `resets_in_seconds`), plus `rate_limit_reached_type`, null
 * unless a limit was hit.
 *
 * Only those fields are read. The object also names the account's limit and
 * plan and carries a credit balance; none of that is touched here, so none
 * of it can reach a metric.
 *
 * A session whose rollouts carry no `rate_limits` gets no keys at all.
 * Absent means the build didn't write them, not that there was headroom.
 */

import type { NormalizedHistoricalEvent } from "./types.js";

/** `rate_limit_reached_type` values passed through as written. Anything else
 * ships as `other`, so a value the provider adds later can't carry free text
 * onto the wire. */
const REACHED_TYPES: ReadonlySet<string> = new Set(["primary", "secondary"]);

export interface UsageLimitReading {
  /** ISO instant of the line. */
  at: string;
  shortPct: number | null;
  longPct: number | null;
}

export interface UsageLimitTrack {
  /** Whether any line carried a `rate_limits` object. */
  seen: boolean;
  shortPeakPct: number | null;
  longPeakPct: number | null;
  shortWindowMinutes: number | null;
  longWindowMinutes: number | null;
  reachedType: string | null;
  firstReachedAt: string | null;
  /** Dated readings, for the per-day peaks. */
  readings: UsageLimitReading[];
}

export function newUsageLimitTrack(): UsageLimitTrack {
  return {
    seen: false,
    shortPeakPct: null,
    longPeakPct: null,
    shortWindowMinutes: null,
    longWindowMinutes: null,
    reachedType: null,
    firstReachedAt: null,
    readings: []
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

interface Window {
  pct: number | null;
  minutes: number | null;
  /** The window's reset had already passed at the line's instant. */
  stale: boolean;
}

/**
 * One window. `resets_at` is epoch seconds; builds that omit it write
 * `resets_in_seconds` instead, counted from the line. A window whose reset
 * has passed holds a reading from the window before it, so its percentage is
 * dropped: it has cleared, and the line says nothing about the new one.
 */
function windowOf(raw: unknown, atMs: number | null): Window | null {
  const window = record(raw);
  if (!window) return null;
  const pct = finite(window.used_percent);
  const minutes = finite(window.window_minutes);
  const resetsAt = finite(window.resets_at);
  const inSeconds = finite(window.resets_in_seconds);
  const resetMs =
    resetsAt !== null ? resetsAt * 1000 : inSeconds !== null && atMs !== null ? atMs + inSeconds * 1000 : null;
  const stale = resetMs !== null && atMs !== null && resetMs <= atMs;
  return {
    pct: pct === null || stale ? null : Math.min(100, Math.max(0, pct)),
    minutes: minutes !== null && minutes > 0 ? minutes : null,
    stale
  };
}

/** The short and long windows of each entry in `additional_rate_limits`,
 * which may be an array or an object keyed by limit. */
function extraLimits(raw: unknown): Record<string, unknown>[] {
  const list = Array.isArray(raw) ? raw : record(raw) ? Object.values(raw as object) : [];
  return list.map(record).filter((r): r is Record<string, unknown> => r !== null);
}

/** The reached-type value as it may ship: allow-listed, or `other`. */
export function usageLimitReachedTypeOf(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" && REACHED_TYPES.has(raw) ? raw : "other";
}

/**
 * One `token_count` line's `rate_limits`, from the session's own thread. A
 * subagent thread reports the same account's figures; the caller skips it
 * so the session's own reading is the only one counted.
 */
export function foldUsageLimits(track: UsageLimitTrack, raw: unknown, at: string | null): void {
  const limits = record(raw);
  if (!limits) return;
  const parsed = at ? Date.parse(at) : NaN;
  const atMs = Number.isFinite(parsed) ? parsed : null;
  const short = windowOf(limits.primary, atMs);
  const long = windowOf(limits.secondary, atMs);
  let reached = usageLimitReachedTypeOf(limits.rate_limit_reached_type);
  // A hit recorded against a window that has since reset isn't held.
  if ((reached === "primary" && short?.stale) || (reached === "secondary" && long?.stale)) reached = null;
  const extras = extraLimits(limits.additional_rate_limits).map((e) => ({
    short: windowOf(e.primary, atMs),
    long: windowOf(e.secondary, atMs)
  }));
  if (!short && !long && reached === null && !extras.some((e) => e.short || e.long)) return;
  track.seen = true;
  let shortPct = short?.pct ?? null;
  let longPct = long?.pct ?? null;
  for (const e of extras) {
    shortPct = maxOf(shortPct, e.short?.pct ?? null);
    longPct = maxOf(longPct, e.long?.pct ?? null);
    if (e.short?.minutes && !track.shortWindowMinutes) track.shortWindowMinutes = e.short.minutes;
    if (e.long?.minutes && !track.longWindowMinutes) track.longWindowMinutes = e.long.minutes;
  }
  track.shortPeakPct = maxOf(track.shortPeakPct, shortPct);
  track.longPeakPct = maxOf(track.longPeakPct, longPct);
  if (short?.minutes) track.shortWindowMinutes = short.minutes;
  if (long?.minutes) track.longWindowMinutes = long.minutes;
  // The earliest dated hit wins, since a session's lines can reach the fold
  // from more than one file. An undated hit still marks the session.
  if (reached !== null) {
    const earlier = at !== null && (track.firstReachedAt === null || at < track.firstReachedAt);
    if (earlier || track.reachedType === null) {
      track.reachedType = reached;
      if (at !== null) track.firstReachedAt = at;
    }
  }
  if (at && (shortPct !== null || longPct !== null)) {
    track.readings.push({ at, shortPct, longPct });
  }
}

/** The session keys. Empty when no line carried a reading. */
export function usageLimitMetrics(track: UsageLimitTrack): NormalizedHistoricalEvent["metrics"] {
  const metrics: NormalizedHistoricalEvent["metrics"] = {};
  if (!track.seen) return metrics;
  if (track.shortPeakPct !== null) metrics.usageLimitShortPeakPct = Math.round(track.shortPeakPct);
  if (track.longPeakPct !== null) metrics.usageLimitLongPeakPct = Math.round(track.longPeakPct);
  if (track.shortWindowMinutes !== null) metrics.usageLimitShortWindowMinutes = track.shortWindowMinutes;
  if (track.longWindowMinutes !== null) metrics.usageLimitLongWindowMinutes = track.longWindowMinutes;
  metrics.usageLimitReached = track.reachedType !== null;
  if (track.reachedType !== null) {
    metrics.usageLimitReachedType = track.reachedType;
    if (track.firstReachedAt) metrics.usageLimitFirstReachedAt = track.firstReachedAt;
  }
  return metrics;
}
