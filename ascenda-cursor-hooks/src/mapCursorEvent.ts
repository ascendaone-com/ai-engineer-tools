import {
  bucketDurationMs,
  classifyCommand,
  getNestedString,
  getNumber,
  getString,
  inferOutcome,
  isVerificationCommand,
  looksLikeCorrection
} from "@ascenda-one/tool-kit";
import { CURSOR_HOST, CursorHookEventName, CursorHookInput, MappedCursorEvent } from "./types.js";

/**
 * Maps Cursor agent hooks to the canonical Ascenda event catalog.
 * Catalog values only; hooks without a catalog counterpart map to nothing.
 * See docs/CURSOR_MAPPING.md.
 */
export function mapCursorEvent(hookName: CursorHookEventName, input: CursorHookInput, turnDurationMs?: number): MappedCursorEvent[] {
  switch (hookName) {
    case "sessionStart": return [{ eventType: "create_focus_session", severity: "low", metadata: withHost({ activity: "session_started" }) }];
    case "sessionEnd": return [{ eventType: "recovery_offline_period", severity: "low", metadata: withHost({ activity: "session_ended" }) }];
    case "beforeSubmitPrompt": return mapPrompt(input);
    case "preToolUse": return [{ eventType: "ai_tool_call_started", severity: "low", metadata: withHost({ toolName: sanitiseToolName(getToolName(input)) }) }];
    case "postToolUse": return mapPostToolUse(input);
    case "postToolUseFailure": return mapPostToolUseFailure(input);
    case "preCompact": return mapPreCompact(input);
    case "stop": return mapStop(turnDurationMs);

    // Deliberately unmapped. The shell / MCP / file-edit hooks are specialised
    // views of tool calls that preToolUse and postToolUse already report, so
    // registering them would double-count every command and edit. The rest
    // (subagent lifecycle, agent thoughts, Tab completions, workspaceOpen)
    // have no catalog counterpart.
    default: return [];
  }
}

function mapPrompt(input: CursorHookInput): MappedCursorEvent[] {
  const prompt = getString(input, ["prompt"]);
  const events: MappedCursorEvent[] = [{ eventType: "ai_prompt_submitted", severity: "low", metadata: withHost({ promptClass: "unknown" }) }];
  if (looksLikeCorrection(prompt)) {
    events.push({ eventType: "ai_correction_prompt", severity: "medium", metadata: withHost({ reason: "repeated_reprompting", trigger: "inferred" }) });
  }
  return events;
}

function mapPostToolUse(input: CursorHookInput): MappedCursorEvent[] {
  const toolName = getToolName(input);
  const safeToolName = sanitiseToolName(toolName);
  const commandClass = classifyCommand(getCommand(input));
  const durationBucket = bucketDurationMs(getNumber(input, ["duration"]));
  const outcome = inferOutcome(withParsedToolOutput(input));

  if (outcome === "failure") {
    if (isShell(toolName) && isVerificationCommand(commandClass)) {
      return [{ eventType: "compile_error", severity: "medium", metadata: withHost({ toolName: safeToolName, commandClass, outcome, durationBucket, reason: "test_failure" }) }];
    }
    return [{ eventType: "ai_tool_call_failed", severity: "medium", metadata: withHost({ toolName: safeToolName, commandClass, outcome, durationBucket, reason: "tool_failure" }) }];
  }

  if (isWriteTool(toolName)) {
    return [{ eventType: toolName?.toLowerCase() === "write" ? "ai_file_write" : "ai_file_edit", severity: "low", metadata: withHost({ toolName: safeToolName, outcome, durationBucket }) }];
  }

  if (isShell(toolName) && isVerificationCommand(commandClass)) {
    return [{ eventType: "editor_verification_activity", severity: "low", metadata: withHost({ toolName: safeToolName, commandClass, outcome, durationBucket, activity: "ai_test_or_build_run" }) }];
  }

  return [{ eventType: "ai_tool_call_completed", severity: "low", metadata: withHost({ toolName: safeToolName, commandClass, outcome, durationBucket }) }];
}

/**
 * Cursor reports failures on their own hook rather than through an exit code,
 * so outcome is known without inspecting output. `is_interrupt` separates a
 * user cancelling the agent from the tool genuinely failing.
 */
function mapPostToolUseFailure(input: CursorHookInput): MappedCursorEvent[] {
  const toolName = getToolName(input);
  const safeToolName = sanitiseToolName(toolName);
  const commandClass = classifyCommand(getCommand(input));
  const durationBucket = bucketDurationMs(getNumber(input, ["duration"]));
  const interrupted = input.is_interrupt === true;
  const outcome = interrupted ? "cancelled" : "failure";

  if (!interrupted && isShell(toolName) && isVerificationCommand(commandClass)) {
    return [{ eventType: "compile_error", severity: "medium", metadata: withHost({ toolName: safeToolName, commandClass, outcome, durationBucket, reason: "test_failure" }) }];
  }
  return [{
    eventType: "ai_tool_call_failed",
    severity: interrupted ? "low" : "medium",
    metadata: withHost({ toolName: safeToolName, commandClass, outcome, durationBucket, reason: interrupted ? "manual_interrupt" : "tool_failure" })
  }];
}

function mapPreCompact(input: CursorHookInput): MappedCursorEvent[] {
  const isManual = getString(input, ["trigger"])?.toLowerCase().includes("manual") ?? false;
  return [{
    eventType: isManual ? "context_compression_manual" : "context_compression_auto",
    severity: isManual ? "medium" : "high",
    metadata: withHost({ trigger: isManual ? "manual" : "auto", reason: "context_limit" })
  }];
}

function mapStop(turnDurationMs: number | undefined): MappedCursorEvent[] {
  const durationBucket = bucketDurationMs(turnDurationMs);
  if (durationBucket === "30-60m" || durationBucket === "60m+") {
    return [{ eventType: "agent_loop_long", severity: durationBucket === "60m+" ? "high" : "medium", metadata: withHost({ durationBucket, reason: "long_session", trigger: "inferred" }) }];
  }
  return [];
}

/**
 * `tool_output` is a JSON *string*, not an object, so the shared outcome
 * inference cannot see the exit code inside it. Parse it into the `result`
 * shape the helper already probes.
 */
function withParsedToolOutput(input: CursorHookInput): CursorHookInput {
  const raw = input.tool_output;
  if (typeof raw !== "string") return input;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return input;
    return { ...input, result: parsed };
  } catch {
    return input;
  }
}

function getCommand(input: CursorHookInput): string | undefined {
  return getString(input, ["command"]) ?? getNestedString(input, [["tool_input", "command"]]);
}

function getToolName(input: CursorHookInput): string | undefined {
  return getString(input, ["tool_name", "toolName"]);
}

function isShell(toolName: string | undefined): boolean {
  const value = toolName?.toLowerCase();
  return value === "shell" || value === "bash" || value === "terminal";
}

function isWriteTool(toolName: string | undefined): boolean {
  const value = toolName?.toLowerCase();
  return value === "write" || value === "edit" || value === "multiedit" || value === "search_replace" || value === "apply_patch";
}

function sanitiseToolName(toolName: string | undefined): string {
  if (!toolName) return "unknown";
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
}

function withHost(metadata: Record<string, unknown>): MappedCursorEvent["metadata"] {
  return { host: CURSOR_HOST, ...metadata } as MappedCursorEvent["metadata"];
}
