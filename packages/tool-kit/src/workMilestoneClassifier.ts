import { WorkMilestoneKind } from "@ascenda-one/tool-contract";
import { commandHeads } from "./commandHeads";

/**
 * Whether a command marked a piece of work reaching its own end.
 *
 * The sibling of `classifyGitAction`, at a different grain. That one records
 * keystroke-scale boundaries — commits, pushes — which happen many times
 * inside one piece of work. This one records the work *finishing*, which is
 * the rhythm a review should follow rather than a calendar's.
 *
 * Deliberately syntactic and deliberately narrow, for the same reasons as its
 * sibling: it reads the command string only, never shelling out, and it
 * classifies nothing it cannot classify confidently. `git merge` is absent on
 * purpose — `git merge origin/main` is a sync and `git merge feature-x` is an
 * integration, and guessing between them would fire a debrief invitation every
 * time somebody pulled upstream.
 */
export function classifyWorkMilestone(command: string | undefined | null): WorkMilestoneKind | undefined {
  if (!command) return undefined;
  const value = command.toLowerCase().trim();
  if (!/\bgh\b/.test(value)) return undefined;

  // Only text in command position counts. Matching anywhere in the string
  // fired a debrief invitation for a heredoc whose *content* mentioned
  // "gh pr merge 412" — a milestone that never happened. Heredoc bodies and
  // quoted strings are data, not commands, so they are stripped before the
  // string is split into the positions where a command can actually start.
  const heads = commandHeads(value);

  // `gh pr merge` completes the work. Tested before `gh pr create` because a
  // command doing both (`gh pr create ... && gh pr merge ...`) has ended at the
  // merge, and reporting it as an opening would understate what happened.
  if (heads.some((head) => /^gh\s+pr\s+merge\b/.test(head))) return "pr_merged";

  // `gh issue close` ends a ticket without any PR being involved — the case
  // Hamada's "end of a ticket" names most directly.
  if (heads.some((head) => /^gh\s+issue\s+close\b/.test(head))) return "issue_closed";

  // Opening a PR is a handoff, not a completion: the work leaves the person's
  // hands but is not finished. Recorded because it is a real boundary the
  // record should carry; it does not invite a debrief (see `invitesDebrief`).
  if (heads.some((head) => /^gh\s+pr\s+create\b/.test(head))) return "pr_opened";

  return undefined;
}

/**
 * Whether this milestone is one where asking for a debrief is appropriate.
 *
 * Only completions qualify. Opening a PR hands work over — the person is
 * usually moving straight to the next thing and a review question there
 * interrupts rather than closes. The narrower set is what keeps this a
 * moment rather than a nag.
 */
export function invitesDebrief(kind: WorkMilestoneKind | undefined): boolean {
  return kind === "pr_merged" || kind === "issue_closed";
}
