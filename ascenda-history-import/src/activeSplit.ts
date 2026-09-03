/**
 * Active time, split by who was doing the work.
 *
 * `activeMinutes` already answers "how much of this session was not idle" by
 * gap-splitting every known-line timestamp. It cannot answer the question the
 * Reveal actually wants to ask, which is what that time *was*: one prompt can
 * drive a forty-minute agent run, and forty minutes of watching an agent is
 * not forty minutes of a person at a keyboard. A single figure reports them as
 * the same thing.
 *
 * This module splits the same gap-split material in two:
 *
 *  - **hands-on** — the interval immediately *preceding* a human prompt. The
 *    prompt at its end is the evidence: someone read the previous output and
 *    typed. It is the only interval in a transcript where a person is
 *    demonstrably present, because it is the only one a person signed.
 *  - **agent-supervising** — every other active interval. The agent produced
 *    the lines that bound it.
 *
 * **What "supervising" does not claim.** It does not claim the person was
 * watching, and nothing in a transcript could show that they were. It is time
 * the agent was working which the person did not spend typing — no more. A
 * reader that renders it as attention is reading a fabrication into it; the
 * name is the plan's, the bound is this paragraph. The honest gloss is
 * "the agent was working", not "you were supervising".
 *
 * **Two figures, never one total.** Nothing here returns their sum. They
 * partition the same active milliseconds exactly (pinned by test), so a caller
 * *can* add them — but adding them reconstructs `activeMinutes`, which already
 * exists and already has readers. A third number spelled like a new
 * measurement would be the same number wearing a claim it cannot support, and
 * the whole point of the split is that the two halves differ.
 *
 * ## Posture
 *
 * `permissionMode` is on the transcript's human prompt lines and nowhere else
 * — checked across 120 real stores: 6.7% of `user` lines carry it, no
 * `assistant`, `system` or `attachment` line ever does. So posture is known at
 * prompt boundaries and interpolated between them: the mode declared by the
 * most recent human prompt at or before an interval governs that interval,
 * because that is when the person last told the runtime what it could do
 * unasked.
 *
 * Before the first declaration there is nothing to carry forward, and those
 * milliseconds land in `unknown` — never folded into a neighbouring band, for
 * the reason `autonomyBand` states at length: a guess there would look exactly
 * like a measurement. `unknown` being non-zero is normal and is not a defect.
 *
 * Only supervising time is banded. Posture describes how much latitude the
 * agent had while working; applied to the interval where the person was typing
 * it would describe nothing.
 */
import { autonomyBand, type AutonomyBand } from "@ascenda-one/tool-kit";

/**
 * Upstream's `permissionMode` spellings, snake-cased — the same one
 * transformation `AutonomyMode` documents, applied here because the transcript
 * writes camelCase where the hook payloads write snake_case. Mirroring rather
 * than translating: a mode this table has never seen is passed through
 * verbatim, so it reaches `autonomyBand` as an unrecognised token and lands in
 * `unknown` instead of being quietly mapped onto whichever rung looks close.
 */
