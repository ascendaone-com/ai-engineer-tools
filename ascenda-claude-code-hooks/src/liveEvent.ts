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
 *  - **`Notification`**, when Claude Code says it is waiting on the person —
 *    a permission dialog, the idle "waiting for your input", or an MCP
 *    server's elicitation form. Not every notification is a wait
 *    (`auth_success` is not), so the kind is read, never assumed.
 *  - **`PreToolUse` for `AskUserQuestion`.** That tool fires no Notification:
 *    it *is* the question, and the dialog opens the moment it runs. It is
 *    answered here, inline, rather than by a second matcher-scoped hook,
 *    because two processes for one PreToolUse race each other onto the
 *    socket and the app keeps whichever lands last. One process, one beat.
 *    It replaces `tool_call` rather than following it: the agent's next move
 *    is the person's, so this call is not cadence.
 */
export function liveEventFor(hookName: ClaudeHookEventName, input: ClaudeHookInput): LiveBusEvent | undefined {
  switch (hookName) {
    case "UserPromptSubmit": return "prompt_submitted";
    case "PreToolUse": return getToolName(input) === ASK_USER_QUESTION ? "awaiting" : "tool_call";
    case "PreCompact": return "compaction";
    case "PostToolUseFailure": return "tool_failure";
    case "Stop": return "stop";
    case "Notification": return notificationAwaitsPerson(input) ? "awaiting" : undefined;
    default: return undefined;
  }
}

const ASK_USER_QUESTION = "AskUserQuestion";

/**
 * `notification_type` values that mean the agent cannot go on without the
 * person. Anything else Claude Code sends — `auth_success` today, whatever it
 * adds tomorrow — is not a wait, and an unknown kind stays silent rather than
 * being guessed into one: a false `awaiting` tells Away Mode the work is
 * parked and lets the Mac sleep under it.
 */
const AWAITING_KINDS = new Set(["permission_prompt", "idle_prompt", "elicitation_dialog"]);

/**
 * Whether this notification says the agent is waiting on the person.
 *
 * The typed field leads. Older Claude Code builds send no
 * `notification_type`, and for those the wording is the only evidence — the
 * same three-label classifier the cloud `supervision_interruption` uses, so
 * the two channels cannot disagree about which notifications are waits.
 * `other` stays silent here for the same reason it is counted separately
 * there: it is not known to be a wait. The message picks a label and is
 * discarded; none of it reaches the socket.
 */
export function notificationAwaitsPerson(input: ClaudeHookInput): boolean {
  const kind = getString(input, ["notification_type", "notificationType"]);
  if (kind !== undefined) return AWAITING_KINDS.has(kind);
  return notificationKind(getString(input, ["message"])) !== "other";
}
