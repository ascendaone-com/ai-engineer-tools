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

/**
 * The unioned time placed on local days.
 *
 * Splitting happens after the union, never before: merging Monday's spans and
 * Tuesday's separately would be correct here but would need the day boundary
 * applied twice, and a span that runs 23:50 → 00:10 has to be cut by the same
 * rule the per-session slices use. That rule lives in `daySlice.ts` and is
 * imported rather than restated.
 */
export function unionActiveByLocalDay(
  spans: readonly ActiveSpan[]
): Map<string, { handsOnMs: number; agentSupervisingMs: number }> {
  const merged = unionActiveSpans(spans);
  const handsOnByDay = new Map<string, number>();
  const supervisingByDay = new Map<string, number>();
  for (const interval of merged.handsOn) {
    addSpanByLocalDay(handsOnByDay, new Date(interval.from), new Date(interval.to));
  }
  for (const interval of merged.agentSupervising) {
    addSpanByLocalDay(supervisingByDay, new Date(interval.from), new Date(interval.to));
  }
  const days = [...new Set([...handsOnByDay.keys(), ...supervisingByDay.keys()])].sort();
  return new Map(
    days.map((day) => [
      day,
      {
        handsOnMs: handsOnByDay.get(day) ?? 0,
        agentSupervisingMs: supervisingByDay.get(day) ?? 0
      }
    ])
  );
}
