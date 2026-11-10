import { EffortClass } from "@ascenda-one/tool-contract";

/**
 * A raw effort level onto the small {@link EffortClass} vocabulary. Total for
 * any input; `undefined` only when nothing was reported, so "no effort on the
 * payload" stays distinct from "an effort we couldn't place".
 *
 * Shared for the reason `classifyModelClass` is: the live Claude Code hooks
 * classify the level a payload carries, and the importer classifies the
 * `primaryEffort` it folds out of a transcript. Both land in one column, and
 * two copies would drift on the first level only one of them learned.
 *
 * The raw string is the record and the class is a reading. Both writers keep
 * the string on the same row (`effortLevel` live, `primaryEffort` imported),
 * so the buckets can be revised against history.
 *
 * Two fallbacks, split on absence:
 *
 *  - `undefined`: nothing reported. Absent, `null`, or empty once trimmed.
 *    The keys are then omitted, which a reader treats as unknown. Never as
 *    `medium`: older Claude Code builds don't write the field.
 *  - `unknown`: something was reported that isn't in the table. A new level
 *    lands here rather than being dropped, and so does a non-string value from
 *    an unityped store.
 */
export function classifyEffortClass(raw: string | undefined): EffortClass | undefined {
  // Widened on purpose: the declared type is the contract, this is the guard
  // for callers that reach it from JavaScript or from a foreign store's JSON.
  const candidate: unknown = raw;
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate !== "string") return "unknown";
  const value = candidate.trim().toLowerCase();
  if (!value) return undefined;
  return EFFORT_CLASS_BY_LEVEL[value] ?? "unknown";
}

/**
 * Whole-string matches only. Effort levels are single words, and a fuzzy match
 * would put `ultrahigh` (say) under `high` on the day it ships, which is a
 * guess we'd rather see as `unknown`.
 *
 * `minimal` and `none` are Codex's settings below `low`. They share its bucket;
 * the raw string still says which.
 */
const EFFORT_CLASS_BY_LEVEL: Readonly<Record<string, EffortClass>> = {
  none: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
};