export function snakeCasePermissionMode(mode: string): string {
  return mode.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * One instant on a session's timeline. Instants sharing an epoch millisecond
 * are collapsed by {@link activeSpans} before any of this is read — see
 * there for why.
 */
export interface ActiveInstant {
  /** Epoch ms. */
  at: number;
  /**
   * True where a line at this instant was a person's own prompt — the
   * extractor's own `humanPrompts` predicate, not a second definition of
   * "human" that could drift from the one `promptCount` is counted with.
   */
  human: boolean;
  /**
   * Snake-cased `permissionMode` declared by a line at this instant, or null
   * where none was. Null is the overwhelming majority; see the module note.
   */
  autonomyMode: string | null;
}

export interface ActiveSplit {
  /** Milliseconds, not minutes: the caller rounds once, at the edge. Rounding
   * each half separately and then comparing to a separately-rounded total is
   * how a partition stops adding up. */
  handsOnMs: number;
  agentSupervisingMs: number;
  /**
   * Supervising milliseconds by autonomy band. Bands with no time are absent
   * rather than zero — an absent band means "this session never worked under
   * that posture", which a zero would state less clearly. `unknown` is a real
   * band here and appears whenever any supervising time preceded the first
   * declared posture.
   */
  supervisingMsByBand: Partial<Record<AutonomyBand, number>>;
  /**
   * Instants that carried a timestamp the runtime wrote but this code could
   * not turn into an instant. Counted rather than dropped: the split is over a
   * timeline, and a timeline with holes in it under-reports both halves by an
   * amount only this number can express. Zero on every store observed so far,
   * which is what makes a non-zero worth looking at.
   */
  undatedPoints: number;
  /**
   * Distinct instants that went into the split, after collapsing ties. The
   * denominator for both figures: two minutes of hands-on off four instants
   * and off four hundred are not the same measurement, and only this tells
   * them apart.
   */
  instants: number;
  /**
   * Instants at or before which no `permissionMode` had ever been declared.
   * The posture blind spot stated as a count rather than inferred from
   * `supervisingMsByBand.unknown` being present — a session can have unknown
   * *instants* without unknown *milliseconds* (if every early gap was too wide
   * to be active), and reading one off the other would report the blind spot
   * as absent whenever it happened to be idle.
   */
  unposturedInstants: number;
}

/**
 * Consecutive instants no further apart than this are one stretch of work; a
 * wider gap is someone stepping away.
 *
 * **This is the extractor's threshold, passed in, not a second copy.**
 * `claudeCode.ts` owns the constant and hands it here, because two definitions
 * of "active" in one package is how the session figure and the per-day figures
 * came to disagree in the first place.
 */
export interface SplitOptions {
  activeGapMs: number;
}

/**
 * One stretch of active time and what it was — the single classification, so
 * that the session totals and the per-day slices cannot come to differ. Both
 * consume this; neither reimplements it.
 */
export interface ActiveSpan {
  /** Epoch ms, exclusive of nothing: `[from, to)`. */
  from: number;
  to: number;
  /** True where the span ends at a human prompt. */
  handsOn: boolean;
  /** The posture in force across the span. Only meaningful when `handsOn` is
   * false; supplied regardless so a caller never has to re-derive it. */
  band: AutonomyBand;
}

/** What {@link activeSpans} could not place, alongside what it did. */
export interface ActiveSpanReport {
  spans: ActiveSpan[];
  undatedPoints: number;
  instants: number;
  unposturedInstants: number;
}

/**
 * The active spans of a timeline, in order.
 *
 * **Ties are collapsed, not ordered.** A parallel tool batch writes several
 * lines on one millisecond, and a human prompt can share an instant with the
 * attachment lines that accompany it. Sorting such lines against each other
 * would make the split depend on a within-millisecond order the store does not
 * promise and the reader cannot see. So every line at one epoch millisecond
 * becomes one instant, `human` if *any* of them was a human prompt and
 * carrying whichever posture was declared there. Intervals between tied lines
 * are zero-length and are not spans, so nothing is lost by it.
 */
export function activeSpans(
  points: readonly ActiveInstant[],
  options: SplitOptions
): ActiveSpanReport {
  const collapsed = new Map<number, { human: boolean; autonomyMode: string | null }>();
  let undatedPoints = 0;
  for (const point of points) {
    if (!Number.isFinite(point.at)) {
      undatedPoints += 1;
      continue;
    }
    const existing = collapsed.get(point.at);
    if (existing) {
      existing.human = existing.human || point.human;
      if (point.autonomyMode) existing.autonomyMode = point.autonomyMode;
    } else {
      collapsed.set(point.at, { human: point.human, autonomyMode: point.autonomyMode });
    }
  }

  const instants = [...collapsed.keys()].sort((a, b) => a - b);
  const report: ActiveSpanReport = {
    spans: [],
    undatedPoints,
    instants: instants.length,
    unposturedInstants: 0
  };
  if (instants.length === 0) return report;

  // The posture in force, carried forward from the last human prompt that
  // declared one. Seeded from the first instant before the loop so a session
  // whose opening prompt declares a mode is not credited with an unknown
  // stretch it never had.
  let posture: string | null = collapsed.get(instants[0])?.autonomyMode ?? null;
  if (posture === null) report.unposturedInstants += 1;

  for (let i = 1; i < instants.length; i += 1) {
    const from = instants[i - 1];
    const to = instants[i];
    const here = collapsed.get(to)!;
    const gap = to - from;
    if (gap > 0 && gap <= options.activeGapMs) {
      // `autonomyBand` maps a null or unrecognised token to `unknown` on its
      // own; passing the raw carried value keeps that decision in the one
      // place that documents it.
      report.spans.push({ from, to, handsOn: here.human, band: autonomyBand(posture) });
    }
    if (here.autonomyMode) posture = here.autonomyMode;
    else if (posture === null) report.unposturedInstants += 1;
  }

  return report;
}

/**
 * Splits a session's timeline into hands-on and agent-supervising time, by
 * summing {@link activeSpans}.
 */
export function splitActiveTime(
  points: readonly ActiveInstant[],
  options: SplitOptions
): ActiveSplit {
  const report = activeSpans(points, options);
  const split: ActiveSplit = {
    handsOnMs: 0,
    agentSupervisingMs: 0,
    supervisingMsByBand: {},
    undatedPoints: report.undatedPoints,
    instants: report.instants,
    unposturedInstants: report.unposturedInstants
  };
  for (const span of report.spans) {
    const ms = span.to - span.from;
    if (span.handsOn) {
      split.handsOnMs += ms;
    } else {
      split.agentSupervisingMs += ms;
      split.supervisingMsByBand[span.band] = (split.supervisingMsByBand[span.band] ?? 0) + ms;
    }
  }
  return split;
}

/** Whole minutes, rounded once at the edge. */
export function minutesOf(ms: number): number {
  return Math.round(ms / 60_000);
}
