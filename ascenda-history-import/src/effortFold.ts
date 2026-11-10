/**
 * The effort setting across one session, folded the same way for Claude Code
 * and Codex.
 *
 * Claude Code writes a top-level `effort` on each assistant line; Codex writes
 * `effort` on each `turn_context` line. Each extractor calls
 * {@link foldEffort} once per main-thread model turn, with the turn's instant,
 * and reads two things back at the end:
 *
 *  - `primaryEffort`: the level on most of those turns. Ties go to the level
 *    seen first, as `topModel` does for `primaryModel`.
 *  - `effortChanges`: the levels in time order, one entry each time the level
 *    differs from the one before. The first entry is the opening level, so a
 *    session that started on `medium` and moved to `high` reads as two
 *    entries, and one that never changed reads as one.
 *
 * Older Claude Code builds don't write the field. A session with no effort on
 * any turn gets neither value, which a reader treats as unknown.
 */

export interface EffortChange {
  /** The instant of the first turn at this level. */
  at: string;
  /** The level as the store wrote it, trimmed. */
  level: string;
}

export interface EffortTrack {
  counts: Map<string, number>;
  /** Dated observations in fold order; sorted when read, because a session's
   * lines can reach the fold from more than one file. */
  seen: { at: string; level: string }[];
}

export function newEffortTrack(): EffortTrack {
  return { counts: new Map(), seen: [] };
}

/**
 * The level from a store value: a bare string, or `{ level }` as the live hook
 * payload spells it. Anything else is no level.
 */
export function effortLevelOf(raw: unknown): string | null {
  const value =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && typeof (raw as { level?: unknown }).level === "string"
        ? (raw as { level: string }).level
        : null;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** One main-thread model turn. An undated turn still counts toward the
 * primary level; it can't be placed on the timeline. */
export function foldEffort(track: EffortTrack, raw: unknown, at: string | null): void {
  const level = effortLevelOf(raw);
  if (!level) return;
  track.counts.set(level, (track.counts.get(level) ?? 0) + 1);
  if (at) track.seen.push({ at, level });
}

export function primaryEffortOf(track: EffortTrack): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [level, count] of track.counts) {
    if (count > bestCount) {
      best = level;
      bestCount = count;
    }
  }
  return best;
}

export function effortChangesOf(track: EffortTrack): EffortChange[] {
  // Stable sort, so two turns at one instant keep their file order.
  const ordered = [...track.seen].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const changes: EffortChange[] = [];
  for (const { at, level } of ordered) {
    if (changes.length === 0 || changes[changes.length - 1].level !== level) changes.push({ at, level });
  }
  return changes;
}
