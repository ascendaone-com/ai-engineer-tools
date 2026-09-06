/**
 * Active time unioned across concurrent sessions.
 *
 * `splitActiveTime` answers "what was this session's active time" and answers
 * it correctly. `buildProjectDigests` then asks a different question — "what
 * was this *project's* active time" — and answers it by adding the sessions
 * up. Addition is the wrong operator for that question, because sessions
 * overlap: two agents running in one repo from 14:00 to 16:00 are two hours of
 * the person's week and four hours of session time, and the sum reports four.
 *
 * On the reference machine the sum came to 713 hours of supervising across a
 * 168-hour week — 4.2x wall clock, with a single project claiming 390 hours on
 * its own. A figure larger than the period it describes is not an
 * over-estimate, it is a category error: it is agent-hours worked, rendered
 * under a heading about where the person's week went.
 *
 * The same loop that sums the minutes already unions the *days* ("two sessions
 * on one Tuesday are one day"). This module applies that reasoning to the
 * milliseconds, which is where it was always needed.
 *
 * ## What the union does with the split
 *
 * Hands-on wins every overlap. Where one session's hands-on span meets
 * another's supervising span, the person was demonstrably typing — a prompt at
 * the end of the interval is the evidence — and no evidence anywhere says they
 * were doing the other thing. So supervising is the unioned supervising time
 * *minus* the unioned hands-on time. The two halves stay an exact partition of
 * the union, disjoint by construction, and neither can be inflated by the
 * other's overlaps.
 *
 * ## Concurrency is the finding, not a leftover
 *
 * The difference between the sum and the union is not error to be discarded.
 * `meanConcurrency` (summed ÷ unioned) and `peakConcurrency` (the deepest
 * overlap) are how many agents were running at once — the honest form of the
 * number the sum was accidentally reporting. A project at 2.3x mean is being
 * worked differently from one at 1.0x, and only these say so.
 */
import { ActiveSpan } from "./activeSplit.js";
import { addSpanByLocalDay } from "./daySlice.js";

/** A half-open interval `[from, to)` in epoch ms. */
export interface Interval {
  from: number;
  to: number;
}

/**
 * Active time over a set of possibly-overlapping spans drawn from more than
 * one session.
 *
 * Both the unioned and the summed figures are reported. A caller that quotes
 * only the union is right about elapsed time; a caller that wants to say
 * "eleven agent-hours" still can, and the pair is what makes the two readings
 * distinguishable instead of one silently standing in for the other.
 */
export interface UnionedActive {
  /** Elapsed ms in which any session was hands-on. */
  handsOnMs: number;
  /** Elapsed ms with an agent working and nobody typing — hands-on time
   * already removed, so this and `handsOnMs` never double-count. */
  agentSupervisingMs: number;
  /** What `buildProjectDigests` reports today: every span added up. Kept so
   * the gap between the two readings is legible rather than lost. */
  summedHandsOnMs: number;
  summedAgentSupervisingMs: number;
  /**
   * Summed ÷ unioned across both halves, or null where there is no unioned
   * time to divide by. 1.0 means the sessions never overlapped; 4.2 means the
   * average active millisecond had 4.2 sessions running in it.
   */
  meanConcurrency: number | null;
  /** Deepest simultaneous overlap. 1 for strictly sequential work. */
  peakConcurrency: number;
}

/**
 * Merges overlapping and touching intervals into a minimal ordered set.
 *
 * Touching counts as merging: `[10, 20)` and `[20, 30)` are twenty
 * milliseconds of one stretch, not two stretches with a zero-width hole. The
 * input is not mutated.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.to > i.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.from <= last.to) {
      if (interval.to > last.to) last.to = interval.to;
    } else {
      merged.push({ from: interval.from, to: interval.to });
    }
  }
  return merged;
}

/**
 * `minuend` with every part of `subtrahend` removed. Both are merged first, so
 * the caller need not hand over normalised input, and the result is merged by
 * construction.
 */
