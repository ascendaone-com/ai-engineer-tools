import type { StudyNotice } from "@ascenda-one/tool-contract";
import { AscendaApiError, markStudyNoticeShown, readStudyNotices, setStudyObjection } from "./http";

/**
 * The purposes an organisation counts its people for unless they object, as
 * `status` prints them, and the `object` command that objects or undoes it.
 *
 * An organisation can record that it counts some purposes of its own study on
 * a basis other than a grant: legitimate interests, or a collective
 * agreement. For those, a person is counted unless they object, and objecting
 * is one command with no reason asked. It takes effect from the next report.
 *
 * The rules this module keeps, each pinned in `studyNotices.test.cjs`:
 *
 * - The word "consent" never appears for these purposes. A notice isn't a
 *   grant, and saying it is would misstate the basis the organisation chose.
 * - Nothing about anyone else is shown. The server sends nothing about other
 *   people, and nothing here would print it if it did.
 * - Only three purposes can be noticed: live tool telemetry, the imported
 *   history, and the work-pattern axes. An entry for any other code is
 *   never shown as "Counted unless you object".
 * - When the server doesn't have this read, or nothing is noticed, `status`
 *   prints exactly what it printed before this module existed: no heading,
 *   no blank line, nothing.
 * - The wording matches the Ascenda app's study card, line for line. Change
 *   it there and here together.
 */

/** How long `status` waits before giving up on the read. */
const READ_TIMEOUT_MS = 5000;

/** The name of a noticed purpose on every surface. The server sends it too, and its own wins. */
const NOTICE_LABEL = "Counted unless you object";
const PROCESSOR = "Ascenda";

export type NoticedPurpose = {
  code: number;
  /** What a person types after `object`. */
  slug: string;
  /** The purpose's title on the app's study card. */
  title: string;
};

/**
 * The closed list of purposes an organisation may count unless a person
 * objects. Growing it is a decision, never a configuration change, and the
 * test that pins it fails when it changes.
 */
export const NOTICED_PURPOSES: readonly NoticedPurpose[] = [
  { code: 501, slug: "telemetry", title: "Live tool telemetry" },
  { code: 507, slug: "import", title: "One-time import of past AI work" },
  { code: 11, slug: "work-patterns", title: "Work-pattern axes in the group figures" }
];

/** Plain words for the bases the server can send as a key. */
const BASIS_WORDS: Readonly<Record<string, string>> = {
  legitimate_interests: "Legitimate interests",
  collective_agreement: "Collective agreement"
};
// Any other key prints the organisation's own words from `basisLabel`.

export type StudyNoticesStatusContext = {
  apiBaseUrl: string;
  /** `undefined` when this install holds no token: nothing is fetched and nothing is printed. */
  eventWriteToken: string | undefined;
  /** How a person runs this tool's commands, e.g. `npx @ascenda-one/claude-code-hooks`. */
  commandPrefix: string;
  fetchTimeoutMs?: number;
  /** Test-only: the instant "not counted before" is measured against. */
  now?: Date;
};

export type StudyNoticesStatus = {
  /** The lines `status` prints for this section, or none when nothing noticed can be shown. */
  lines: string[];
  /**
   * Tells the server the notice was shown, for each printed purpose it hasn't
   * been shown for yet. The caller runs this only after printing `lines` to a
   * terminal a person is looking at: never from a pipe, a script or an agent,
   * because the notice period starts when this lands. Never throws.
   */
  markShown: () => Promise<void>;
};

/**
 * Reads the list and renders it. Never throws.
 *
 * An older server, a token the server turned down, and a read that didn't
 * arrive all print nothing here. The section above, which reads with the
 * same token from the same server, already says when the token was refused
 * or the server couldn't be reached.
 */
export async function studyNoticeStatus(ctx: StudyNoticesStatusContext): Promise<StudyNoticesStatus> {
  const nothing: StudyNoticesStatus = { lines: [], markShown: async () => {} };
  const token = ctx.eventWriteToken;
  if (!token) return nothing;
  const read = await readStudyNotices(ctx.apiBaseUrl, token, AbortSignal.timeout(ctx.fetchTimeoutMs ?? READ_TIMEOUT_MS));
  if (read.kind !== "ok") return nothing;
  const lines = renderStudyNotices(read.notices, ctx.commandPrefix, ctx.now);
  if (lines.length === 0) return nothing;
  const unshown = shownPurposes(read.notices).filter((n) => !n.noticeFromUtc).map((n) => n.code);
  return {
    lines,
    markShown: async () => {
      const signal = AbortSignal.timeout(ctx.fetchTimeoutMs ?? READ_TIMEOUT_MS);
      await Promise.all(unshown.map((code) => markStudyNoticeShown(ctx.apiBaseUrl, token, code, signal)));
    }
  };
}

