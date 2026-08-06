import { AscendaTelemetryEventType } from "@ascenda-one/tool-contract";
import { LiveBusEvent } from "@ascenda-one/tool-kit";

/**
 * Maps this extension's catalog events onto the desktop waterline's much
 * smaller vocabulary (docs/MACOS_LIVE_DEMAND_WATERLINE.md in the app repo).
 *
 * Deliberately partial. The waterline reads **AI work in progress**, so
 * only events that evidence an agent doing something map to a signal;
 * ordinary editor activity — saves, edits, a file being opened — does not,
 * even though the backend catalog records it. Typing in Cursor with no
 * agent running is not load, and a gauge that rose for it would be
 * measuring the wrong thing.
 *
 * `undefined` means silence, which is the correct answer for most events.
 */
export function liveEventFor(eventType: AscendaTelemetryEventType): LiveBusEvent | undefined {
  switch (eventType) {
    case "ai_prompt_submitted":
      return "prompt_submitted";

    // The leading edge only. `ai_tool_call_completed` would double-count
    // the same call, and the gauge should rise as work starts.
    case "ai_tool_call_started":
      return "tool_call";

    case "ai_tool_call_failed":
    case "compile_error":
      return "tool_failure";

    // Both compression flavours and the pressure signal are the same thing
    // to the gauge: the context budget is hurting. That's the ripple.
    case "context_compression_manual":
    case "context_compression_auto":
    case "context_pressure_high":
      return "compaction";

    default:
      return undefined;
  }
}