export function subtractIntervals(
  minuend: readonly Interval[],
  subtrahend: readonly Interval[]
): Interval[] {
  const holes = mergeIntervals(subtrahend);
  const out: Interval[] = [];
  for (const span of mergeIntervals(minuend)) {
    let cursor = span.from;
    for (const hole of holes) {
      if (hole.to <= cursor) continue;
      if (hole.from >= span.to) break;
      if (hole.from > cursor) out.push({ from: cursor, to: hole.from });
      cursor = Math.max(cursor, hole.to);
      if (cursor >= span.to) break;
    }
    if (cursor < span.to) out.push({ from: cursor, to: span.to });
  }
  return out;
}

/** Total length of a set of intervals, which is only the elapsed time if they
 * do not overlap — pass merged input, or use {@link unionActiveTime}. */
export function totalMs(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, i) => sum + (i.to - i.from), 0);
}

/**
 * The deepest number of spans covering any single instant.
 *
 * A sweep over start/end events rather than a scan of pairs, so a project with
 * a hundred thousand spans costs a sort rather than a quadratic.
 */
function peakOverlap(intervals: readonly Interval[]): number {
  const edges: { at: number; delta: number }[] = [];
  for (const interval of intervals) {
    if (interval.to <= interval.from) continue;
    edges.push({ at: interval.from, delta: 1 });
    edges.push({ at: interval.to, delta: -1 });
  }
  // Ends before starts at a shared instant: a span ending exactly where the
  // next begins is a handover, not an overlap.
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let depth = 0;
  let peak = 0;
  for (const edge of edges) {
    depth += edge.delta;
    if (depth > peak) peak = depth;
  }
  return peak;
}

/**
 * Unions classified spans from any number of sessions into one elapsed-time
 * reading.
 *
 * Spans may be handed in in any order and from any number of sessions; the
 * result does not depend on which session they came from, which is the point —
 * the person lived one timeline regardless of how many transcripts recorded it.
 */
export function unionActiveTime(spans: readonly ActiveSpan[]): UnionedActive {
  const handsOn: Interval[] = [];
  const supervising: Interval[] = [];
  for (const span of spans) {
    if (span.to <= span.from) continue;
    (span.handsOn ? handsOn : supervising).push({ from: span.from, to: span.to });
  }

  const mergedHandsOn = mergeIntervals(handsOn);
  // Hands-on wins the overlap; see the module note.
  const mergedSupervising = subtractIntervals(supervising, mergedHandsOn);

  const handsOnMs = totalMs(mergedHandsOn);
  const agentSupervisingMs = totalMs(mergedSupervising);
  const summedHandsOnMs = totalMs(handsOn);
  const summedAgentSupervisingMs = totalMs(supervising);
  const unionedMs = handsOnMs + agentSupervisingMs;

  return {
    handsOnMs,
    agentSupervisingMs,
    summedHandsOnMs,
    summedAgentSupervisingMs,
    meanConcurrency:
      unionedMs > 0 ? (summedHandsOnMs + summedAgentSupervisingMs) / unionedMs : null,
    peakConcurrency: peakOverlap([...handsOn, ...supervising])
  };
}

/**
 * The unioned spans themselves, hands-on and supervising kept apart, for a
 * caller that needs to place them on days rather than only total them.
 */
export function unionActiveSpans(spans: readonly ActiveSpan[]): {
  handsOn: Interval[];
  agentSupervising: Interval[];
} {
  const handsOn: Interval[] = [];
  const supervising: Interval[] = [];
  for (const span of spans) {
    if (span.to <= span.from) continue;
    (span.handsOn ? handsOn : supervising).push({ from: span.from, to: span.to });
  }
  const mergedHandsOn = mergeIntervals(handsOn);
  return {
    handsOn: mergedHandsOn,
    agentSupervising: subtractIntervals(supervising, mergedHandsOn)
  };
}