/** The entries `renderStudyNotices` prints a notice for, and only those. */
function shownPurposes(entries: readonly unknown[]): StudyNotice[] {
  return entries
    .map(asNotice)
    .filter((n): n is StudyNotice => n !== undefined && NOTICED_PURPOSES.some((p) => p.code === n.code));
}

/** The section for a list the server returned. Empty when nothing in it can be shown. */
export function renderStudyNotices(entries: readonly unknown[], commandPrefix: string, now: Date = new Date()): string[] {
  const body: string[] = [];
  let unreadable = 0;
  for (const entry of entries) {
    const notice = asNotice(entry);
    const purpose = notice && NOTICED_PURPOSES.find((p) => p.code === notice.code);
    if (!notice || !purpose) {
      unreadable += 1;
      continue;
    }
    body.push(...renderOne(notice, purpose, commandPrefix, now));
  }
  if (body.length === 0) return [];
  if (unreadable > 0) {
    body.push(`  ${unreadable === 1 ? "1 entry" : `${unreadable} entries`} in the list couldn't be read by this version of the tool.`);
  }
  return ["", "Your organisation's study", ...body];
}

function renderOne(notice: StudyNotice, purpose: NoticedPurpose, commandPrefix: string, now: Date): string[] {
  const org = notice.organisationName;
  const command = `${commandPrefix} object ${purpose.slug}`;
  const lines = [`  ${org}: ${purpose.title}`];
  lines.push(`    ${notice.label || NOTICE_LABEL}`);
  lines.push(`    ${basisLine(notice)}`);
  if (notice.signatoryName) lines.push(`    Recorded by ${notice.signatoryName}.`);
  lines.push(`    ${notice.processor || PROCESSOR} processes this for ${org}.`);

  if (notice.objected === true) {
    lines.push(notice.objectedAtUtc && isDate(notice.objectedAtUtc)
      ? `    You objected on ${formatDay(notice.objectedAtUtc)}. You're left out from the next report.`
      : "    You objected. You're left out from the next report.");
    lines.push(`    To undo: ${command} --undo`);
  } else if (notice.objected === false) {
    lines.push("    You haven't objected.");
    if (notice.countingFromUtc && isDate(notice.countingFromUtc) && Date.parse(notice.countingFromUtc) > now.getTime()) {
      lines.push(`    You're not counted before ${formatDay(notice.countingFromUtc)}.`);
    }
    lines.push(`    To object: ${command}`);
  } else {
    // Never guessed: either answer printed here could be the wrong one.
    lines.push("    This version of the tool couldn't read whether you've objected. Run status again.");
    lines.push(`    To object: ${command}`);
    lines.push(`    To undo: ${command} --undo`);
  }
  lines.push("");
  return lines;
}

/** `Acme's basis: Legitimate interests. Works agreement, ref WA-12, 1 Sep 2026.` */
function basisLine(notice: StudyNotice): string {
  const words = BASIS_WORDS[notice.basis] ?? notice.basisLabel;
  const head = words
    ? `${notice.organisationName}'s basis: ${words}.`
    : `${notice.organisationName}'s basis is one this version of the tool can't name.`;
  const document = [
    notice.documentTitle,
    notice.documentReference ? `ref ${notice.documentReference}` : null,
    notice.documentDate && isDate(notice.documentDate) ? formatDay(notice.documentDate) : null
  ].filter((part): part is string => Boolean(part));
  return document.length ? `${head} ${document.join(", ")}.` : head;
}

function asNotice(value: unknown): StudyNotice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.code !== "number") return undefined;
  // The list holds only noticed purposes. A server that also names the mode
  // and names a different one is not describing a notice, whatever else it says.
  if (typeof o.mode === "string" && o.mode.trim().toLowerCase() !== "notice") return undefined;
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : null);
  return {
    organisationName: str(o.organisationName) ?? "Your organisation",
    code: o.code,
    name: str(o.name),
    label: str(o.label),
    processor: str(o.processor),
    basis: typeof o.basis === "string" ? o.basis : "",
    basisLabel: str(o.basisLabel),
    documentTitle: str(o.documentTitle),
    documentDate: str(o.documentDate),
    documentReference: str(o.documentReference),
    signatoryName: str(o.signatoryName),
    objected: typeof o.objected === "boolean" ? o.objected : null,
    objectedAtUtc: str(o.objectedAtUtc),
    noticeFromUtc: str(o.noticeFromUtc),
    countingFromUtc: str(o.countingFromUtc)
  };
}

