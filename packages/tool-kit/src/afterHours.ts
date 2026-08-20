/**
 * Local-time after-hours check used by tool-side producers.
 * NOTE: the backend aggregate currently standardises on 08:00-18:00 UTC —
 * a known discrepancy tracked for reconciliation; change it here once the
 * contract decides which definition is canonical.
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
