import { bucketPromptSize, getString } from "@ascenda-one/tool-kit";
import type { LiveBusSignal } from "@ascenda-one/tool-kit";
import { CursorHookEventName, CursorHookInput } from "./types.js";

/** A live signal minus the two fields only the CLI can supply. */
export type LiveSignalBody = Omit<LiveBusSignal, "tool" | "session">;

/**
 * Maps Cursor agent hooks onto the desktop waterline's much smaller
 * vocabulary (`LiveBusEvent` in `@ascenda-one/tool-kit`;
 * `docs/MACOS_LIVE_DEMAND_WATERLINE.md` in the app repo).
 *
 * This is **not** the telemetry mapping and shares nothing with
 * `mapCursorEvent`. That one feeds daily buckets read hours later; this one
 * drives gauges, the Away Mode keep-awake assertion and the settle bell, all
 * of which need to know only that agent work is happening right now.
 *
 * **Why this adapter emits at all, when the Cursor extension already does.**
 * The extension covers Cursor users who install it; the hooks are a separate
 * route, and someone who takes only that route had all four local features
 * silently dead. The cost is real and worth naming: run both and the same
 * work arrives twice, once as `cursor_mcp` from the extension and once as
 * `cursor` from here, under session ids with nothing in common — so the
 * concurrency gauge reads two streams where a person would count one. A
 * gauge that over-counts for the doubly-installed was judged the smaller
 * defect than Away Mode letting the Mac sleep mid-run for everyone else.
 * There is no shared session id to dedupe on today.
 *
 * Deliberately partial, and deliberately leading-edge:
 *
 *  - `preToolUse`, not `postToolUse`, carries the cadence heartbeat, so the
 *    gauge rises as the agent starts rather than after it finishes.
 *  - `postToolUse` is silent. Cursor reports failure on its own hook rather
 *    than through an exit code, so the failure beat has an unambiguous home
 *    and `postToolUse` would only double-count the call.
 *  - `postToolUseFailure` rings the failure impulse **unless the user
 *    interrupted**. `is_interrupt` separates a person pressing stop from a
 *    tool breaking, and only the second is a failure. The impulse means
 *    "something broke"; flashing it because someone cancelled their own
 *    agent would be a lie the gauge cannot walk back.
 *  - `sessionStart`/`sessionEnd` bracket the app's session rather than a
 *    turn, and `stop` already carries the turn's close.
 *  - The shell, MCP and file hooks are specialised views of calls
 *    `preToolUse` already reported — the same double-count the telemetry
 *    mapper avoids by leaving them unregistered.
 *
 * `undefined` means silence, which is the right answer for most hooks. An
 * event the app cannot parse is worse than none, because it looks like it
 * works.
 */
export function liveSignalFor(hookName: CursorHookEventName, input: CursorHookInput): LiveSignalBody | undefined {
  switch (hookName) {
    case "beforeSubmitPrompt": {
      const prompt = getString(input, ["prompt"]);
      // The bucket is computed here so only the bucket crosses the socket.
      // Omitted when the payload carried no prompt: the aggregator falls
      // back to its own middle attack height, which is a better reading than
      // asserting a size we did not observe.
      return prompt === undefined ? { event: "prompt_submitted" } : { event: "prompt_submitted", sizeBucket: bucketPromptSize(prompt) };
    }
    case "preToolUse": return { event: "tool_call" };
    case "postToolUseFailure": return input.is_interrupt === true ? undefined : { event: "tool_failure" };
    case "preCompact": return { event: "compaction" };
    case "stop": return { event: "stop" };
    default: return undefined;
  }
}

/**
 * `queued` is absent from every Cursor signal, and that is a measurement, not
 * an omission. Cursor's hook payloads carry nothing that says a turn came out
 * of the user's queue, and the field is tri-state precisely so a tool that
 * cannot know says nothing rather than saying "no" (see `LiveBusSignal` and
 * `LiveSignal.queued` in the app). Only the Claude Code adapter can answer.
 */