export type StudyObjectionContext = {
  apiBaseUrl: string;
  /** `undefined` when this install holds no token. */
  eventWriteToken: string | undefined;
  /** How a person runs this tool's commands, e.g. `npx @ascenda-one/claude-code-hooks`. */
  commandPrefix: string;
  /** What to run to pair again. */
  pairCommand: string;
  /** Everything after `object`. */
  argv: string[];
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
};

/**
 * `object <purpose>` objects; `object <purpose> --undo` withdraws it. One
 * request, no question and no reason. Both directions need a real terminal,
 * like `join`: whether you're counted is yours to change, and an agent
 * running a command for you has no terminal.
 */
export async function runStudyObjection(ctx: StudyObjectionContext): Promise<number> {
  const stdin = ctx.stdin ?? process.stdin;
  const stdout = ctx.stdout ?? process.stdout;
  const stderr = ctx.stderr ?? process.stderr;
  const print = (line: string) => stdout.write(`${line}\n`);

  if (!stdin.isTTY || !stdout.isTTY) {
    stderr.write("object needs an interactive terminal (stdin and stdout). Run it directly, not from a script or a pipe.\n");
    return 1;
  }

  const undo = ctx.argv.includes("--undo");
  const rest = ctx.argv.filter((a) => a !== "--undo");
  const purpose = rest.length === 1 ? NOTICED_PURPOSES.find((p) => p.slug === rest[0]) : undefined;
  if (!purpose) {
    stderr.write(objectionUsage(ctx.commandPrefix));
    return 1;
  }
  if (!ctx.eventWriteToken) {
    stderr.write(`This install isn't paired, so there's nothing to object to. Pair with \`${ctx.pairCommand}\`.\n`);
    return 1;
  }

  const command = `${ctx.commandPrefix} object ${purpose.slug}`;
  try {
    await setStudyObjection(ctx.apiBaseUrl, ctx.eventWriteToken, purpose.code, !undo);
  } catch (error) {
    stderr.write(`${describeObjectionError(error, purpose, undo, ctx.pairCommand)}\n`);
    return 1;
  }

  if (undo) {
    print(`Objection withdrawn: ${purpose.title}.`);
    print("You're counted again from the next report.");
    print(`To object again: ${command}`);
  } else {
    print(`Objected: ${purpose.title}.`);
    print("You're left out from the next report. Reports already issued stay as they are.");
    print(`To undo: ${command} --undo`);
  }
  return 0;
}

function objectionUsage(commandPrefix: string): string {
  const lines = [`Usage: ${commandPrefix} object <purpose> [--undo]`, "", "Purposes:"];
  for (const p of NOTICED_PURPOSES) lines.push(`  ${p.slug.padEnd(14)}${p.title}`);
  lines.push("", "status shows which of these your organisation counts unless you object.");
  return `${lines.join("\n")}\n`;
}

function describeObjectionError(error: unknown, purpose: NoticedPurpose, undo: boolean, pairCommand: string): string {
  if (error instanceof AscendaApiError) {
    if (error.status === 404 && error.errorCode === "not_noticed") {
      return undo
        ? `Your organisation doesn't count you for ${purpose.title} unless you object, so there's no objection to undo.`
        : `Your organisation doesn't count you for ${purpose.title} unless you object, so there's nothing to object to.`;
    }
    if (error.status === 401) return `The server turned this install's request down. If that keeps happening, pair again with \`${pairCommand}\`.`;
    if (error.status === 404) return "This server doesn't take objections yet. Nothing changed.";
    return `Couldn't record that (HTTP ${error.status}). Nothing changed. Run it again to retry.`;
  }
  return "Couldn't reach the server. Nothing changed. Run it again to retry.";
}

function isDate(iso: string): boolean {
  return !Number.isNaN(Date.parse(iso));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `1 Sep 2026`, as the app prints a date. Not `Intl`: its en-GB September is `Sept`. */
function formatDay(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
