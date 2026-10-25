import {
  bucketDurationMs,
  classifyCommand,
  shellCommandFacts,
  getString,
  isVerificationCommand,
  looksLikeCorrection
} from "@ascenda-one/tool-kit";
import type { AscendaEventMetadata } from "@ascenda-one/tool-contract";
import { COPILOT_HOST, CommandOutcome, CopilotHookEventName, CopilotHookInput, MappedCopilotEvent } from "./types.js";

/**
 * Maps GitHub Copilot CLI hooks to the canonical Ascenda event catalog.
 * Catalog values only; hooks without a catalog counterpart map to nothing.
 * See docs/COPILOT_MAPPING.md.
 *
 * Written against the payloads the CLI was seen to send, which differ from
 * its reference: `preToolUse` is batched, `postToolUse` has no call id, and
 * `timestamp` is epoch milliseconds. No mapping reads `timestamp`, since a
 * hook runs at the moment it describes.
 */
export function mapCopilotEvent(hookName: CopilotHookEventName, input: CopilotHookInput, turnDurationMs?: number): MappedCopilotEvent[] {
  switch (hookName) {
    case "sessionStart": return [{ eventType: "create_focus_session", severity: "low", metadata: withHost({ activity: "session_started" }) }];
    case "sessionEnd": return [{ eventType: "recovery_offline_period", severity: "low", metadata: withHost({ activity: "session_ended" }) }];
    case "userPromptSubmitted": return mapPrompt(input);
    case "agentStop": return mapAgentStop(turnDurationMs);
    case "preToolUse": return mapPreToolUse(input);
    case "postToolUse": return mapAfterTool(input, outcomeOf(input));
    case "postToolUseFailure": return mapAfterTool(input, "failure");
    case "preCompact": return mapPreCompact(input);
    case "subagentStart": return [{ eventType: "subagent_started", severity: "low", metadata: withHost({}) }];
    case "subagentStop": return [{ eventType: "subagent_stopped", severity: "low", metadata: withHost({}) }];

    // userPromptTransformed repeats the prompt hook, and permissionRequest,
    // notification and errorOccurred have no catalog counterpart. None of
    // them is registered.
    default: return [];
  }
}

function mapPrompt(input: CopilotHookInput): MappedCopilotEvent[] {
  const prompt = getString(input, ["prompt"]);
  const events: MappedCopilotEvent[] = [{ eventType: "ai_prompt_submitted", severity: "low", metadata: withHost({ promptClass: "unknown" }) }];
  if (looksLikeCorrection(prompt)) {
    events.push({ eventType: "ai_correction_prompt", severity: "medium", metadata: withHost({ reason: "repeated_reprompting", trigger: "inferred" }) });
  }
  return events;
}

function mapAgentStop(turnDurationMs: number | undefined): MappedCopilotEvent[] {
  const durationBucket = bucketDurationMs(turnDurationMs);
  const events: MappedCopilotEvent[] = [];
  if (durationBucket === "30-60m" || durationBucket === "60m+") {
    events.push({ eventType: "agent_loop_long", severity: durationBucket === "60m+" ? "high" : "medium", metadata: withHost({ durationBucket, reason: "long_session", trigger: "inferred" }) });
  }
  // Every turn ends here, long or short. Pushed last so a send that isn't
  // accepted can't cost the long-loop signal ahead of it.
  events.push({ eventType: "ai_turn_completed", severity: "low", metadata: withHost(durationBucket ? { durationBucket } : {}) });
  return events;
}

/**
 * One hook call per batch of tool requests, `toolCalls: [{ id, name, args }]`,
 * so one event per element. The reference's single `toolName` shape is read
 * too, in case a later CLI sends it.
 */
function mapPreToolUse(input: CopilotHookInput): MappedCopilotEvent[] {
  const calls = Array.isArray(input.toolCalls) ? input.toolCalls : undefined;
  const names = calls
    ? calls.map((call) => (call && typeof call === "object" ? getString(call as Record<string, unknown>, ["name", "toolName"]) : undefined))
    : [getString(input, ["toolName"])];
  return names.map((name) => ({ eventType: "ai_tool_call_started", severity: "low", metadata: withHost({ toolName: sanitiseToolName(name) }) }));
}

