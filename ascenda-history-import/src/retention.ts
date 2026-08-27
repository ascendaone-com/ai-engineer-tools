/**
 * "Stop the bleeding at install."
 *
 * Two settings on the user's machine decide whether the historical window
 * keeps shrinking after Flow arrives. Both changes are proposed as data
 * first (so the consent surface can show exactly what would change) and
 * applied only by an explicit second call — the importer never modifies a
 * user's config as a side effect of scanning or extracting.
 */
import * as fs from "node:fs/promises";
import { StorePaths } from "./stores.js";

/** High enough to stop the purge mattering, finite so we are not writing
 * "never delete" into someone's config unasked. */
export const PROPOSED_CLEANUP_PERIOD_DAYS = 3650;

export interface ClaudeRetentionPlan {
  settingsPath: string;
  currentCleanupPeriodDays: number | null;
  proposedCleanupPeriodDays: number;
  /** False when the user already keeps more history than we would propose. */
  changeNeeded: boolean;
}

export async function planClaudeRetentionFix(paths: StorePaths): Promise<ClaudeRetentionPlan> {
  let current: number | null = null;
  try {
    const settings = JSON.parse(await fs.readFile(paths.claudeSettings, "utf8"));
    if (typeof settings.cleanupPeriodDays === "number") current = settings.cleanupPeriodDays;
  } catch {
    // Missing or unreadable settings file — the 30-day default is live.
  }
  return {
    settingsPath: paths.claudeSettings,
    currentCleanupPeriodDays: current,
    proposedCleanupPeriodDays: PROPOSED_CLEANUP_PERIOD_DAYS,
    changeNeeded: current === null || current < PROPOSED_CLEANUP_PERIOD_DAYS
  };
}

/**
 * Apply the plan by MERGING into the existing settings — `settings.json`
 * holds the user's whole Claude Code configuration, and clobbering it to set
 * one key would be a far worse outcome than the purge we are preventing. If
 * the file exists but does not parse, refuse: overwriting something we could
 * not read is exactly the mistake the merge rule exists to prevent.
 */
export async function applyClaudeRetentionFix(plan: ClaudeRetentionPlan): Promise<void> {
  if (!plan.changeNeeded) return;
  let settings: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = await fs.readFile(plan.settingsPath, "utf8");
  } catch {
    // No file yet — we create one holding only our key.
  }
  if (raw !== null) {
    try {
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(
        `${plan.settingsPath} exists but is not valid JSON — refusing to overwrite it`
      );
    }
  }
  settings.cleanupPeriodDays = plan.proposedCleanupPeriodDays;
  await fs.writeFile(plan.settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/** The zsh side: `EXTENDED_HISTORY` makes shell history timestamped from now
 * on — purely prospective, but the scan's "no timestamps" note is the reason
 * to offer it. Left as a plan-only stub: appending to a user's .zshrc has
 * enough sharp edges (which rc file, oh-my-zsh, symlinks) that it warrants
 * its own careful implementation, not a scaffold one. */
export function zshExtendedHistorySnippet(): string {
  return "setopt EXTENDED_HISTORY  # Ascenda: timestamp shell history";
}
