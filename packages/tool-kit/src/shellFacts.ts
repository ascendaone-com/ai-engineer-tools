import type { GitAction, WorkMilestoneKind } from "@ascenda-one/tool-contract";
import { classifyGitAction, isReworkGitAction } from "./gitActionClassifier";
import { classifyWorkMilestone } from "./workMilestoneClassifier";

/**
 * The metadata a shell command contributes beyond its command class: what git
 * did (and whether that was rework) and which work milestone it reached.
 *
 * One function so every adapter that reads a shell command attaches the same
 * keys under the same rules, and none can drift from the others. Keys are
 * absent, not undefined, when there is nothing to say. The caller decides
 * whether the call succeeded and only asks for these once it has.
 */
export function shellCommandFacts(command: string | undefined | null): {
  gitAction?: GitAction;
  activity?: string;
  milestoneKind?: WorkMilestoneKind;
} {
  const gitAction = classifyGitAction(command);
  const milestoneKind = classifyWorkMilestone(command);
  return {
    ...(gitAction !== undefined ? { gitAction } : {}),
    ...(isReworkGitAction(gitAction) ? { activity: "rework_reversion" } : {}),
    ...(milestoneKind !== undefined ? { milestoneKind } : {})
  };
}
