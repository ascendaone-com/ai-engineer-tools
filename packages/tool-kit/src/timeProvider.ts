/**
 * A clock the caller can supply, so code that decides "is this within the last
 * N?" is a function of an instant it was given rather than of the wall clock
 * it happened to run under.
 *
 * The outbox is exactly that kind of code: its age bound keeps an entry only
 * while `queuedAt` sits inside `maxAgeMs` of now. Read `Date.now()` in there
 * and every test that seeds a fixed timestamp is really asserting "today is
 * still close enough to the fixture" — true when it was written, false a week
 * later, and red on a morning nobody committed anything. That is what happened
 * to `outbox.test.cjs` on 2026-09-08: fixtures anchored at 2026-09-01 fell out
 * of the seven-day window, and three tests that pin real behaviour started
 * failing on a date rather than on a change.
 *
 * asc-core-be took the same fix for the same defect, giving its three
 * trailing-window writers (TelemetryBaselineWriter 28d, WorkDivergenceWriter
 * 14d, AIWorkloadAggregateWriter 84d) a `TimeProvider` instead of
 * `DateTime.UtcNow`. This is that pattern, in the shape this package needs.
 *
 * Deliberately one method. The outbox needs an instant, not timers or time
 * zones, and a wider surface would be an invitation to route more of the
 * package through an interface it does not need.
 */
export type TimeProvider = {
  /** Milliseconds since the epoch, as `Date.now()` reports them. */
  now(): number;
};

/** The real clock. What every production path gets when no clock is supplied. */
export const systemTimeProvider: TimeProvider = {
  now: () => Date.now()
};

/**
 * A clock pinned to one instant, for a caller — a test, or a replay — that
 * seeds data at a fixed anchor and then runs code that filters relative to
 * "now". Accepts what a fixture is likely to already hold: an ISO string, a
 * `Date`, or epoch milliseconds.
 */
export function fixedTimeProvider(instant: Date | string | number): TimeProvider {
  const ms = typeof instant === "number" ? instant : new Date(instant).valueOf();
  if (!Number.isFinite(ms)) throw new TypeError(`fixedTimeProvider: not a usable instant: ${String(instant)}`);
  return { now: () => ms };
}
