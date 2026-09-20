// The figures `fixtures/claude-store-lineage.cli.json` pins, shared by the
// test that checks them and the script that writes them.
//
//   node tests/lineageFigures.mjs > tests/fixtures/claude-store-lineage.cli.json
//
// Run from this package after `npm run build`.
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fixture's figures that don't depend on the local timezone: per-session
 * counts, minutes and start instants, the day slices' prompt total and whether
 * there were any, the prompt instants, and the transcripts that held nothing
 * of their own.
 */
export function lineageFigures(events) {
  const sessions = events
    .filter((e) => e.eventKind === "create_focus_session")
    .map((e) => ({
      sessionRef: e.sessionRef,
      startedAt: e.metrics.sessionStartedAt,
      promptCount: e.metrics.promptCount,
      dispatchedPromptLines: e.metrics.dispatchedPromptLines,
      syntheticPromptLines: e.metrics.syntheticPromptLines,
      interruptedRuns: e.metrics.interruptedRuns,
      activeMinutes: e.metrics.activeMinutes,
      handsOnMinutes: e.metrics.handsOnMinutes,
      agentSupervisingMinutes: e.metrics.agentSupervisingMinutes,
      dayPrompts: (e.dayBreakdown ?? []).reduce((sum, d) => sum + d.prompts, 0),
      // Whether the session was placed on any day at all. A boolean, not a
      // count: how many local days a session falls across depends on the
      // extracting machine's timezone, and whether it falls on one at all
      // does not. It is here because the prompt sum above cannot see this —
      // a session nobody typed in sums to 0 whether it was placed on its days
      // or dropped entirely, which is how both writers could disagree about
      // 103 sessions while this file reported them identical.
      hasDays: (e.dayBreakdown ?? []).length > 0
    }))
    .sort((a, b) => a.sessionRef.localeCompare(b.sessionRef));
  const promptInstants = events
    .filter((e) => e.eventKind === "ai_prompt_submitted")
    .map((e) => `${e.sessionRef} ${new Date(e.occurredAt).toISOString()}`)
    .sort();
  const epoch = events.find((e) => e.eventKind === "extraction_epoch");
  return {
    sessions,
    promptInstants,
    sessionsWithOnlyInheritedLines: epoch?.metrics.sessionsWithOnlyInheritedLines ?? 0
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { extractClaudeCode } = await import("../dist/extractors/claudeCode.js");
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-store-lineage");
  const events = [];
  for await (const event of extractClaudeCode(root, "extraction-lineage")) events.push(event);
  const out = {
    writtenBy: "ai-engineer-tools ascenda-history-import tests/lineageFigures.mjs, from fixtures/claude-store-lineage",
    figures: lineageFigures(events)
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}
