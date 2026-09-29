/**
 * A change an organisation has declared: a title, its own summary, a scoring
 * window, and a result once scored. One per entry in the list a paired tool
 * can read; the list is empty when nothing has been published.
 *
 * `status` is an open word. `published`, `scored` and `withdrawn` are the
 * ones this version knows; a reader has to keep going on any other.
 */
export type InitiativeStatus = "published" | "scored" | "withdrawn" | (string & {});

/** Present once the change has been scored; `null` before. Every code in it is the organisation's own key, not display text. */
export type InitiativeResult = {
  scoredAtUtc: string;
  /** `null` when the organisation withheld the figure. Never `0` standing in for withheld. */
  value: number | null;
  baselineValue: number | null;
  delta: number | null;
  movement: "up" | "down" | "level" | (string & {}) | null;
  outcome: string;
  withheldReason: string | null;
  basis: string | null;
};

export type TeamInitiative = {
  id: string;
  organisationName: string;
  title: string;
  /** The organisation's own summary, as it wrote it. */
  summaryForCohort: string;
  measureUnit: string | null;
  scoringStartUtc: string;
  scoringEndUtc: string;
  withdrawnUtc: string | null;
  status: InitiativeStatus;
  /** The direction the organisation declared it expects: `up`, `down` or `none_declared`. Open, like `status`. */
  direction: string | null;
  result: InitiativeResult | null;
};
