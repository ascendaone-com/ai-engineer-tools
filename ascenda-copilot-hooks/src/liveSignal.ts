import { bucketPromptSize, getString } from "@ascenda-one/tool-kit";
import type { LiveBusSignal } from "@ascenda-one/tool-kit";
import { CopilotHookEventName, CopilotHookInput } from "./types.js";

/** A live signal minus the two fields only the CLI can supply. */
export type LiveSignalBody = Omit<LiveBusSignal, "tool" | "session">;

/**
 * Maps Copilot CLI hooks onto the desktop waterline's much smaller vocabulary
 * (`LiveBusEvent` in `@ascenda-one/tool-kit`). Not the telemetry mapping, and
 * shares nothing with `mapCopilotEvent`: this one only says that agent work
 * is happening right now.
 *
 *  - `userPromptSubmitted` opens a turn and `agentStop` closes it.
 *    `sessionEnd` is `halted`: quitting mid-turn sends no `agentStop`.
 *  - `preToolUse` carries the cadence heartbeat, so the gauge rises as the
 *    agent starts. It is batched, and one beat per batch is enough for a
 *    gauge.
 *  - `postToolUseFailure` is `tool_failure`, and so is a `postToolUse`
 *    whose `resultType` says it failed. Otherwise `postToolUse` stays
 *    silent: `preToolUse` already counted the call.
 *  - `preCompact` is compaction.
 *  - `sessionStart` and the subagent hooks say nothing; the turn is the beat.
 *
 * Copilot has no hook that says it is waiting on a permission prompt, so no
 * Copilot signal is ever `awaiting`.
 *
 * `undefined` means silence. An event the app cannot parse is worse than
 * none, because it looks like it works.
 */
export function liveSignalFor(hookName: CopilotHookEventName, input: CopilotHookInput): LiveSignalBody | undefined {
  switch (hookName) {
    case "userPromptSubmitted": {
      const prompt = getString(input, ["prompt"]);
      // Only the bucket crosses the socket. Omitted when there was no prompt,
      // so the app falls back to its own middle height.
      return prompt === undefined ? { event: "prompt_submitted" } : { event: "prompt_submitted", sizeBucket: bucketPromptSize(prompt) };
    }
    case "preToolUse": return { event: "tool_call" };
    case "postToolUseFailure": return { event: "tool_failure" };
    case "postToolUse": return failed(input) ? { event: "tool_failure" } : undefined;
    case "preCompact": return { event: "compaction" };
    case "agentStop": return { event: "stop" };
    case "sessionEnd": return { event: "halted" };
    default: return undefined;
  }
}

function failed(input: CopilotHookInput): boolean {
  const result = input.toolResult;
  const resultType = result && typeof result === "object" ? getString(result as Record<string, unknown>, ["resultType"])?.toLowerCase() : undefined;
  return resultType === "failure" || resultType === "error";
}
