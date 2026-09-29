import type { InitiativeResult, TeamInitiative } from "@ascenda-one/tool-contract";
import { readInitiatives } from "./http";
import { formatWindow } from "./studyJoin";

/**
 * The changes an organisation has published to the person this tool is paired
 * to, as `status` prints them. For the human running the command and no one
 * else: nothing in here is reachable from a hook, and none of it is ever
 * handed to an agent as context.
 *
 * Four things can be true when `status` looks, and each has its own sentence,
 * so a blank never has to stand for any of them:
 *
 * - it was not asked (no token on this install);
 * - it was asked and the token was not accepted;
 * - it was asked and the answer did not arrive or could not be read;
 * - it was answered, with a list that may be empty.
 */

/** How long `status` waits before saying it could not read the list. */
const READ_TIMEOUT_MS = 5000;

/**
 * The organisation's own wording for a scored result: one sentence per
 * outcome and per reason a figure was withheld. Keyed by the organisation's
 * codes, which are never printed. Anything not listed here falls back to a
 * sentence saying so, rather than to the code.
 */
export type InitiativeCopy = {
  outcomes: Record<string, string>;
  withheldReasons: Record<string, string>;
};

export const INITIATIVE_COPY: InitiativeCopy = {
  outcomes: {
    moved_as_declared: "Moved the way declared, beyond the cohort's own variation",
    moved_against_declared: "Moved the other way, beyond the cohort's own variation",
    moved_no_direction_declared: "Moved beyond the cohort's own variation; no direction was declared",
    within_own_variation: "No further from the baseline than the cohort's own week-to-week variation",
    withheld: "Withheld"
  },
  withheldReasons: {
    cohort_below_minimum: "the cohort was too small to report on when the scoring window closed",
    below_minimum_cohort: "the cohort was too small to report on when the scoring window closed",
    below_minimum_cohort_size: "the cohort was too small to report on when the scoring window closed",
    baseline_withheld: "the baseline was withheld"
  }
};

const OUTCOME_EMPTY = "Not stated";
const OUTCOME_UNKNOWN = "An outcome this app does not recognise";
const WITHHELD_UNKNOWN = "Withheld, for a reason this version of the app doesn't name yet.";

/** The wording for a declared direction. */
const DIRECTION_WORDS: Record<string, string> = {
  up: "Expected to rise",
  down: "Expected to fall",
  none_declared: "No direction declared"
};
const DIRECTION_UNKNOWN = "A direction this app does not recognise";

export type InitiativesStatusContext = {
  apiBaseUrl: string;
  /** `undefined` when this install holds no token: nothing is fetched. */
  eventWriteToken: string | undefined;
  /** What to run to pair again, e.g. `npx @ascenda-one/claude-code-hooks pair`. */
  pairCommand: string;
  fetchTimeoutMs?: number;
};

/** The lines `status` prints for this section, one string per line. Never throws. */
export async function initiativesStatusLines(ctx: InitiativesStatusContext): Promise<string[]> {
  const heading = "Changes your organisation has published to you";
  if (!ctx.eventWriteToken) {
    return [heading, "  Not checked: this install holds no token, so nothing was fetched."];
  }
  const read = await readInitiatives(ctx.apiBaseUrl, ctx.eventWriteToken, AbortSignal.timeout(ctx.fetchTimeoutMs ?? READ_TIMEOUT_MS));
  if (read.kind === "rejected") {
    // A bare 401 is all the server says, whatever the cause, so this doesn't
    // guess at one.
    return [
      heading,
      `  Couldn't check: the server turned this install's request down. If that keeps happening, pair again with \`${ctx.pairCommand}\`.`
    ];
  }
  if (read.kind === "failed") {
    return [heading, `  Couldn't check: ${read.reason}. Run status again to retry.`];
  }
  return [heading, ...renderInitiatives(read.initiatives)];
}

/** An empty list is its own sentence; a list with entries this version can't read says how many. */
export function renderInitiatives(entries: readonly unknown[], copy: InitiativeCopy = INITIATIVE_COPY): string[] {
  if (entries.length === 0) return ["  None published to you."];
  const lines: string[] = [];
  let unreadable = 0;
  for (const entry of entries) {
    const initiative = asInitiative(entry);
    if (!initiative) {
      unreadable += 1;
      continue;
    }
    lines.push(...renderOne(initiative, copy));
  }
  if (unreadable > 0) {
    lines.push(`  ${unreadable === 1 ? "1 entry" : `${unreadable} entries`} in the list couldn't be read by this version of the tool.`);
  }
  return lines;
}

