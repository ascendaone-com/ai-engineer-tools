import { AutonomyMode } from "@ascenda-one/tool-contract";

/**
 * A coarse supervision band, derived from a stored `autonomyMode` token.
 *
 * **This is a reader's vocabulary and it is deliberately not on the wire.**
 * Nothing emits an `AutonomyBand`; every collector emits the upstream token
 * verbatim and this derives a band from it at read time. The distinction is
 * not stylistic:
 *
 *  - `ToolTelemetryEvents` has no retention window and no erasure pathway, and
 *    imported rows are never rewritten. What a collector writes is what the
 *    corpus holds forever.
 *  - Banding is not injective. `auto` and `dont_ask` land on the same band, so
 *    a corpus that stored the band could never be asked whether they differ.
 *  - Therefore banding at capture is indistinguishable from discarding, and
 *    the one decision here that cannot be revisited. Banding at read costs a
 *    query rewrite.
 *
 * The bands below are consequently **not frozen** the way the wire tokens are.
 * If it turns out that `auto` and `dont_ask` behave differently enough to
 * separate, or that `plan` belongs with `default` rather than above it, this
 * function changes and every historical row is re-read under the new rule.
 * That is the property the wire vocabulary was rewritten to buy.
 *
 * The rungs, most supervised first:
 *
 * - `planning`     — nothing executes; the human is deciding before work
 *                    starts.
 * - `supervised`   — every action is approved one at a time.
 * - `edits_auto`   — file edits apply without asking; commands still ask.
 * - `delegated`    — actions proceed without per-action approval, with the
 *                    permission rules still applying.
 * - `unsupervised` — permission checks bypassed entirely.
 * - `unknown`      — the stored token was one no band has been chosen for,
 *                    which is a signal that a runtime grew a mode. Never
 *                    folded into a neighbouring band: a guess here would look
 *                    exactly like a measurement.
 */
export type AutonomyBand =
  | "planning"
  | "supervised"
  | "edits_auto"
  | "delegated"
  | "unsupervised"
  | "unknown";

/**
 * The band for a stored `autonomyMode` token. Total: a token from a future
 * runtime, or a `null`/`undefined` from a row that never carried the key,
 * yields `"unknown"` rather than a throw or a silent neighbour.
 *
 * Note the two inputs that both produce `"unknown"` and must be told apart
 * *before* calling this: a row with no `autonomyMode` key at all (the runtime
 * has no such concept) and a row whose token is `"unknown"` (the runtime
 * reported a posture the collector could not place). This function cannot
 * preserve that distinction and does not try — check for the key's presence at
 * the query, where the row is still whole.
 */
export function autonomyBand(mode: AutonomyMode | string | null | undefined): AutonomyBand {
  if (typeof mode !== "string") return "unknown";
  return BAND_BY_MODE[mode] ?? "unknown";
}

const BAND_BY_MODE: Record<string, AutonomyBand> = {
  plan: "planning",
  default: "supervised",
  accept_edits: "edits_auto",
  // Two tokens, one band — and the reason the tokens stayed two. They differ
  // in how the user arrived at the posture rather than in how much the agent
  // may then do unasked, so today they read the same. If that ever stops being
  // true, this line changes and the whole corpus re-reads correctly, because
  // the wire never collapsed them.
  auto: "delegated",
  dont_ask: "delegated",
  bypass_permissions: "unsupervised"
};
