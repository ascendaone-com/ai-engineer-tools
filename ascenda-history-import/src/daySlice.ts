/**
 * Per-local-day slices of a session.
 *
 * A session is not an event at a point in time — 487 of the 1,858 sessions on
 * the reference machine span more than one local day. Placing such a session
 * on a single day forces a choice, and two of the three answers are wrong:
 *
 *  - **its end day only** (what the handoff used to allow, since it carried
 *    nothing else) drops 16 days that genuinely held prompts;
 *  - **every day from start to end** claims 283 of 283 days on that machine —
 *    51 of them with no prompt at all. A session opened 22 Jun and last
 *    touched 5 Jul would assert fourteen days of work on the strength of two.
 *  - **the days it actually holds prompts on** is exact, needs no rule, and
 *    is what this module produces.
 *
 * The material is already here: every extractor collects each prompt's
 * timestamp to fold counts and gap-split active minutes, then discards the
 * list. Slicing is arithmetic over what was thrown away, not new inference.
 *
 * **Local days, deliberately.** Day boundaries come from the extracting
 * machine's own timezone (`Date`'s local accessors), because "did I work on
 * Tuesday" is a question about the person's Tuesday, not UTC's. The
 * consequence is that a handoff carries the timezone it was extracted in;
 * `LOCAL_TIMEZONE` records which, so a later reader can tell rather than
 * assume. Nothing here reaches the wire — slices stay in the local handoff.
 */

import { activeSpans, type ActiveInstant } from "./activeSplit.js";

/** One local day of a session: what happened, on that day, in that session. */
export interface SessionDaySlice {
  /** `YYYY-MM-DD` in the extracting machine's local time. */
  day: string;
  /** Human prompts submitted on this day, in this session. */
  prompts: number;
  /**
   * Gap-split active minutes falling on this day. Present only where the
   * caller asked for them — a store that cannot measure active time must not
   * appear to.
   */
  activeMinutes?: number;
  /**
   * The day's share of {@link ActiveSplit.handsOnMs}, in minutes — time
   * immediately preceding a human prompt.
   *
   * Present only alongside `agentSupervisingMinutes`, and only where the
   * caller passed classified instants. The two are never accompanied by a
   * combined figure: `activeMinutes` beside them is the pre-existing total and
   * means the same thing it always did, not a third measurement.
   */
  handsOnMinutes?: number;
  /**
   * The day's share of {@link ActiveSplit.agentSupervisingMs}, in minutes —
   * time the agent was working which the person did not spend typing. Not a
   * claim that anyone watched it; see `activeSplit.ts`.
   */
  agentSupervisingMinutes?: number;
}

/** The IANA zone the slices were cut in, or null where the host cannot say. */
export const LOCAL_TIMEZONE: string | null =
  Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;

function localDayKey(t: Date): string {
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local midnight strictly after `t` — the next day boundary to split at. */
function nextLocalMidnight(t: Date): Date {
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, 0, 0, 0);
}

/**
 * Adds `[from, to)` to the per-day totals, splitting at every local midnight
 * it crosses. A gap that runs 23:50 → 00:10 is ten minutes of Monday and ten
 * of Tuesday, not twenty of either.
 *
 * Splitting on local midnight also means a DST transition lands where the
 * person experienced it: the day boundary is whatever the host's calendar
 * says, so a 23-hour day is 23 hours.
 */
function addSpan(into: Map<string, number>, from: Date, to: Date): void {
  let cursor = from;
  while (cursor < to) {
    const boundary = nextLocalMidnight(cursor);
    const segmentEnd = boundary < to ? boundary : to;
    const key = localDayKey(cursor);
    into.set(key, (into.get(key) ?? 0) + (segmentEnd.getTime() - cursor.getTime()));
    cursor = segmentEnd;
  }
}

export interface SliceOptions {
  /**
   * Consecutive instants no further apart than this count as continuous work;
   * a wider gap is the session sitting idle. Same threshold the extractors
   * use for session-level `activeMinutes` — passing it in keeps one
   * definition rather than two that can drift.
   */
  activeGapMs?: number;
  /**
   * The instants to gap-split for active time, when they are not the prompt
   * timestamps.
   *
   * **This parameter exists because leaving it out was a bug.** The threshold
   * was already passed in, with a comment saying that kept one definition of
   * "active" rather than two — but only the threshold was shared. The session
   * figure gap-split every known-line timestamp while this function gap-split
   * the prompts it was handed, so the two disagreed on the *material* while
   * agreeing on the rule. Across 200 real sessions the prompts-only reading
   * came to 2,730 minutes against 18,938: it under-reported by 85.6%, because
   * a prompt that drives a forty-minute agent run contributes one instant and
   * the forty minutes are invisible.
   *
   * Prompts still count prompts. Only active time reads this. A caller with
   * nothing better to pass leaves it out and gets the old behaviour, which is
   * correct for a store whose only timestamps *are* its prompts.
   */
  activeInstants?: readonly ActiveInstant[];
}

/**
 * Slices a session's prompt timestamps into per-local-day counts, oldest
 * first. Unparseable and null timestamps are dropped rather than guessed at:
 * a prompt whose instant is unknown cannot be placed on a day, and inventing
 * one would put work on a date the store never claimed.
 *
 * Returns `[]` for a session with no usable timestamp, which is how a reader
 * tells "nothing to place" from "placed on the end day".
 */
export function sliceSessionByLocalDay(
  timestamps: readonly (string | null | undefined)[],
  options: SliceOptions = {}
): SessionDaySlice[] {
  const instants = timestamps
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .map((t) => new Date(t))
    .filter((d) => Number.isFinite(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  if (instants.length === 0) return [];

  const prompts = new Map<string, number>();
  for (const t of instants) {
    const key = localDayKey(t);
    prompts.set(key, (prompts.get(key) ?? 0) + 1);
  }

  const activeMs = new Map<string, number>();
  const handsOnMs = new Map<string, number>();
  const supervisingMs = new Map<string, number>();
  const gapMs = options.activeGapMs;
  // Whether the caller gave classified instants decides whether the split is
  // reported at all. A store that only has prompt timestamps gets active
  // minutes off those, as before, and no split — inventing a hands-on figure
  // for a store that cannot see an agent's turns would be the same fabrication
  // this module's day-placement rules exist to avoid.
  const classified = options.activeInstants;
  if (gapMs !== undefined) {
    const points: readonly ActiveInstant[] =
      classified ??
      instants.map((d) => ({ at: d.getTime(), human: true, autonomyMode: null }));
    // One classification, shared with the session totals — see activeSplit.ts.
    for (const span of activeSpans(points, { activeGapMs: gapMs }).spans) {
      const from = new Date(span.from);
      const to = new Date(span.to);
      addSpan(activeMs, from, to);
      if (classified) addSpan(span.handsOn ? handsOnMs : supervisingMs, from, to);
    }
  }

  const days = [...new Set([...prompts.keys(), ...activeMs.keys()])].sort();
  return days.map((day) => {
    const slice: SessionDaySlice = { day, prompts: prompts.get(day) ?? 0 };
    if (gapMs !== undefined) {
      slice.activeMinutes = Math.round((activeMs.get(day) ?? 0) / 60_000);
      if (classified) {
        slice.handsOnMinutes = Math.round((handsOnMs.get(day) ?? 0) / 60_000);
        slice.agentSupervisingMinutes = Math.round((supervisingMs.get(day) ?? 0) / 60_000);
      }
    }
    return slice;
  });
}
