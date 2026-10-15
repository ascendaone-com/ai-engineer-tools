import * as fs from "node:fs";
import { pairingConfirmLines } from "./confirmLinks";
import { formatWindow, gitOfferLine } from "./studyJoin";
import { AscendaApiError, createPairingSession, getPairingStatus } from "./http";
import type { PairingSessionResponse, PairingStatusResponse, PairingStudyJoinStatus } from "@ascenda-one/tool-contract";

/**
 * Pairing and joining a study in one confirm.
 *
 * `participate` hands the first agent it pairs the organisation's join code.
 * The adapter's `setup` runs as a child process, so the code goes in through
 * the environment and what happened comes back through a file the parent
 * names. Both are unset in every other run, and `setup` pairs as it always
 * has.
 *
 * Whether the pairing carries a join is read from the create response: a
 * `studyJoin` object means it does. A server that doesn't return one is
 * treated as not knowing the field, and the outcome says so, so the caller
 * can join the old way.
 */
export const PAIR_ORG_JOIN_CODE_ENV = "ASCENDA_PAIR_ORG_JOIN_CODE";
export const PAIR_JOIN_OUTCOME_FILE_ENV = "ASCENDA_PAIR_JOIN_OUTCOME_FILE";

export type PairingJoinOutcome = {
  /** `carried`: the server took the code. `not_carried`: it didn't answer with a join. `refused`: it named the code a problem. `none`: setup never got as far as asking. */
  join: "carried" | "not_carried" | "refused" | "none";
  /** How the pairing itself ended. */
  pairing: "paired" | "cancelled" | "expired" | "gave_up";
  /** The last join status the poll returned. */
  studyJoin?: PairingStudyJoinStatus;
  /** For `refused`: the sentence shown to the person. */
  message?: string;
};

/** Codes the create door answers a bad join code with: the same ones the join door uses. */
const CREATE_REFUSALS: Readonly<Record<string, string>> = {
  join_code_not_found: "That code is not a study anyone can join. Check it and try again.",
  no_live_study: "There's nothing open to join with that code right now.",
  unknown_mode: "This tool only offers Report mode from the command line."
};

/** How long to keep asking after the token arrives for the join to settle. */
const JOIN_SETTLE_MS = 60_000;

export type PairingAttempt = {
  session: PairingSessionResponse;
  /** Whether this pairing carries the join. */
  carriesJoin: boolean;
  /** Set when the server refused the code at create. The pairing was then made without it. */
  refusal?: string;
};

/**
 * `createPairingSession`, carrying the join code from the environment when
 * there is one. A refused code is reported and the pairing goes ahead
 * without it. Any other rejection of the extra fields is retried plain.
 */
export async function createPairingAttempt(
  apiBaseUrl: string,
  toolInstallationId: string,
  toolType: string,
  displayName: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<PairingAttempt> {
  const orgJoinCode = env[PAIR_ORG_JOIN_CODE_ENV]?.trim();
  if (!orgJoinCode) return { session: await createPairingSession(apiBaseUrl, toolInstallationId, toolType, displayName), carriesJoin: false };

  let refusal: string | undefined;
  try {
    const session = await createPairingSession(apiBaseUrl, toolInstallationId, toolType, displayName, orgJoinCode);
    return { session, carriesJoin: session.studyJoin !== undefined };
  } catch (error) {
    if (!(error instanceof AscendaApiError) || error.status >= 500) throw error;
    refusal = error.errorCode ? CREATE_REFUSALS[error.errorCode] : undefined;
  }
  return { session: await createPairingSession(apiBaseUrl, toolInstallationId, toolType, displayName), carriesJoin: false, refusal };
}

/**
 * What to print while waiting. A pairing that carries a join is confirmed
 * from its link only: a code typed in the app is turned away for it, so the
 * code is left out rather than offered.
 */
export function pairingAttemptLines(attempt: PairingAttempt): string[] {
  const { session } = attempt;
  const join = attempt.carriesJoin ? session.studyJoin : undefined;
  if (!join) return pairingConfirmLines(session.qrUrl, session.code);
  const gitOffer = gitOfferLine(join.optionalImportStores);
  return [
    `This also joins ${join.organisationName} (${formatWindow(join.windowStartUtc, join.windowEndUtc)}). The page shows what you'd share before you confirm.`,
    ...(gitOffer ? [gitOffer] : []),
    `Open this link to confirm: ${session.qrUrl}`
  ];
}

/**
 * Once the token is in, waits for the join to leave `pending`. The same
 * confirm settles both, so this is normally one poll.
 */
export async function settleStudyJoin(apiBaseUrl: string, pairingSessionId: string, last: PairingStudyJoinStatus | undefined, wait = 1000): Promise<PairingStudyJoinStatus | undefined> {
  let current = last;
  const deadline = Date.now() + JOIN_SETTLE_MS;
  while (current && current.status === "pending" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    let status: PairingStatusResponse;
    try {
      status = await getPairingStatus(apiBaseUrl, pairingSessionId);
    } catch {
      continue;
    }
    current = status.studyJoin ?? current;
  }
  return current;
}

/** Tells the parent how it went. A write that fails is ignored: the pairing is what matters here. */
export function writePairingJoinOutcome(outcome: PairingJoinOutcome, env: NodeJS.ProcessEnv = process.env): void {
  const file = env[PAIR_JOIN_OUTCOME_FILE_ENV]?.trim();
  if (!file) return;
  try {
    fs.writeFileSync(file, `${JSON.stringify(outcome)}\n`, { mode: 0o600 });
  } catch {
    // The parent reads a missing file as "none".
  }
}

/** The outcome for an attempt that has finished its wait. */
export function pairingJoinOutcome(attempt: PairingAttempt | undefined, pairing: PairingJoinOutcome["pairing"], studyJoin: PairingStudyJoinStatus | undefined): PairingJoinOutcome {
  if (!attempt) return { join: "none", pairing };
  if (attempt.refusal) return { join: "refused", pairing, message: attempt.refusal };
  return { join: attempt.carriesJoin ? "carried" : "not_carried", pairing, studyJoin };
}
