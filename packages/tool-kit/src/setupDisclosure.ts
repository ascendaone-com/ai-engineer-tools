/**
 * What `setup` tells a person before it pairs their machine.
 *
 * Until now it told them nothing. `setup` printed a pairing id, a binary path,
 * a credentials path and a count of registered hooks, and then the collector
 * began sending. The only statements anywhere about what leaves a machine were
 * a package README and a section of the desktop app's consent hub — neither of
 * which is in front of the person at the one moment they are deciding. Pairing
 * is where the consent is actually given, so it is where the sentence belongs.
 *
 * ## Why families rather than one paragraph
 *
 * The adapters do not send the same things. Claude Code reports the model, the
 * permission posture, git actions and whether a file was edited after the agent
 * wrote it; Gemini reports none of those. A single paragraph covering the union
 * would over-state for four adapters out of five, which is the same defect as
 * under-stating — a claim that does not match the set.
 *
 * So each family is one sentence with one spelling, and an adapter declares the
 * families it actually sends. The sentence a person reads is composed from that
 * declaration and nothing else.
 *
 * ## What binds a declaration to the wire
 *
 * An adapter's `sends` is still hand-written, but it is no longer unchecked.
 * Every metadata field and every metric key now carries a family on the
 * contract itself (`EVENT_METADATA_DISCLOSURE` and `METRIC_KEYS[k].family`),
 * so the compiler refuses an unclassified key at the same declaration site
 * where it already refuses an unregistered one. `setupDisclosure.test.mjs`
 * then runs each mapper and resolves every key it emits to a family, and
 * fails when that family is not one the adapter declares — or when the
 * adapter declares a family nothing it emits belongs to.
 *
 * Read {@link FAMILY_SENTENCES} as product copy: it is the wording a person
 * sees, and changing it changes what they were told. The families themselves
 * live in `@ascenda-one/tool-contract`, beside the keys they classify — the
 * taxonomy is a property of the wire, the wording is a property of the
 * surface that prints it.
 */

import type { DisclosureFamily } from "@ascenda-one/tool-contract";

export type { DisclosureFamily };

/**
 * One spelling per family, in the second person, stated as fact.
 *
 * These are bullets under "What this sends", so each reads as a continuation
 * of that heading rather than as a sentence of its own.
 */
export const FAMILY_SENTENCES: Readonly<Record<DisclosureFamily, string>> = {
  session: "when a session starts and ends, the one-word reason for the end if your agent gives one, how long each turn took, and whether it ran on this machine or in a hosted cloud session",
  counts: "how many prompts you sent, how many replies came back, and what class of command ran in a terminal — test, lint, build, git and so on",
  tools: "the name of each tool your agent calls",
  outcome: "whether a call succeeded, failed, or was interrupted",
  clock: "your machine's offset from UTC, so an evening is read as an evening",
  repo: "your project and branch as digests computed on this machine — never the names themselves",
  model: "which model served the session, by name and by tier",
  posture: "the permission posture your agent was working under — asking each time, accepting edits, and so on",
  git: "that a commit, push or revert happened, and when a pull request opened or merged",
  edits: "roughly how much a file changed, as a bucket, and whether you edited it after the agent wrote it",
  context: "how full the context window got",
  waiting: "that your agent stopped and waited for you, as one word: permission_request, idle_prompt, or other",
  reading: "what the reader could not make sense of — lines it failed to parse, files it could not open, and prompts it judged machine-written rather than typed"
};

/**
 * Families every collector in this repo sends, because the shared sender or the
 * shared mapper produces them regardless of host.
 *
 * `repo` and `clock` are here rather than per-adapter because
 * `buildEventPayload` and `resolveContextHashes` put them on every payload; an
 * adapter cannot opt out of either without changing the sender.
 */
export const ALWAYS_SENT: readonly DisclosureFamily[] = ["session", "counts", "tools", "outcome", "repo", "clock"];

/**
 * The refusal half, and the load-bearing half.
 *
 * A list of what is sent, read alone, invites the reader to assume the worst
 * about everything not on it. These lines are constant across every adapter
 * because they are properties of the mappers, not of a host.
 *
 * **Checkable, deliberately.** The shared metadata type does carry a free-text
 * `message` field — the IDE extension uses it for its test signal — so the
 * third line cannot say "there is no field it could travel in" and stay true.
 * What is true, and what `setupDisclosure.test.mjs` pins, is narrower and
 * stronger: no hook mapper in this repo writes content into an event. A
 * refusal is only worth printing when something fails if it stops being so.
 */
export const REFUSALS: readonly string[] = [
  "Never your prompts, your agent's replies, or anything inside a file.",
  "Never a file path, a command line, or a repository or branch name.",
  "Content is read here only to choose one of a fixed set of labels, then discarded. No mapper writes it to an event, and a test fails the build if one starts."
];

/**
 * Metadata keys that can carry free text, and which no hook mapper may write.
 *
 * `message` and `activity` are the two the type allows a string of any shape
 * in. `activity` is written by every mapper, but only ever as one of a small
 * set of constant labels, so it is checked by value rather than by presence —
 * see the guard test.
 */
export const FREE_TEXT_KEYS: readonly string[] = ["message"];

export type SetupDisclosureOptions = {
  /** Families this adapter sends beyond {@link ALWAYS_SENT}. */
  sends: readonly DisclosureFamily[];
  /** How the agent is named to a person, e.g. `Claude Code`. */
  displayName: string;
};

/**
 * The block `setup` prints before it pairs.
 *
 * Ordered by {@link FAMILY_SENTENCES}'s own key order rather than by the order
 * an adapter happens to declare, so two adapters sharing a family print it in
 * the same place and a reader comparing them is comparing like with like.
 */
export function renderSetupDisclosure({ sends, displayName }: SetupDisclosureOptions): string {
  const declared = new Set<DisclosureFamily>([...ALWAYS_SENT, ...sends]);
  const ordered = (Object.keys(FAMILY_SENTENCES) as DisclosureFamily[]).filter((family) => declared.has(family));

  const lines = [
    `What this sends from ${displayName}, once paired:`,
    ...ordered.map((family) => `  · ${FAMILY_SENTENCES[family]}`),
    "",
    ...REFUSALS.map((line) => `  ${line}`),
    "",
    "  Turn it off by revoking this tool in the Ascenda app."
  ];
  return lines.join("\n");
}
