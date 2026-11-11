/**
 * A session's model mix as a bounded map, so a session that ran on two
 * models isn't reported as only its dominant one. `primaryModel` keeps its
 * meaning; this sits beside it.
 *
 * `metrics` is flat by contract (a number, string or boolean per key), so the
 * map travels as a JSON object in a string: `{"claude-opus-5":41,
 * "claude-haiku-4-5":3}`. Keys are the raw slugs, exactly as `primaryModel`
 * carries one; values are the counts `primaryModel` was chosen from, so the
 * map's largest entry is always `primaryModel`.
 *
 * Bounded at {@link MODEL_TURNS_CAP} entries, largest first (ties by slug).
 * Turns on models past the cap, and on any slug too long to be a model id,
 * are summed into `modelTurnsOmitted`, so the map plus that figure is the
 * whole count. `modelTurnsOmitted` is left off when nothing was omitted.
 */
export const MODEL_TURNS_CAP = 8;
const MAX_SLUG_LENGTH = 200;

export function modelTurnsMetrics(models: ReadonlyMap<string, number>): { modelTurns?: string; modelTurnsOmitted?: number } {
  const entries = [...models.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (entries.length === 0) return {};
  const kept: Record<string, number> = {};
  let keptCount = 0;
  let omitted = 0;
  for (const [model, count] of entries) {
    if (keptCount < MODEL_TURNS_CAP && model.length <= MAX_SLUG_LENGTH) {
      kept[model] = count;
      keptCount += 1;
    } else {
      omitted += count;
    }
  }
  return {
    ...(keptCount > 0 ? { modelTurns: JSON.stringify(kept) } : {}),
    ...(omitted > 0 ? { modelTurnsOmitted: omitted } : {})
  };
}

/** The handoff's form: the parsed map, or `null` when the metric is absent
 * or unreadable. */
export function parseModelTurns(raw: unknown): Record<string, number> | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}