function renderOne(initiative: TeamInitiative, copy: InitiativeCopy): string[] {
  const lines = [`  ${initiative.organisationName}: ${initiative.title}`];
  lines.push(`    ${describeStatus(initiative)}`);
  if (initiative.summaryForCohort) {
    for (const line of initiative.summaryForCohort.split(/\r?\n/)) lines.push(`    ${line}`);
  }
  if (initiative.direction) lines.push(`    ${DIRECTION_WORDS[initiative.direction] ?? DIRECTION_UNKNOWN}`);
  lines.push(`    Scoring window: ${formatWindowOrRaw(initiative.scoringStartUtc, initiative.scoringEndUtc)}`);
  // Whatever status it has now, a result that was scored is still shown.
  if (initiative.result) lines.push(...renderResult(initiative.result, initiative.measureUnit, copy));
  lines.push("");
  return lines;
}

function describeStatus(initiative: TeamInitiative): string {
  switch (initiative.status) {
    case "published":
      return "Published, not scored yet.";
    case "scored":
      return "Scored.";
    case "withdrawn":
      return initiative.withdrawnUtc
        ? `Withdrawn on ${formatDay(initiative.withdrawnUtc)}. It won't be scored.`
        : "Withdrawn. It won't be scored.";
    default:
      return "Status not recognised.";
  }
}

function renderResult(result: InitiativeResult, unit: string | null, copy: InitiativeCopy): string[] {
  const lines: string[] = [];
  // The unit is the organisation's own word for it, so it's printed as sent.
  const show = (n: number) => (unit ? `${figure(n)} ${unit}` : figure(n));

  if (result.value === null) {
    const why = copy.withheldReasons[result.withheldReason ?? ""];
    lines.push(`    ${why ? `Withheld: ${why}.` : WITHHELD_UNKNOWN}`);
    return lines;
  }
  lines.push(`    Result: ${show(result.value)}`);
  lines.push(`    ${movementLine(result)}`);
  lines.push(`    ${result.outcome ? (copy.outcomes[result.outcome] ?? OUTCOME_UNKNOWN) : OUTCOME_EMPTY}`);
  return lines;
}

/** How far the figure sits from the frozen baseline, in the app's words. */
function movementLine(result: InitiativeResult): string {
  if (result.outcome === "within_own_variation") return "No material change against frozen baseline";
  if (result.delta === null) return "No reading";
  if (result.delta > 0) return `Up ${figure(result.delta)} against frozen baseline`;
  if (result.delta < 0) return `Down ${figure(Math.abs(result.delta))} against frozen baseline`;
  return "No change against frozen baseline";
}

/** Prints a figure the way the ledger does: 5, not 5.0; 1.1 as it is. */
function figure(n: number): string {
  return String(Number(n.toPrecision(12)));
}

function asInitiative(value: unknown): TeamInitiative | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.title !== "string" || typeof o.status !== "string") return undefined;
  return {
    id: typeof o.id === "string" ? o.id : "",
    organisationName: typeof o.organisationName === "string" ? o.organisationName : "Your organisation",
    title: o.title,
    summaryForCohort: typeof o.summaryForCohort === "string" ? o.summaryForCohort : "",
    measureUnit: typeof o.measureUnit === "string" ? o.measureUnit : null,
    scoringStartUtc: typeof o.scoringStartUtc === "string" ? o.scoringStartUtc : "",
    scoringEndUtc: typeof o.scoringEndUtc === "string" ? o.scoringEndUtc : "",
    withdrawnUtc: typeof o.withdrawnUtc === "string" ? o.withdrawnUtc : null,
    status: o.status,
    direction: typeof o.direction === "string" ? o.direction : null,
    result: asResult(o.result)
  };
}

function asResult(value: unknown): InitiativeResult | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    scoredAtUtc: typeof r.scoredAtUtc === "string" ? r.scoredAtUtc : "",
    value: num(r.value),
    baselineValue: num(r.baselineValue),
    delta: num(r.delta),
    movement: typeof r.movement === "string" ? r.movement : null,
    outcome: typeof r.outcome === "string" ? r.outcome : "",
    withheldReason: typeof r.withheldReason === "string" ? r.withheldReason : null,
    basis: typeof r.basis === "string" ? r.basis : null
  };
}

function formatWindowOrRaw(startUtc: string, endUtc: string): string {
  if (Number.isNaN(Date.parse(startUtc)) || Number.isNaN(Date.parse(endUtc))) return "not given";
  return formatWindow(startUtc, endUtc);
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}
