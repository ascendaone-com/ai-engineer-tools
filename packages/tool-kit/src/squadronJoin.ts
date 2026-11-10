import * as readline from "node:readline";
import { randomInt } from "node:crypto";
import { studyJoinConfirmUrl } from "./confirmLinks";
import { AscendaApiError, getStudyJoinStatus, previewJoinCode, startSquadronJoin } from "./http";
import type { JoinCodePreview, SquadronJoinStatus } from "./http";

/**
 * `squadron <booking reference>`: take a seat in a Squadron sortie from the
 * command line, on any machine with a paired collector.
 *
 * It's `join`'s flow with a sortie's questions. The same rules hold:
 *
 * - An interactive terminal or nothing. An agent or a script can't seat a
 *   person in a sortie.
 * - What is shared is printed before the question, and the default answer is
 *   "Not now".
 * - The seat is confirmed by a signed-in person, on the `/join/{deviceCode}`
 *   page or in the app, because a sortie needs an account and the tool's
 *   write token isn't one.
 *
 * The preview is the anonymous `GET /api/share/join/{code}` the app already
 * reads. The join itself goes to the CLI door, `POST /v1/org-study-join-sessions`,
 * with the callsign, aircraft and colour beside the booking reference, then
 * polls that session's status like `join` does.
 */
export type SquadronJoinContext = {
  apiBaseUrl: string;
  eventWriteToken: string;
  /** How the agent is named to a person, e.g. `Claude Code`. */
  displayName: string;
  bookingReference: string;
  /** From flags. Each one asked for when absent. */
  callsign?: string;
  aircraft?: string;
  colour?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /** Test-only. */
  pollIntervalMs?: number;
  /** Test-only: a fixed callsign in place of a generated one. */
  generateCallsign?: () => string;
};

/** The contract's lists, used only when a preview leaves them out. */
export const SQUADRON_AIRCRAFT = ["trainer", "airliner", "glider", "fighter", "stealth", "floatplane"] as const;
export const SQUADRON_COLOURS = ["orange", "yellow", "ivory", "charcoal", "grey", "red"] as const;

const CALLSIGN_WORDS = ["Kestrel", "Falcon", "Heron", "Swift", "Osprey", "Raven", "Merlin", "Puffin", "Condor", "Harrier", "Kite", "Tern"];

/** `Kestrel 27`: a word and two digits, so two people who both press Enter rarely collide. */
export function generateCallsign(): string {
  return `${CALLSIGN_WORDS[randomInt(CALLSIGN_WORDS.length)]} ${String(randomInt(10, 100))}`;
}

/** Six letters or digits, upper-cased. Spaces and dashes a person might type are dropped. */
export function normaliseBookingReference(raw: string | undefined): string | undefined {
  const cleaned = (raw ?? "").replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{6}$/.test(cleaned) ? cleaned : undefined;
}