export interface UnionedDay {
  /** Elapsed ms on this day in which any session was hands-on. */
  handsOnMs: number;
  /** Elapsed ms on this day with an agent working and nobody typing. */
  agentSupervisingMs: number;
  /**
   * The same day's spans added up rather than unioned — the numerator of a
   * window's concurrency.
   *
   * Carried per day because concurrency over a window has to be computed from
   * that window's material. A ratio taken over the whole extraction says
   * nothing about seven days of it, and the alternative to carrying this was
   * a card quoting a corpus-wide figure beside a weekly one.
   *
   * Both sums are additive across days, and so is the union, so any window's
   * mean concurrency is the sum of these over its days divided by the sum of
   * the unioned figures — no window the extractor has to be told about in
   * advance, and no re-derivation from spans it no longer has.
   */
  summedHandsOnMs: number;
  summedAgentSupervisingMs: number;
  /**
   * Deepest simultaneous overlap reached on this day, spans clipped to the
   * day's own bounds.
   *
   * Stored rather than derived because a maximum cannot be reconstructed from
   * totals — this is the one figure per-day sums cannot give a window back.
   * Clipping is what makes it composable: every instant belongs to exactly one
   * local day, so a window's peak is the greatest of its days' peaks, exactly.
   */
  peakConcurrency: number;
}

/**
 * The unioned time placed on local days, with the material a window needs to
 * state its own concurrency.
 *
 * Splitting happens after the union, never before: merging Monday's spans and
 * Tuesday's separately would be correct here but would need the day boundary
 * applied twice, and a span that runs 23:50 -> 00:10 has to be cut by the same
 * rule the per-session slices use. That rule lives in `daySlice.ts` and is
 * imported rather than restated.
 */
export function unionActiveByLocalDay(spans: readonly ActiveSpan[]): Map<string, UnionedDay> {
  const merged = unionActiveSpans(spans);
  const handsOnByDay = new Map<string, number>();
  const supervisingByDay = new Map<string, number>();
  for (const interval of merged.handsOn) {
    addSpanByLocalDay(handsOnByDay, new Date(interval.from), new Date(interval.to));
  }
  for (const interval of merged.agentSupervising) {
    addSpanByLocalDay(supervisingByDay, new Date(interval.from), new Date(interval.to));
  }

  // The sums use the raw spans, deliberately unmerged: this is the figure the
  // rollup used to report on its own, kept per day so the gap between it and
  // the union stays visible at whatever grain a reader asks about.
  const summedHandsOnByDay = new Map<string, number>();
  const summedSupervisingByDay = new Map<string, number>();
  // Raw spans clipped per day, for the peak. A span crossing midnight
  // contributes its depth to both days it touches, which is what a peak *in a
  // day* means: the person's Tuesday is not made shallower by work that began
  // on Monday.
  const spansByDay = new Map<string, Interval[]>();
  for (const span of spans) {
    if (span.to <= span.from) continue;
    addSpanByLocalDay(
      span.handsOn ? summedHandsOnByDay : summedSupervisingByDay,
      new Date(span.from),
      new Date(span.to)
    );
    for (const [day, clipped] of clipByLocalDay(span)) {
      const bucket = spansByDay.get(day);
      if (bucket) bucket.push(clipped);
      else spansByDay.set(day, [clipped]);
    }
  }

  const days = [
    ...new Set([
      ...handsOnByDay.keys(),
      ...supervisingByDay.keys(),
      ...summedHandsOnByDay.keys(),
      ...summedSupervisingByDay.keys()
    ])
  ].sort();
  return new Map(
    days.map((day) => [
      day,
      {
        handsOnMs: handsOnByDay.get(day) ?? 0,
        agentSupervisingMs: supervisingByDay.get(day) ?? 0,
        summedHandsOnMs: summedHandsOnByDay.get(day) ?? 0,
        summedAgentSupervisingMs: summedSupervisingByDay.get(day) ?? 0,
        peakConcurrency: peakOverlap(spansByDay.get(day) ?? [])
      }
    ])
  );
}

/**
 * One interval per local day the span touches, each clipped to that day.
 *
 * The boundary comes from `addSpanByLocalDay` rather than a second midnight
 * calculation: the midnight a span is cut at must be the midnight its minutes
 * were credited to, and there is only one way to guarantee that. Replaying the
 * per-day durations it records, in order, from the span's start reconstructs
 * the cut points exactly.
 */
function clipByLocalDay(interval: Interval): [string, Interval][] {
  const perDay = new Map<string, number>();
  addSpanByLocalDay(perDay, new Date(interval.from), new Date(interval.to));
  const out: [string, Interval][] = [];
  let cursor = interval.from;
  for (const [day, ms] of perDay) {
    out.push([day, { from: cursor, to: cursor + ms }]);
    cursor += ms;
  }
  return out;
}
