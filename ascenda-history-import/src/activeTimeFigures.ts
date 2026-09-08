import {
  ASCENDA_ELAPSED_QUANTITIES,
  type AscendaActiveTimeQuantity
} from "@ascenda-one/tool-contract";

/**
 * Which quantity each active-time figure in the handoff reports.
 *
 * **Keyed on `Interface.field`, never on the field name alone**, because in this
 * file a bare name is genuinely ambiguous: `handsOnMinutes` is summed across
 * sessions on {@link HandoffProjectDigest} and unioned on
 * {@link ProjectElapsedActive}, one nesting level apart under one spelling. Both
 * are deliberate — the sums are kept because agent-hours is a real quantity and
 * because removing them would silently change every existing reader — and until
 * this table nothing mechanical told them apart. That is the asc-core-be#194
 * shape: two figures sharing a name with nothing on either distinguishing them.
 *
 * The vocabulary itself is vendored in
 * `packages/tool-contract/contracts/active-time-quantities.v1.json`, so a name
 * used here that the backend does not own fails a build rather than a dashboard.
 *
 * **The assignments are not vendored — three repos keep three of these by hand,
 * and changing one means reading the other two.** See asc-core-be
 * `docs/ACTIVE_TIME.md`, "The vocabulary is shared; the assignments are three
 * hand-kept registries", for the sibling paths and the one-line test.
 */
export const ACTIVE_TIME_FIGURES: Readonly<Record<string, AscendaActiveTimeQuantity>> = {
  // One session cannot overlap itself, so its figures are already elapsed.
  // `activeMinutes` is gap-split minutes at the 5-minute rule; hands-on and
  // supervising are its two halves and must never be rendered as one.
  "HandoffSession.activeMinutes": "coverage",
  "HandoffSession.handsOnMinutes": "hands_on",
  "HandoffSession.agentSupervisingMinutes": "supervising",

  "CodexHandoffSession.activeMinutes": "coverage",
  "CodexHandoffSession.handsOnMinutes": "hands_on",
  "CodexHandoffSession.agentSupervisingMinutes": "supervising",

  // Summed over sessions, from the sessions' own minute figures. On the
  // reference machine these came to 4.2x the wall clock of the period they
  // described, which is why they are agent-hours and not time.
  "HandoffProjectDigest.handsOnMinutes": "hands_on_agent_hours",
  "HandoffProjectDigest.agentSupervisingMinutes": "supervising_agent_hours",

  // The same time unioned instead of added up. This is the figure to render as
  // time, and the reason the pair above needed a different name rather than a
  // warning comment.
  "ProjectElapsedActive.handsOnMinutes": "hands_on",
  "ProjectElapsedActive.agentSupervisingMinutes": "supervising",

  // Per local day, both readings side by side so a window can state its own
  // concurrency instead of borrowing a corpus-wide ratio.
  "ProjectElapsedDay.handsOnMinutes": "hands_on",
  "ProjectElapsedDay.agentSupervisingMinutes": "supervising",
  "ProjectElapsedDay.summedHandsOnMinutes": "hands_on_agent_hours",
  "ProjectElapsedDay.summedAgentSupervisingMinutes": "supervising_agent_hours",

  // One local day of one session — the day's share of that session's own split.
  // A session cannot overlap itself, so these are elapsed. They sat in
  // daySlice.ts unlabelled while the scan read only localHandoff.ts; the app
  // workspace registers a class of the same name with the same three
  // quantities, so the two rails already agreed and one could not see its own
  // copy.
  "SessionDaySlice.activeMinutes": "coverage",
  "SessionDaySlice.handsOnMinutes": "hands_on",
  "SessionDaySlice.agentSupervisingMinutes": "supervising"
};

/**
 * Fields whose names are figure-shaped but which are not figures, with reasons.
 *
 * `activeGapMinutes` is the label saying how the figures were cut — the second
 * third of the `{quantity, gapMinutes, basis}` triple, not a quantity of its
 * own. Registering it would claim the gap is a measurement of something.
 */
export const NOT_ACTIVE_TIME_FIGURES: Readonly<Record<string, string>> = {
  "HandoffFile.activeGapMinutes": "the gap rule these figures were cut by, not a figure",
  "CodexHandoffFile.activeGapMinutes": "the gap rule these figures were cut by, not a figure",
  "CrossStoreElapsedFile.activeGapMinutes": "the gap rule these figures were cut by, not a figure"
};

/** The quantity a figure reports, or undefined when it is not registered. */
export function quantityOf(iface: string, field: string): AscendaActiveTimeQuantity | undefined {
  return ACTIVE_TIME_FIGURES[`${iface}.${field}`];
}

/**
 * Whether a figure may be rendered as elapsed time — "where your week went".
 *
 * A summed figure quoted as elapsed time is the specific defect the
 * elapsed/summed split exists to prevent.
 */
export function isElapsed(quantity: AscendaActiveTimeQuantity): boolean {
  return ASCENDA_ELAPSED_QUANTITIES[quantity];
}