/** Callsign rules from the backend: trimmed, 1 to 40 characters, no control characters. */
export function callsignProblem(callsign: string): string | undefined {
  const trimmed = callsign.trim();
  if (trimmed.length === 0) return "A callsign can't be empty.";
  if (trimmed.length > 40) return "A callsign is 40 characters at most.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "A callsign can't contain control characters.";
  return undefined;
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 11 * 60 * 1000;

export async function runSquadronJoin(ctx: SquadronJoinContext): Promise<number> {
  const stdin = ctx.stdin ?? process.stdin;
  const stdout = ctx.stdout ?? process.stdout;
  const stderr = ctx.stderr ?? process.stderr;
  const print = (line = "") => stdout.write(`${line}\n`);

  if (!stdin.isTTY || !stdout.isTTY) {
    stderr.write("squadron needs an interactive terminal (stdin and stdout). Run it directly, not from a script or a pipe.\n");
    return 0;
  }

  const reference = normaliseBookingReference(ctx.bookingReference);
  if (!reference) {
    stderr.write("A booking reference is six letters or digits, like FEFBDH.\n");
    return 1;
  }

  let preview: JoinCodePreview;
  try {
    preview = await previewJoinCode(ctx.apiBaseUrl, reference);
  } catch (error) {
    stderr.write(`${describeSquadronError(error)}\n`);
    return 1;
  }
  const jam = preview.jam;
  if (preview.labRole !== "Jam" || !jam) {
    stderr.write(`${reference} isn't a Squadron booking reference. If it's a study code, run join instead.\n`);
    return 1;
  }
  if (jam.acceptsJoins === false) {
    stderr.write(jam.isLocked ? "This sortie's gate is closed. Ask the host to open it.\n" : "This sortie isn't taking new pilots.\n");
    return 1;
  }

  const aircraftList = jam.aircraft?.length ? jam.aircraft : [...SQUADRON_AIRCRAFT];
  const colourList = jam.colours?.length ? jam.colours : [...SQUADRON_COLOURS];

  for (const [flag, value, list] of [["--aircraft", ctx.aircraft, aircraftList], ["--colour", ctx.colour, colourList]] as const) {
    if (value !== undefined && !list.includes(value.trim().toLowerCase())) {
      stderr.write(`${flag} must be one of: ${list.join(", ")}.\n`);
      return 1;
    }
  }
  if (ctx.callsign !== undefined) {
    const problem = callsignProblem(ctx.callsign);
    if (problem) {
      stderr.write(`${problem}\n`);
      return 1;
    }
  }

  print();
  print(`Squadron: ${jam.name ?? preview.labName ?? reference}`);
  if (jam.mission) print(`Mission: ${jam.mission}`);
  print(describeGate(jam));
  print();

  const prompt = createPrompter(stdin, stdout);
  try {
    let callsign = ctx.callsign?.trim();
    if (callsign === undefined) {
      const suggested = (ctx.generateCallsign ?? generateCallsign)();
      for (;;) {
        const answer = await prompt.ask(`Callsign [${suggested}]: `);
        if (answer === undefined) return notNow(print);
        const chosen = answer === "" ? suggested : answer;
        const problem = callsignProblem(chosen);
        if (!problem) {
          callsign = chosen.trim();
          break;
        }
        print(problem);
      }
    }

    let aircraft = ctx.aircraft?.trim().toLowerCase();
    if (aircraft === undefined) {
      const suggested = aircraftList[randomInt(aircraftList.length)];
      aircraft = await askFromList(prompt, print, "Aircraft", aircraftList, suggested);
      if (aircraft === undefined) return notNow(print);
    }

    let colour: string | undefined = ctx.colour?.trim().toLowerCase();
    if (colour === undefined) {
      const picked = await askFromList(prompt, print, "Colour", colourList, "", "dealt for you");
      if (picked === undefined) return notNow(print);
      colour = picked === "" ? undefined : picked;
    }

    print();
    print(`You'll confirm as ${callsign}, ${aircraft}${colour ? `, ${colour}` : ""}. The confirm page lets you change any of them.`);
    print();
    print("Joining shares, with this squadron only:");
    print(`  your activity counts from ${ctx.displayName}: prompts, tool calls, turns and edits, as numbers`);
    print("  your callsign and aircraft, which the other pilots see");
    print("Never your prompts, code, file names or project names.");
    print("Sharing stops on the date the server gives when you join. It's printed then.");
    print();
    print("  1) Join");
    print("  2) Not now");
    print();
    const choice = await prompt.ask("Choice [Not now]: ");
    if (choice === undefined || !/^(1|join|y|yes)$/i.test(choice)) return notNow(print);

    prompt.close();

    let start;
    try {
      start = await startSquadronJoin(ctx.apiBaseUrl, ctx.eventWriteToken, { joinCode: reference, handle: callsign, aircraft, colour });
    } catch (error) {
      // The preview just found this sortie, so a 404 here is the door, not
      // the code: a server whose command-line join doesn't take sorties yet.
      const doorClosed = error instanceof AscendaApiError && error.status === 404 && !error.errorCode?.startsWith("jam_");
      stderr.write(doorClosed
        ? "This server can't seat you in a sortie from the command line yet. Join from the Ascenda app instead.\n"
        : `${describeSquadronError(error)}\n`);
      return 1;
    }
    if (start.kind !== undefined && start.kind !== "jam") {
      stderr.write(`${reference} opened a study join, not a sortie. Run join instead.\n`);
      return 1;
    }

    print();
    const confirmUrl = studyJoinConfirmUrl(ctx.apiBaseUrl, start.deviceCode);
    if (confirmUrl) {
      print(`Open this link to confirm: ${confirmUrl}`);
      print(`Or confirm in the Ascenda app with code ${start.deviceCode}.`);
    } else {
      print(`Confirm in the Ascenda app with code ${start.deviceCode}`);
    }
    print(`Waiting for confirmation (expires ${formatLocalTime(start.expiresAt)})...`);

    const pollIntervalMs = ctx.pollIntervalMs ?? POLL_INTERVAL_MS;
    const deadline = Math.min(Date.parse(start.expiresAt) || Date.now() + POLL_TIMEOUT_MS, Date.now() + POLL_TIMEOUT_MS);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      let poll: SquadronJoinStatus;
      try {
        poll = (await getStudyJoinStatus(ctx.apiBaseUrl, ctx.eventWriteToken, start.joinSessionId)) as SquadronJoinStatus;
      } catch (error) {
        if (!(error instanceof AscendaApiError) || (error.status >= 500 && error.status <= 599)) continue;
        stderr.write(`${describeSquadronError(error)}\n`);
        return 1;
      }
      if (poll.status === "pending") continue;
      if (poll.status === "confirmed") {
        const until = poll.endUtc ?? poll.jam?.endUtc ?? leaseEnd(poll.jam ?? {});
        const seat = poll.jam?.handle ? ` as ${poll.jam.handle}` : "";
        print();
        print(poll.jam?.alreadyJoined ? `You already have a seat${seat}.` : `Joined${seat}.`);
        print(until
          ? `Your activity counts are shared with this squadron until ${formatLocalDate(until)}.`
          : "Your activity counts are shared with this squadron until the sortie's sharing ends. The server didn't give a date.");
        print(describeStatusAfterJoin(poll.jam));
        return 0;
      }
      if (poll.status === "expired") {
        print();
        print("This code expired before it was confirmed. Run squadron again for a fresh code.");
        return 1;
      }
      print();
      print(describeSquadronRefusal(poll.refusedReason ?? undefined));
      return 1;
    }
    print();
    print("Timed out waiting for confirmation. Run squadron again for a fresh code.");
    return 1;
  } finally {
    prompt.close();
  }
}

