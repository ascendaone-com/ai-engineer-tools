import type { LiveBusEvent } from "@ascenda-one/tool-kit";
import { getToolName, notificationKind } from "./mapClaudeEvent.js";
import { getString } from "./safeExtract.js";
import type { ClaudeHookEventName, ClaudeHookInput } from "./types.js";

/**
 * Which live-bus beat a Claude Code hook carries, or `undefined` for none.
 *
 * Only the lifecycle beats the gauges actually render are mapped; anything
 * else is silence rather than a signal nothing consumes. `PreToolUse` — not
 * `PostToolUse` — carries the cadence heartbeat, because it fires at the
 * *leading* edge of the work and the gauge should rise as the agent starts,
 * not after it finishes.
 *
 * `awaiting` has two sources, and the second is why this is not a lookup
 * table:
 *
 *  - **`Notification`**, when Claude Code says it is waiting on the person
 *    mid-turn: a permission dialog, or an MCP server's elicitation form. Not
 *    every notification is a wait (`auth_success` is not), so the kind is
 *    read, never assumed.
 *  - **`PreToolUse` for `AskUserQuestion`.** That tool fires no Notification:
 *    it *is* the question, and the dialog opens the moment it runs. It is
 *    answered here, inline, rather than by a second matcher-scoped hook,
 *    because two processes for one PreToolUse race each other onto the
 *    socket and the app keeps whichever lands last. One process, one beat.
 *    It replaces `tool_call` rather than following it: the agent's next move
 *    is the person's, so this call is not cadence.
 *
 * `halted` also has two sources: `StopFailure`, which fires in place of
 * `Stop` when an API error ends the turn, and the idle-prompt Notification
 * ("waiting for your input"). Pressing Esc runs no hook at all, so an
 * interrupted turn never sends `stop`, and the idle prompt is the first
 * thing that fires afterwards. It is not `awaiting`: the turn is over, and
 * nothing is parked on the person. After a turn that did stop it's
 * redundant, and the app ignores a `halted` for a session it no longer holds.
 *
 * `SessionEnd` is a third. Closing Claude Code mid-turn (Ctrl-C twice,
 * `/exit` while a tool runs, a closed terminal) sends no `stop`, and without
 * this the session held its level until it went stale, three minutes later.
 * A `halted` never creates a session, and is ignored by a listener whose
 * session already stopped, so the ordinary case (a stop, then the end)
 * draws nothing twice.
 */
export function liveEventFor(hookName: ClaudeHookEventName, input: ClaudeHookInput): LiveBusEvent | undefined {
  switch (hookName) {
    case "UserPromptSubmit": return "prompt_submitted";
    case "PreToolUse": return getToolName(input) === ASK_USER_QUESTION ? "awaiting" : "tool_call";
    case "PreCompact": return "compaction";
    case "PostToolUseFailure": return "tool_failure";
    case "Stop": return "stop";
    case "StopFailure": return "halted";
    case "SessionEnd": return "halted";
    case "Notification": return notificationLiveEvent(input);
    default: return undefined;
  }
}

const ASK_USER_QUESTION = "AskUserQuestion";

/**
 * `notification_type` values and the live beat each one is. Anything else
 * Claude Code sends (`auth_success` today, whatever it adds tomorrow) stays
 * silent rather than being guessed into one: a false `awaiting` tells Away
 * Mode the work is parked and lets the Mac sleep under it, and a false
 * `halted` drains a gauge that is still working.
 */
const NOTIFICATION_EVENTS: Readonly<Record<string, LiveBusEvent>> = {
  permission_prompt: "awaiting",
  elicitation_dialog: "awaiting",
  idle_prompt: "halted"
};

/** The same, keyed by the wording classifier's labels, for older builds. */
const NOTIFICATION_KIND_EVENTS: Readonly<Record<string, LiveBusEvent>> = {
  permission_request: "awaiting",
  idle_prompt: "halted"
};

/**
 * The live beat a Notification carries, if any.
 *
 * The typed field leads. Older Claude Code builds send no
 * `notification_type`, and for those the wording is the only evidence — the
 * same three-label classifier the cloud `supervision_interruption` uses, so
 * the two channels cannot disagree about which notifications are which.
 * `other` stays silent here for the same reason it is counted separately
 * there: it is not known to be either. The message picks a label and is
 * discarded; none of it reaches the socket.
 */
export function notificationLiveEvent(input: ClaudeHookInput): LiveBusEvent | undefined {
  const kind = getString(input, ["notification_type", "notificationType"]);
  if (kind !== undefined) return Object.hasOwn(NOTIFICATION_EVENTS, kind) ? NOTIFICATION_EVENTS[kind] : undefined;
  const label = notificationKind(getString(input, ["message"]));
  return Object.hasOwn(NOTIFICATION_KIND_EVENTS, label) ? NOTIFICATION_KIND_EVENTS[label] : undefined;
}

/** Whether this notification says the agent is waiting on the person, mid-turn. */
export function notificationAwaitsPerson(input: ClaudeHookInput): boolean {
  return notificationLiveEvent(input) === "awaiting";
}
