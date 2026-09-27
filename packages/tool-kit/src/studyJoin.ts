import * as readline from "node:readline";
import { AscendaApiError, getStudyJoinStatus, startStudyJoin } from "./http";
import type { StudyJoinMode, StudyJoinStartResponse, StudyJoinStatusResponse } from "@ascenda-one/tool-contract";

/**
 * `join <code>` — join an organisation's study in Report mode, from any of
 * the CLI agent adapters that ship a `join` command. Modelled on `pair`
 * (`runPair` in `ascenda-claude-code-hooks/src/cli.ts`): a code display, a
 * poll loop, and the same timeout — but this one carries a live product
 * decision, so it asks first instead of pairing on sight.
 *
 * `report` is the only mode this asks about. A full Study mode needs a
 * signed-in surface — the Ascenda app, or the web page that finishes
 * pairing — which is where a person, not a script, decides that; the prompt
 * below says so and points there.
 *
 * ## Why the question comes after one network call, not zero
 *
 * The organisation's name, the study's title and window, and every grant
 * Report mode carries are what the person is asked to decide about, and none
 * of it is known on this machine — it lives behind the join code. So one
 * call (`startStudyJoin`) always runs before the question: there is no way
 * to print "before the answer, list every grant" without first asking the
 * server what they are.
 *
 * That call mints a *pending* session — the same shape `pair`'s
 * `createPairingSession` already has. Nothing is granted by it: a person
 * still has to confirm the short code it returns on a signed-in surface, so
 * a declined prompt leaves an unconfirmed session that simply expires. The
 * one request this module refuses to make on a decline is the one that
 * would matter — polling for confirmation. That refusal is unconditional:
 * choosing "Not now", pressing Enter, hitting EOF, or having no TTY at all
 * all end here, before that call, every time.
 */
export type StudyJoinContext = {
  apiBaseUrl: string;
  /** The tool's own write token — the same credential ingest already uses. */
  eventWriteToken: string;
  /** How the agent is named to a person, e.g. `Claude Code`. */
  displayName: string;
  joinCode: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /** Test-only: overrides {@link POLL_INTERVAL_MS} so a suite need not wait out a real poll cycle. */
  pollIntervalMs?: number;
};

const STUDY_JOIN_MODE: StudyJoinMode = "report";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 11 * 60 * 1000;

export async function runStudyJoin(ctx: StudyJoinContext): Promise<number> {
  const stdin = ctx.stdin ?? process.stdin;
  const stdout = ctx.stdout ?? process.stdout;
  const stderr = ctx.stderr ?? process.stderr;
  const print = (line: string) => stdout.write(`${line}\n`);

  // Refused before anything else, and before the network call below: an
  // agent must never be able to join a person to a study, and a script or a
  // pipe is exactly the caller that cannot answer the question that follows.
  if (!stdin.isTTY || !stdout.isTTY) {
    stderr.write("join needs an interactive terminal (stdin and stdout). Run it directly, not from a script or a pipe.\n");
    return 0;
  }

  if (!ctx.joinCode) {
    stderr.write("Usage: join <code>\n");
    return 1;
  }

  let start: StudyJoinStartResponse;
  try {
    start = await startStudyJoin(ctx.apiBaseUrl, ctx.eventWriteToken, ctx.joinCode, STUDY_JOIN_MODE);
  } catch (error) {
    stderr.write(`${describeStartError(error)}\n`);
    return 1;
  }

  print("");
  print(`${start.organisationName} — ${start.studyTitle}`);
  print(start.studyWindow);
  print("");
  print("Report (30 days) grants:");
  for (const grant of start.grants) print(`  ${grant}`);
  print("");
  print("Study mode needs the Ascenda app. Open the app to join that way instead.");
  print("");
  print("Join in:");
  print("  1) Report (30 days)");
  print("  2) Not now");
  print("");

  const answer = await askChoice(stdin, stdout);
  if (!/^(1|report)$/i.test(answer)) {
    print("Not now.");
    return 0;
  }

  print("");
  print(`Confirm in the Ascenda app, or on the pairing page — code ${start.shortCode}`);
  print(`Waiting for confirmation (expires ${start.expiresAt})...`);

  const pollIntervalMs = ctx.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Math.min(Date.parse(start.expiresAt) || Date.now() + POLL_TIMEOUT_MS, Date.now() + POLL_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    let poll: StudyJoinStatusResponse;
    try {
      poll = await getStudyJoinStatus(ctx.apiBaseUrl, ctx.eventWriteToken, start.joinSessionId);
    } catch (error) {
      stderr.write(`${describeStartError(error)}\n`);
      return 1;
    }
    if (poll.status === "pending") continue;
    if (poll.status === "confirmed") {
      print("");
      print("Joined. Granted:");
      for (const grant of poll.grants ?? start.grants) print(`  ${grant}`);
      print("");
      print("Each of these can be turned off separately, in the app's consent settings.");
      print("The organisation sees group counts, never who joined.");
      return 0;
    }
    // expired or refused — the backend's own words, not a guess at why.
    print("");
    print(poll.reason ?? `Join ${poll.status}.`);
    return 1;
  }
  print("");
  print("Timed out waiting for confirmation. Run join again for a fresh code.");
  return 1;
}

/**
 * One question, answered once. Uses the callback form of `readline`, not
 * `readline/promises`: its `question()` promise never settles on EOF (Ctrl-D
 * at an empty prompt closes the interface without a `line` event), which
 * would hang this command forever on exactly the input it must treat as
 * "Not now". Racing `question`'s callback against `close` is what makes EOF
 * resolve instead of hang.
 */
function askChoice(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value.trim());
    };
    rl.question("Choice [Not now]: ", finish);
    rl.once("close", () => finish(""));
  });
}

/**
 * Plain words for the codes this call can fail with, not the raw error body —
 * "Expiry and refusal print the backend's reason in plain words" applies here
 * too, before a join session even exists to carry one.
 */
const START_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  unknown_join_code: "That code is not a study anyone can join. Check it and try again.",
  unsupported_mode: "This tool only offers Report mode from the command line.",
  consent_missing_or_expired: "This tool's own telemetry consent has lapsed. Re-pair it, then try again."
};

function describeStartError(error: unknown): string {
  if (error instanceof AscendaApiError) {
    if (error.errorCode && START_ERROR_MESSAGES[error.errorCode]) return START_ERROR_MESSAGES[error.errorCode];
    if (error.status === 401) return "This tool's pairing was rejected. Re-pair it, then try again.";
    return `Could not reach the join code (HTTP ${error.status}).`;
  }
  return error instanceof Error ? error.message : String(error);
}