/**
 * When sharing stops, if the server doesn't say: the contract's lease rule,
 * `(startedAt ?? quorumDeadline) + durationMinutes + 7 days` (§3).
 */
export function leaseEnd(jam: { startedAt?: string; quorumDeadline?: string; durationMinutes?: number }): string | undefined {
  const from = Date.parse(jam.startedAt ?? jam.quorumDeadline ?? "");
  if (Number.isNaN(from) || typeof jam.durationMinutes !== "number") return undefined;
  return new Date(from + (jam.durationMinutes + 7 * 24 * 60) * 60_000).toISOString();
}

function notNow(print: (line?: string) => void): number {
  print("Not now.");
  return 0;
}

async function askFromList(
  prompt: Prompter,
  print: (line?: string) => void,
  label: string,
  list: readonly string[],
  suggested: string,
  emptyMeans?: string
): Promise<string | undefined> {
  print(`${label === "Aircraft" ? "Aircraft" : `${label}s`}: ${list.join(", ")}`);
  for (;;) {
    const answer = await prompt.ask(`${label} [${emptyMeans ?? suggested}]: `);
    if (answer === undefined) return undefined;
    if (answer === "") return suggested;
    const value = answer.toLowerCase();
    const byNumber = /^\d+$/.test(value) ? list[Number(value) - 1] : undefined;
    if (byNumber) return byNumber;
    if (list.includes(value)) return value;
    print(`Pick one of: ${list.join(", ")}.`);
  }
}

