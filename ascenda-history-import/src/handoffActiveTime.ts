/**
 * What each minute-shaped key in a written handoff is a measurement **of**.
 *
 * The first third of the `{quantity, gapMinutes, basis}` triple, written beside
 * the second. `HandoffFile.activeGapMinutes` already tells a reader *how* these
 * figures were cut; it has never told them *what was cut*, and that is the axis
 * that decides comparability. `projects[].handsOnMinutes` and
 * `projects[].elapsed.handsOnMinutes` sit in one file under one spelling and
 * were 4.2x apart on the reference machine — **the same gap rule cut both**, so
 * no gap stamp could ever separate them. Only the quantity can.
 *
 * **Keyed by the path a reader walks**, not by the interface that wrote it.
 * That is the difference between this file and `activeTimeFigures.ts`, and the
 * reason it is a separate table rather than a re-export of one: a reader holds
 * decoded JSON and no types, so `HandoffProjectDigest.handsOnMinutes` would name
 * something it cannot see. `ACTIVE_TIME_FIGURES` keys on `Interface.field`
 * because it guards declarations; this keys on paths because it describes a
 * file. Lists collapse to `[]`.
 *
 * **The vocabulary is asc-core-be's**, reached through the vendored copy in
 * `packages/tool-contract/contracts/active-time-quantities.v1.json` rather than
 * restated here. A name this file invents fails a build, on the same terms the
 * gap stamp already has with `DEFAULT_ACTIVE_GAP_MS`: read the rule, never
 * repeat it.
 *
 * **Per store, not one shared map.** A stamp must describe the file it rides
 * on, not the family it belongs to — the absent-is-not-zero rule pointed at
 * provenance. Cursor and VS Code get no map at all, for the reason they get no
 * gap stamp: they hand over no timeline, gap-split nothing, and carry no active
 * figure for a quantity to name. Their day slices hold `day` and `prompts` and
 * stop there.
 */

import type { AscendaActiveTimeQuantity } from "@ascenda-one/tool-contract";

/** A path a reader walks to a figure, mapped to the quantity it reports. */
export type ActiveTimeQuantityStamp = Readonly<Record<string, AscendaActiveTimeQuantity>>;

/**
 * A session's own figures, and its per-day slices of them.
 *
 * Elapsed, all of them: one session cannot overlap itself. `activeMinutes` is
 * the whole and the two beside it are its halves — never rendered as one
 * figure, which is the presentation the contract's `disjointHalves` note
 * forbids while allowing the addition itself.
 */
const SESSION_SPLIT_QUANTITIES: ActiveTimeQuantityStamp = {
  "sessions[].activeMinutes": "coverage",
  "sessions[].handsOnMinutes": "hands_on",
  "sessions[].agentSupervisingMinutes": "supervising",

  "sessions[].days[].activeMinutes": "coverage",
  "sessions[].days[].handsOnMinutes": "hands_on",
  "sessions[].days[].agentSupervisingMinutes": "supervising"
};

/**
 * The per-project rollup, from `buildProjectDigests`.
 *
 * **The collision this stamp exists for is in here.** `projects[]` is summed
 * across the project's sessions, which overlap, so it is agent-hours and a
 * surface quoting it as "where the week went" is the defect. `projects[].
 * elapsed` is the same work unioned over those sessions — the figure to render
 * as time — under the same spelling, one nesting level down.
 */
const PROJECT_DIGEST_QUANTITIES: ActiveTimeQuantityStamp = {
  "projects[].handsOnMinutes": "hands_on_agent_hours",
  "projects[].agentSupervisingMinutes": "supervising_agent_hours",

  "projects[].elapsed.handsOnMinutes": "hands_on",
  "projects[].elapsed.agentSupervisingMinutes": "supervising",

  "projects[].elapsed.days[].handsOnMinutes": "hands_on",
  "projects[].elapsed.days[].agentSupervisingMinutes": "supervising",
  // Both readings side by side, so a day can state its own concurrency rather
  // than borrow a corpus-wide ratio. The `summed` prefix is the only thing
  // separating them in the file; this says what the prefix means.
  "projects[].elapsed.days[].summedHandsOnMinutes": "hands_on_agent_hours",
  "projects[].elapsed.days[].summedAgentSupervisingMinutes": "supervising_agent_hours"
};

/** The Claude Code handoff's figures. */
export const CLAUDE_CODE_ACTIVE_TIME_QUANTITIES: ActiveTimeQuantityStamp = {
  ...SESSION_SPLIT_QUANTITIES,
  ...PROJECT_DIGEST_QUANTITIES
};

/**
 * The Codex handoff's figures — the same set, because in this package both
 * extractors classify a whole timeline and both writers share
 * `buildProjectDigests`.
 *
 * Composed from the same two blocks rather than declared as one map with two
 * names, so that a store which stops writing a figure can drop it without
 * touching the other. The coincidence is a fact about today's extractors, not
 * a shared shape: the app workspace's Codex reader has no subagent activity to
 * split, so its stamp is one key, and this one being longer is a difference in
 * what the two rails can measure rather than a disagreement about the labels.
 */
export const CODEX_ACTIVE_TIME_QUANTITIES: ActiveTimeQuantityStamp = {
  ...SESSION_SPLIT_QUANTITIES,
  ...PROJECT_DIGEST_QUANTITIES
};

/**
 * Paths whose names are figure-shaped but which are not figures, with reasons.
 *
 * The path-keyed twin of `NOT_ACTIVE_TIME_FIGURES`. `activeGapMinutes` is the
 * label saying how the figures were cut — the second third of the triple, not a
 * quantity of its own. Stamping it would claim the gap is a measurement of
 * something.
 */
export const NOT_ACTIVE_TIME_QUANTITY_PATHS: Readonly<Record<string, string>> = {
  activeGapMinutes: "the gap rule these figures were cut by, not a figure"
};
