/**
 * Runs the person cut short.
 *
 * **The definition.** A run is cut short when a human interrupt marker ends an
 * agent turn that was still going. One per marker, per session, placed on the
 * local day of the marker's own timestamp, the way prompts are placed. It is a
 * count, not a rate, and it is never placed in time more finely than a day.
 *
 * **The marker.** Pressing Escape while Claude Code is working writes a `user`
 * line whose whole text is `[Request interrupted by user]`, or the
 * `for tool use` variant when the turn was waiting on a tool. The desktop app's
 * importer already recognises exactly this text so it can leave the line out
 * of its prompt count; {@link isInterruptionMarkerLine} is the same test,
 * wrapper stripping included, so both writers of the handoff agree on which
 * lines are markers.
 *
 * **When a turn is still going.** The transcript says so without inference:
 *
 *  - a person's prompt, a tool result, or a notification that wakes the
 *    session starts or continues a turn;
 *  - an `assistant` line whose `stop_reason` is `tool_use` (it has asked for a
 *    tool) or absent (it was still streaming) keeps it going;
 *  - an `assistant` line with any other `stop_reason` (`end_turn`, the
 *    runtime's own `stop_sequence` notice) ends it, and so does the
 *    `stop_hook_summary` or `turn_duration` system line that closes a turn.
 *
 * Two markers are not counted. One that lands after the turn already ended is a
 * stray keypress with nothing to cut. One carrying `interruptedByShutdown: true`
 * was written by the app closing, not by the person. The runtime's own
 * bookkeeping (`isMeta`, a compaction summary, a line that is nothing but a
 * slash command's wrapper) neither starts a turn nor ends one.
 */

/**
 * Elements the runtime wraps around, or instead of, what a person typed. A
 * line whose text is nothing else once these are removed was not typed.
 */
const RUNTIME_WRAPPER_ELEMENTS = [
  "system-reminder",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat"
] as const;

const INTERRUPTION_MARKER = /^\[Request interrupted by[^\]]*\]$/;

/**
 * A `user` line's text with the runtime's wrapper elements removed and trimmed.
 * Read to classify the line and never kept. Null where the line carries a
 * non-text block, such as an attached image: nothing can be said about it.
 */
export function typedRemainderOf(record: Record<string, unknown>): string | null {
  const message = record.message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item !== "object" || item === null) return null;
      const block = item as Record<string, unknown>;
      if (block.type !== "text") return null;
      if (typeof block.text === "string") text = text === "" ? block.text : `${text}\n${block.text}`;
    }
  } else {
    return null;
  }
  for (const element of RUNTIME_WRAPPER_ELEMENTS) {
    text = text.replace(new RegExp(`<${element}>[\\s\\S]*?</${element}>`, "g"), "");
  }
  return text.trim();
}

/** `[Request interrupted by user]`, or its `for tool use` variant. */
export function isInterruptionMarkerLine(record: Record<string, unknown>): boolean {
  const remainder = typedRemainderOf(record);
  return remainder !== null && INTERRUPTION_MARKER.test(remainder);
}

/** Whether a main-thread `user` line that isn't a tool result or a marker starts a turn. */
function userLineStartsTurn(record: Record<string, unknown>): boolean {
  const origin = record.origin;
  if (typeof origin === "object" && origin !== null) {
    const kind = (origin as Record<string, unknown>).kind;
    // The harness woke the session, or another session spoke: the agent runs.
    if (kind === "task-notification" || kind === "peer") return true;
  }
  if (record.isMeta === true || record.isCompactSummary === true) return false;
  // Nothing but a wrapper: a local slash command and its output.
  return typedRemainderOf(record) !== "";
}

/** A step of the turn state, one main-thread line at a time. */
export interface RunStep {
  /** Whether an agent turn is still going after this line. */
  running: boolean;
  /** Whether this line cut a running turn short. */
  cut: boolean;
}

/**
 * Advances the turn state by one main-thread transcript line. Subagent
 * transcripts must not be passed: their turns are the orchestrator's, and a
 * person cannot interrupt them on their own.
 *
 * `isToolResult` is the extractor's own tool-result test, passed in so there is
 * one definition of that too.
 */
export function stepRun(
  running: boolean,
  record: Record<string, unknown>,
  isToolResult: (record: Record<string, unknown>) => boolean
): RunStep {
  switch (record.type) {
    case "assistant": {
      const message = record.message as Record<string, unknown> | undefined;
      const stop = message?.stop_reason;
      return { running: stop === "tool_use" || stop === null || stop === undefined, cut: false };
    }
    case "system":
      if (record.subtype === "stop_hook_summary" || record.subtype === "turn_duration") {
        return { running: false, cut: false };
      }
      return { running, cut: false };
    case "user":
      if (isToolResult(record)) return { running: true, cut: false };
      if (isInterruptionMarkerLine(record)) {
        return { running: false, cut: running && record.interruptedByShutdown !== true };
      }
      return { running: running || userLineStartsTurn(record), cut: false };
    default:
      return { running, cut: false };
  }
}