/** The gate in one line. */
export function describeGate(jam: NonNullable<JoinCodePreview["jam"]>): string {
  const length = jam.durationMinutes ? `${jam.durationMinutes}-minute flight plan` : "flight plan";
  if (jam.status === "live") return `In the air now, ${length}.`;
  const have = jam.activeParticipants ?? 0;
  const need = jam.minParticipants ?? 0;
  const deadline = jam.quorumDeadline ? `, gate closes ${formatLocalTime(jam.quorumDeadline)}` : "";
  return need > have
    ? `On the ground: ${have} of ${need} pilots in${deadline}. The ${length} starts when the squadron fills.`
    : `On the ground${deadline}. ${length[0].toUpperCase()}${length.slice(1)}.`;
}

function describeStatusAfterJoin(jam: SquadronJoinStatus["jam"]): string {
  if (!jam) return "Open the Ascenda app to watch the squadron.";
  if (jam.status === "live" && jam.expiresAt) return `The squadron is in the air until ${formatLocalTime(jam.expiresAt)}. Open the Ascenda app to watch.`;
  const have = jam.activeParticipants;
  const need = jam.minParticipants;
  if (have !== undefined && need !== undefined && need > have) return `${have} of ${need} pilots in. The clock starts when the squadron fills.`;
  return "Open the Ascenda app to watch the squadron.";
}

/** Plain sentences for the backend's stable codes (contract §1 and §3). */
export function describeSquadronRefusal(code: string | undefined): string {
  switch (code) {
    case "join_code_not_found": return "No sortie has that booking reference, or it has ended.";
    case "jam_closed": return "That sortie has ended.";
    case "jam_locked": return "This sortie's gate is closed. Ask the host to open it.";
    case "jam_already_left": return "You left this sortie, and leaving is final. Ask the host for a new one.";
    case "jam_handle_taken": return "Another pilot has that callsign. Run squadron again and pick another.";
    case "jam_requires_account": return "A sortie needs a signed-in Ascenda account, not a guest one.";
    case "jam_handle_required":
    case "jam_handle_too_long":
    case "jam_handle_invalid": return "The server didn't accept that callsign. Run squadron again and pick another.";
    case "jam_aircraft_unknown": return "The server didn't recognise that aircraft.";
    case "jam_colour_unknown": return "The server didn't recognise that colour.";
    case "unknown_mode": return "This server's join door didn't accept a sortie. It may be older than this command.";
    case "too_many_open_sessions": return "Too many joins are waiting to be confirmed. Confirm or let one expire, then try again.";
    case "jam_not_enabled": return "Squadron isn't switched on for this server yet.";
    default: return code ? `The server refused the join (${code}).` : "The server refused the join.";
  }
}

function describeSquadronError(error: unknown): string {
  if (error instanceof AscendaApiError) {
    if (error.status === 401) return "This collector's pairing isn't accepted any more. Run pair, then try again.";
    if (error.status === 404 && !error.errorCode?.startsWith("jam_")) return describeSquadronRefusal("join_code_not_found");
    return describeSquadronRefusal(error.errorCode);
  }
  return `Couldn't reach Ascenda: ${error instanceof Error ? error.message : String(error)}`;
}

type Prompter = { ask(question: string): Promise<string | undefined>; close(): void };

/**
 * One readline interface for every question, so lines typed ahead aren't
 * lost between questions. EOF (Ctrl-D) resolves to `undefined`, read as
 * "Not now", never a hang.
 */
function createPrompter(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): Prompter {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let closed = false;
  const lines: string[] = [];
  let waiting: ((value: string | undefined) => void) | undefined;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line.trim());
    } else {
      lines.push(line.trim());
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(undefined);
    }
  });
  return {
    ask(question) {
      if (lines.length > 0) {
        stdout.write(question);
        return Promise.resolve(lines.shift()!);
      }
      if (closed) return Promise.resolve(undefined);
      stdout.write(question);
      return new Promise((resolve) => { waiting = resolve; });
    },
    close() {
      if (!closed) rl.close();
    }
  };
}

function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatLocalDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}