function mapAfterTool(input: CopilotHookInput, outcome: CommandOutcome): MappedCopilotEvent[] {
  const toolName = getString(input, ["toolName"]);
  const safeToolName = sanitiseToolName(toolName);
  const command = isShell(toolName) ? getCommand(input) : undefined;
  const commandClass = classifyCommand(command);

  if (outcome === "failure") {
    if (isShell(toolName) && isVerificationCommand(commandClass)) {
      return [{ eventType: "compile_error", severity: "medium", metadata: withHost({ toolName: safeToolName, commandClass, outcome, reason: "test_failure" }) }];
    }
    return [{ eventType: "ai_tool_call_failed", severity: "medium", metadata: withHost({ toolName: safeToolName, commandClass, outcome, reason: "tool_failure" }) }];
  }

  if (isWriteTool(toolName) && outcome !== "cancelled") {
    return [{ eventType: toolName === "create" ? "ai_file_write" : "ai_file_edit", severity: "low", metadata: withHost({ toolName: safeToolName, outcome }) }];
  }

  if (isShell(toolName) && isVerificationCommand(commandClass) && outcome !== "cancelled") {
    return [{ eventType: "editor_verification_activity", severity: "low", metadata: withHost({ toolName: safeToolName, commandClass, outcome, activity: "ai_test_or_build_run" }) }];
  }

  // Only a call that reported success is a delivery or a reversion: a failed
  // commit moved nothing, and an unknown outcome proves nothing either way.
  const facts = isShell(toolName) && outcome === "success" ? shellCommandFacts(command) : {};
  return [{ eventType: "ai_tool_call_completed", severity: "low", metadata: withHost({ toolName: safeToolName, commandClass, outcome, ...facts }) }];
}

function mapPreCompact(input: CopilotHookInput): MappedCopilotEvent[] {
  const isManual = getString(input, ["trigger"])?.toLowerCase().includes("manual") ?? false;
  return [{
    eventType: isManual ? "context_compression_manual" : "context_compression_auto",
    severity: isManual ? "medium" : "high",
    metadata: withHost({ trigger: isManual ? "manual" : "auto", reason: "context_limit" })
  }];
}

/**
 * `toolResult.resultType`. `success` is the only value seen so far; the
 * others are the reference's. A refusal is the person saying no, which is
 * stopped work, not wrong work.
 */
function outcomeOf(input: CopilotHookInput): CommandOutcome {
  const result = input.toolResult;
  const resultType = result && typeof result === "object" ? getString(result as Record<string, unknown>, ["resultType"])?.toLowerCase() : undefined;
  switch (resultType) {
    case "success": return "success";
    case "failure":
    case "error": return "failure";
    case "rejected":
    case "denied": return "cancelled";
    default: return "unknown";
  }
}

/** `toolArgs.command`. Seen as an object; a JSON string is read too. */
function getCommand(input: CopilotHookInput): string | undefined {
  let args = input.toolArgs;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  return args && typeof args === "object" ? getString(args as Record<string, unknown>, ["command"]) : undefined;
}

/**
 * Copilot CLI's shell tool is `bash` (`read_bash`, `write_bash` and
 * `stop_bash` drive a shell already running and carry no command). The
 * Windows shell tool hasn't been seen, so it isn't guessed at here.
 */
function isShell(toolName: string | undefined): boolean {
  return toolName === "bash";
}

/** `create` writes a new file; `edit` replaces a string in one. */
function isWriteTool(toolName: string | undefined): boolean {
  return toolName === "create" || toolName === "edit";
}

function sanitiseToolName(toolName: string | undefined): string {
  if (!toolName) return "unknown";
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
}

/**
 * Typed against the wire's metadata shape rather than cast to it, so a value
 * outside the contract's vocabulary is a compile error here, not an
 * unclassified row later.
 */
function withHost(metadata: AscendaEventMetadata): AscendaEventMetadata {
  return { host: COPILOT_HOST, ...metadata };
}
