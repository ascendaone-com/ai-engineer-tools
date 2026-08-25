/**
 * The standard business day: Mon–Fri, 09:00–17:00 local.
 *
 * This is the canonical after-hours definition, and
 * [isOutsideBusinessHours] is its predicate. It supersedes the three that
 * were in play — this file's 19:00–07:00 local, the backend aggregate's
 * 08:00–18:00 UTC, and the ad-hoc 20:00–06:00 used in one analysis — none
 * of which agreed and none of which looked at the day of the week.
 *
 * The weekday half is the substantive change. Under the old rule an entire
 * Saturday spent in an editor scored zero after-hours activity, because
 * every hour of it fell inside a window defined only by the clock. For a
 * measure whose whole purpose is to notice work escaping its boundaries,
 * "worked all weekend" reading as "no evening work" was the single largest
 * blind spot in it.
 */
export const BUSINESS_DAY = {
  /** 0 = Sunday … 6 = Saturday. */
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00"
} as const;

/**
 * True when `at` falls outside the standard business day — evenings, early
 * mornings, and any hour of a weekend.
 *
 * Local time by construction: a business day is a fact about the person's
 * calendar, not about UTC.
 */
export function isOutsideBusinessHours(
  at = new Date(),
  opts: { days?: readonly number[]; start?: string; end?: string } = {}
): boolean {
  const days = opts.days ?? BUSINESS_DAY.days;
  if (!days.includes(at.getDay())) return true; // weekend — all of it

  const minutes = at.getHours() * 60 + at.getMinutes();
  const start = parseTimeToMinutes(opts.start ?? BUSINESS_DAY.start, 9 * 60);
  const end = parseTimeToMinutes(opts.end ?? BUSINESS_DAY.end, 17 * 60);
  if (start >= end) return false; // degenerate window: flagging disabled
  return minutes < start || minutes >= end;
}

/**
 * Legacy local-time after-hours check: a clock window only, no weekday.
 *
 * @deprecated Prefer [isOutsideBusinessHours]. Retained because events
 * already collected under this definition are on the wire and in the
 * backend, and silently redefining the field would make old and new rows
 * incomparable without either being wrong.
 */
export function isAfterHours(now = new Date(), start = "19:00", end = "07:00"): boolean {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = parseTimeToMinutes(start, 19 * 60);
  const endMinutes = parseTimeToMinutes(end, 7 * 60);
  if (startMinutes === endMinutes) return false; // zero-length window: after-hours flagging disabled
  if (startMinutes < endMinutes) return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function parseTimeToMinutes(value: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const hours = Number(match[1]); const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return fallback;
  return Math.max(0, Math.min(23, hours)) * 60 + Math.max(0, Math.min(59, minutes));
}

/**
 * Minutes the local clock is AHEAD of UTC at `at` (Brisbane = 600,
 * Los Angeles = -420, UTC = 0).
 *
 * `Date.getTimezoneOffset()` reports the opposite sign — minutes to ADD to
 * local to reach UTC — which is a reliable source of inverted-by-one-negation
 * bugs. Negating once, here, means no caller has to remember.
 *
 * Evaluated at an instant rather than "now", so an event backdated across a
 * DST boundary carries the offset that was in force when it happened.
 */
export function utcOffsetMinutesAt(at: Date): number {
  return -at.getTimezoneOffset();
}

/**
 * The local hour at `at` for a clock `utcOffsetMinutes` ahead of UTC.
 *
 * The counterpart of {@link utcOffsetMinutesAt}, for a consumer holding a UTC
 * instant and an offset rather than a local `Date`.
 */
export function localHourAt(at: Date, utcOffsetMinutes: number): number {
  const shifted = new Date(at.getTime() + utcOffsetMinutes * 60_000);
  return shifted.getUTCHours();
}
