import { bucketPromptSize, getString, inferOutcome } from "@ascenda-one/tool-kit";
import type { LiveBusSignal } from "@ascenda-one/tool-kit";
import { GeminiHookEventName, GeminiHookInput } from "./types.js";

/** A live signal minus the two fields only the CLI can supply. */
export type LiveSignalBody = Omit<LiveBusSignal, "tool" | "session">;

/**
 * Maps Gemini CLI hooks onto the desktop waterline's much smaller vocabulary
 * (`LiveBusEvent` in `@ascenda-one/tool-kit`).
 *
 * This is **not** the telemetry mapping and shares nothing with
 * `mapGeminiEvent`. That one feeds daily buckets read hours later; this one
 * drives gauges, the Away Mode keep-awake assertion and the settle bell, all
 * of which need to know only that agent work is happening right now.
 *
 * Deliberately partial, and deliberately leading-edge:
 *
 *  - `BeforeAgent` is the turn's opening beat and `AfterAgent` its close, so
 *    they carry `prompt_submitted` and `stop`. `SessionStart` brackets a
 *    whole CLI run and says nothing. `SessionEnd` is `halted`, not a second
 *    `stop`: quitting mid-turn sends no `AfterAgent`, and without it the
 *    session held its level until it went stale. After a turn that did stop
 *    the app ignores a `halted` for a session it no longer holds, so it
 *    never draws two session ends.
 *  - `BeforeTool`, not `AfterTool`, carries the cadence heartbeat, so the
 *    gauge rises as the agent starts rather than after it finishes.
 *  - `AfterTool` therefore speaks only when the call **failed**. Gemini has
 *    no separate failure hook, so the outcome is read off the payload the
 *    same way the telemetry mapper reads it.
 *  - `PreCompress` is Gemini's compaction.
 *  - `Notification` is `awaiting`, and only for `ToolPermission` — Gemini's
 *    confirmation dialog, where the agent has stopped and cannot go on
 *    without the person. It is the only notification type Gemini documents;
 *    an unknown one stays silent rather than being guessed into a wait,
 *    because a false `awaiting` tells Away Mode the work is parked.
 *  - `BeforeModel`/`AfterModel`/`BeforeToolSelection` fire per LLM round trip
 *    and are silent here for the same reason they are silent in the
 *    telemetry mapper: the tool hooks already carry that cadence, and these
 *    would multiply it several-fold.
 *
 * `undefined` means silence, which is the right answer for most hooks. An
 * event the app cannot parse is worse than none, because it looks like it
 * works.
 */
export function liveSignalFor(hookName: GeminiHookEventName, input: GeminiHookInput): LiveSignalBody | undefined {
  switch (hookName) {
    case "BeforeAgent": {
      const prompt = getString(input, ["prompt"]);
      // The bucket is computed here so only the bucket crosses the socket.
      // Omitted when the payload carried no prompt: the aggregator falls
      // back to its own middle attack height, which is a better reading than
      // asserting a size we did not observe.
      return prompt === undefined ? { event: "prompt_submitted" } : { event: "prompt_submitted", sizeBucket: bucketPromptSize(prompt) };
    }
    case "BeforeTool": return { event: "tool_call" };
    case "AfterTool": return inferOutcome(input) === "failure" ? { event: "tool_failure" } : undefined;
    case "PreCompress": return { event: "compaction" };
    case "AfterAgent": return { event: "stop" };
    case "SessionEnd": return { event: "halted" };
    case "Notification": return getString(input, ["notification_type"]) === "ToolPermission" ? { event: "awaiting" } : undefined;
    default: return undefined;
  }
}

/**
 * `queued` is absent from every Gemini signal, and that is a measurement, not
 * an omission. Gemini's hook payloads carry nothing that says a turn came out
 * of the user's queue, and the field is tri-state precisely so a tool that
 * cannot know says nothing rather than saying "no" (see `LiveBusSignal` and
 * `LiveSignal.queued` in the app). Only the Claude Code adapter can answer.
 */
