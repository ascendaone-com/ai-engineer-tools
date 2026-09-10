import { bucketPromptSize, getNestedString } from "@ascenda-one/tool-kit";
import type { LiveBusSignal } from "@ascenda-one/tool-kit";
import { mcpResultFailed } from "./mapWindsurfEvent.js";
import { WindsurfHookEventName, WindsurfHookInput } from "./types.js";

/** A live signal minus the two fields only the CLI can supply. */
export type LiveSignalBody = Omit<LiveBusSignal, "tool" | "session">;

/**
 * Maps Cascade hooks onto the desktop waterline's much smaller vocabulary
 * (`LiveBusEvent` in `@ascenda-one/tool-kit`;
 * `docs/MACOS_LIVE_DEMAND_WATERLINE.md` in the app repo).
 *
 * This is **not** the telemetry mapping and shares nothing with
 * `mapWindsurfEvent`. That one feeds daily buckets read hours later; this
 * one drives gauges, the Away Mode keep-awake assertion and the settle bell,
 * all of which need to know only that agent work is happening right now.
 *
 * Deliberately partial, and deliberately leading-edge:
 *
 *  - Every `pre_*` action hook is one beat of agent cadence, so all four
 *    carry `tool_call`. Their `post_*` partners are silent, because emitting
 *    on both would double-count a single call.
 *  - `post_mcp_tool_use` is the one exception, and only when the result
 *    carries an explicit error marker: it is the only Cascade hook that
 *    reports an outcome at all. Every other `post_*` hook's outcome is
 *    `unknown` by Cascade's design, and a guessed failure would ring the
 *    gauge's failure impulse for work that succeeded.
 *  - `post_cascade_response` is the turn's close.
 *    `post_cascade_response_with_transcript` repeats the same moment and is
 *    silent, or the saver would draw two session ends for one turn.
 *  - **`compaction` is unreachable from Cascade.** Windsurf ships no
 *    compaction hook, so that ripple simply never fires for these users.
 *    That is a gap in the host's hook set, not in this mapping, and it is
 *    the same gap `mapWindsurfEvent` records for `context_compression_*`.
 *
 * `undefined` means silence, which is the right answer for most hooks. An
 * event the app cannot parse is worse than none, because it looks like it
 * works.
 */
export function liveSignalFor(hookName: WindsurfHookEventName, input: WindsurfHookInput): LiveSignalBody | undefined {
  switch (hookName) {
    case "pre_user_prompt": {
      const prompt = getNestedString(input, [["tool_info", "user_prompt"]]);
      // The bucket is computed here so only the bucket crosses the socket.
      // Omitted when the payload carried no prompt: the aggregator falls
      // back to its own middle attack height, which is a better reading than
      // asserting a size we did not observe.
      return prompt === undefined ? { event: "prompt_submitted" } : { event: "prompt_submitted", sizeBucket: bucketPromptSize(prompt) };
    }
    case "pre_read_code":
    case "pre_write_code":
    case "pre_run_command":
    case "pre_mcp_tool_use":
      return { event: "tool_call" };
    case "post_mcp_tool_use": return mcpResultFailed(input) ? { event: "tool_failure" } : undefined;
    case "post_cascade_response": return { event: "stop" };
    default: return undefined;
  }
}

/**
 * `queued` is absent from every Cascade signal, and that is a measurement,
 * not an omission. Cascade's hook payloads carry nothing that says a turn
 * came out of the user's queue, and the field is tri-state precisely so a
 * tool that cannot know says nothing rather than saying "no" (see
 * `LiveBusSignal` and `LiveSignal.queued` in the app). Only the Claude Code
 * adapter can answer.
 */
