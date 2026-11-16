/**
 * The provider's usage-limit readings across one Codex session.
 *
 * Current Codex builds write a `rate_limits` object beside `info` on each
 * `event_msg/token_count` line: a `primary` (short, five-hour on every line
 * seen) and a `secondary` (long, weekly) window, each with `used_percent`,
 * `window_minutes` and `resets_at`, plus `rate_limit_reached_type`, null
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

function windowOf(raw: unknown): { pct: number | null; minutes: number | null } | null {
  const window = record(raw);
  if (!window) return null;
  const pct = finite(window.used_percent);
  const minutes = finite(window.window_minutes);
  return {
    pct: pct === null ? null : Math.min(100, Math.max(0, pct)),
    minutes: minutes !== null && minutes > 0 ? minutes : null
  };
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
  const short = windowOf(limits.primary);
  const long = windowOf(limits.secondary);
  const reached = usageLimitReachedTypeOf(limits.rate_limit_reached_type);
  if (!short && !long && reached === null) return;
  track.seen = true;
  track.shortPeakPct = maxOf(track.shortPeakPct, short?.pct ?? null);
  track.longPeakPct = maxOf(track.longPeakPct, long?.pct ?? null);
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
  if (at && (short?.pct != null || long?.pct != null)) {
    track.readings.push({ at, shortPct: short?.pct ?? null, longPct: long?.pct ?? null });
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
