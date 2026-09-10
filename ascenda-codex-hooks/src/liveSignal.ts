import { bucketPromptSize, getNestedString, getString, inferOutcome } from "@ascenda-one/tool-kit";
import type { LiveBusSignal } from "@ascenda-one/tool-kit";
import { CodexHookEventName, CodexHookInput } from "./types.js";

/** A live signal minus the two fields only the CLI can supply. */
export type LiveSignalBody = Omit<LiveBusSignal, "tool" | "session">;

/**
 * Maps Codex lifecycle hooks onto the desktop waterline's much smaller
 * vocabulary (`LiveBusEvent` in `@ascenda-one/tool-kit`;
 * `docs/MACOS_LIVE_DEMAND_WATERLINE.md` in the app repo).
 *
 * This is **not** the telemetry mapping and shares nothing with
 * `mapCodexEvent`. That one feeds daily buckets read hours later; this one
 * drives gauges, the Away Mode keep-awake assertion and the settle bell, all
 * of which need to know only that agent work is happening right now.
 *
 * Deliberately partial, and deliberately leading-edge:
 *
 *  - `PreToolUse`, not `PostToolUse`, carries the cadence heartbeat, so the
 *    gauge rises as the agent starts rather than after it finishes. Emitting
 *    on both would double-count one call.
 *  - `PostToolUse` speaks only when the call **failed**. Codex has no
 *    separate failure hook the way Claude Code does, so the outcome has to
 *    be read off the payload; a successful `PostToolUse` is silence, because
 *    `PreToolUse` already reported the call.
 *  - `PreCompact` is the compaction ripple. `PostCompact` is the same
 *    compaction seen from the other side and would ring the gauge twice.
 *  - Approvals and subagent lifecycle map to nothing, exactly as in the
 *    telemetry mapper.
 *
 * `undefined` means silence, which is the right answer for most hooks. An
 * event the app cannot parse is worse than none, because it looks like it
 * works.
 */
export function liveSignalFor(hookName: CodexHookEventName, input: CodexHookInput): LiveSignalBody | undefined {
  switch (hookName) {
    case "UserPromptSubmit": {
      const prompt = getString(input, ["prompt", "userPrompt", "message"])
        ?? getNestedString(input, [["payload", "prompt"], ["payload", "message"]]);
      // The bucket is computed here so only the bucket crosses the socket.
      // Omitted when the payload carried no prompt at all: the aggregator
      // falls back to its own middle attack height, which is a better
      // reading than asserting a size we did not observe.
      return prompt === undefined ? { event: "prompt_submitted" } : { event: "prompt_submitted", sizeBucket: bucketPromptSize(prompt) };
    }
    case "PreToolUse": return { event: "tool_call" };
    case "PostToolUse": return inferOutcome(input) === "failure" ? { event: "tool_failure" } : undefined;
    case "PreCompact": return { event: "compaction" };
    case "Stop": return { event: "stop" };
    default: return undefined;
  }
}

/**
 * `queued` is absent from every Codex signal, and that is a measurement, not
 * an omission. Codex's hook payloads carry nothing that says a turn came out
 * of the user's queue, and the field is tri-state precisely so a tool that
 * cannot know says nothing rather than saying "no" (see `LiveBusSignal` and
 * `LiveSignal.queued` in the app). Only the Claude Code adapter can answer.
 */
