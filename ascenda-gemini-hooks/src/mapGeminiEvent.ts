import {
  bucketDurationMs,
  classifyCommand,
  getNestedString,
  getString,
  inferOutcome,
  isVerificationCommand,
  looksLikeCorrection
} from "@ascenda-one/tool-kit";
import { GEMINI_HOST, GeminiHookEventName, GeminiHookInput, MappedGeminiEvent } from "./types.js";

/**
 * Maps Gemini CLI hooks to the canonical Ascenda event catalog.
 * Catalog values only; hooks without a catalog counterpart map to nothing.
 * See docs/GEMINI_MAPPING.md.
 */
export function mapGeminiEvent(hookName: GeminiHookEventName, input: GeminiHookInput, turnDurationMs?: number): MappedGeminiEvent[] {
  switch (hookName) {
    case "SessionStart": return [{ eventType: "create_focus_session", severity: "low", metadata: withHost({ activity: "session_started" }) }];
    case "SessionEnd": return [{ eventType: "recovery_offline_period", severity: "low", metadata: withHost({ activity: "session_ended" }) }];
    case "BeforeAgent": return mapBeforeAgent(input);
    case "AfterAgent": return mapAfterAgent(turnDurationMs);
    case "BeforeTool": return [{ eventType: "ai_tool_call_started", severity: "low", metadata: withHost({ toolName: sanitiseToolName(getToolName(input)) }) }];
    case "AfterTool": return mapAfterTool(input);
    case "PreCompress": return [{ eventType: "context_compression_auto", severity: "high", metadata: withHost({ trigger: "auto", reason: "context_limit" }) }];

    // BeforeModel / AfterModel / BeforeToolSelection fire per LLM round trip —
    // no catalog counterpart, and registering them would multiply event volume
    // several-fold for signal the tool hooks already carry. Notification has
    // no counterpart either.
    default: return [];
  }
}

function mapBeforeAgent(input: GeminiHookInput): MappedGeminiEvent[] {
  const prompt = getString(input, ["prompt"]);
  const events: MappedGeminiEvent[] = [{ eventType: "ai_prompt_submitted", severity: "low", metadata: withHost({ promptClass: "unknown" }) }];
  if (looksLikeCorrection(prompt)) {
    events.push({ eventType: "ai_correction_prompt", severity: "medium", metadata: withHost({ reason: "repeated_reprompting", trigger: "inferred" }) });
  }
  return events;
}

function mapAfterAgent(turnDurationMs: number | undefined): MappedGeminiEvent[] {
  const durationBucket = bucketDurationMs(turnDurationMs);
  if (durationBucket === "30-60m" || durationBucket === "60m+") {
    return [{ eventType: "agent_loop_long", severity: durationBucket === "60m+" ? "high" : "medium", metadata: withHost({ durationBucket, reason: "long_session", trigger: "inferred" }) }];
  }
  return [];
}

function mapAfterTool(input: GeminiHookInput): MappedGeminiEvent[] {
  const toolName = getToolName(input);
  const safeToolName = sanitiseToolName(toolName);
  const commandClass = classifyCommand(getCommand(input));
  const outcome = inferOutcome(input);

  if (outcome === "failure") {
    if (isShell(toolName) && isVerificationCommand(commandClass)) {
      return [{ eventType: "compile_error", severity: "medium", metadata: withHost({ toolName: safeToolName, commandClass, outcome, reason: "test_failure" }) }];
    }
    return [{ eventType: "ai_tool_call_failed", severity: "medium", metadata: withHost({ toolName: safeToolName, commandClass, outcome, reason: "tool_failure" }) }];
  }

  if (isWriteTool(toolName)) {
    return [{ eventType: toolName?.toLowerCase() === "write_file" ? "ai_file_write" : "ai_file_edit", severity: "low", metadata: withHost({ toolName: safeToolName, outcome }) }];
  }

  if (isShell(toolName) && isVerificationCommand(commandClass)) {
    return [{ eventType: "editor_verification_activity", severity: "low", metadata: withHost({ toolName: safeToolName, commandClass, outcome, activity: "ai_test_or_build_run" }) }];
  }

  return [{ eventType: "ai_tool_call_completed", severity: "low", metadata: withHost({ toolName: safeToolName, commandClass, outcome }) }];
}

function getToolName(input: GeminiHookInput): string | undefined {
  return getString(input, ["tool_name", "original_request_name"]);
}

function getCommand(input: GeminiHookInput): string | undefined {
  return getNestedString(input, [["tool_input", "command"]]);
}

/** Gemini's built-in shell tool is `run_shell_command`. */
function isShell(toolName: string | undefined): boolean {
  const value = toolName?.toLowerCase();
  return value === "run_shell_command" || value === "shell" || value === "bash";
}

/** `replace` is Gemini's in-place edit tool; `write_file` creates or overwrites. */
function isWriteTool(toolName: string | undefined): boolean {
  const value = toolName?.toLowerCase();
  return value === "write_file" || value === "replace" || value === "edit";
}

function sanitiseToolName(toolName: string | undefined): string {
  if (!toolName) return "unknown";
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
}

function withHost(metadata: Record<string, unknown>): MappedGeminiEvent["metadata"] {
  return { host: GEMINI_HOST, ...metadata } as MappedGeminiEvent["metadata"];
}
