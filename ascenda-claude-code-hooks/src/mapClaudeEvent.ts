import { classifyCommand, isVerificationCommand } from "./commandClassifier.js";
import { ClaudeHookEventName, ClaudeHookInput, MappedAscendaEvent } from "./types.js";
import { bucketDurationMs, getNestedNumber, getNestedString, getNumber, getString, inferOutcome, looksLikeCorrection } from "./safeExtract.js";

export function mapClaudeEvent(hookName: ClaudeHookEventName, input: ClaudeHookInput): MappedAscendaEvent[] {
  switch (hookName) {
    case "UserPromptSubmit": return mapUserPromptSubmit(input);
    case "PreToolUse": return mapPreToolUse(input);
    case "PostToolUse": return mapPostToolUse(input);
    case "PreCompact": return mapPreCompact(input);
    case "PostCompact": return [{ eventType: "context_pressure_high", severity: "medium", metadata: { trigger: "inferred", reason: "context_limit" } }];
    case "Stop": return mapStop(input);
    // No catalog event for notifications; skip to avoid unclassified noise.
    case "Notification": return [];
    default: return [];
  }
}

function mapUserPromptSubmit(input: ClaudeHookInput): MappedAscendaEvent[] {
  const prompt = getString(input, ["prompt", "userPrompt", "message"]) ?? getNestedString(input, [["payload", "prompt"], ["payload", "message"]]);
  const events: MappedAscendaEvent[] = [{ eventType: "ai_prompt_submitted", severity: "low", metadata: { promptClass: "unknown" } }];
  if (looksLikeCorrection(prompt)) {
    events.push({ eventType: "ai_correction_prompt", severity: "medium", metadata: { reason: "repeated_reprompting", trigger: "inferred" } });
  }
  return events;
}

function mapPreToolUse(input: ClaudeHookInput): MappedAscendaEvent[] {
  return [{ eventType: "ai_tool_call_started", severity: "low", metadata: { toolName: sanitiseToolName(getToolName(input)) } }];
}

function mapPostToolUse(input: ClaudeHookInput): MappedAscendaEvent[] {
  const toolName = getToolName(input);
  const safeToolName = sanitiseToolName(toolName);
  const outcome = inferOutcome(input);
  const durationMs = getNumber(input, ["durationMs", "duration_ms", "elapsedMs"]) ?? getNestedNumber(input, [["tool_response", "durationMs"], ["result", "durationMs"]]);
  const command = getString(input, ["command"]) ?? getNestedString(input, [["tool_input", "command"], ["input", "command"], ["parameters", "command"]]);
  const commandClass = classifyCommand(command);

  if (outcome === "failure") {
    if (toolName?.toLowerCase() === "bash" && isVerificationCommand(commandClass)) {
      return [{ eventType: "compile_error", severity: "medium", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs), reason: "test_failure" } }];
    }
    return [{ eventType: "ai_tool_call_failed", severity: "medium", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs), reason: "tool_failure" } }];
  }

  if (isWriteTool(toolName)) {
    return [{ eventType: toolName?.toLowerCase() === "write" ? "ai_file_write" : "ai_file_edit", severity: "low", metadata: { toolName: safeToolName, outcome, durationBucket: bucketDurationMs(durationMs) } }];
  }

  if (toolName?.toLowerCase() === "bash" && isVerificationCommand(commandClass)) {
    return [{ eventType: "editor_verification_activity", severity: "low", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs), activity: "ai_test_or_build_run" } }];
  }

  return [{ eventType: "ai_tool_call_completed", severity: "low", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs) } }];
}

function mapPreCompact(input: ClaudeHookInput): MappedAscendaEvent[] {
  const trigger = getString(input, ["trigger", "reason", "compactType", "type"]) ?? getNestedString(input, [["payload", "trigger"], ["payload", "reason"]]);
  const isManual = trigger?.toLowerCase().includes("manual") ?? false;
  return [{ eventType: isManual ? "context_compression_manual" : "context_compression_auto", severity: isManual ? "medium" : "high", metadata: { trigger: isManual ? "manual" : "auto", reason: "context_limit" } }];
}

function mapStop(input: ClaudeHookInput): MappedAscendaEvent[] {
  const durationMs = getNumber(input, ["durationMs", "duration_ms", "elapsedMs"]) ?? getNestedNumber(input, [["session", "durationMs"], ["payload", "durationMs"]]);
  const durationBucket = bucketDurationMs(durationMs);
  // Catalog only includes agent_loop_long (risk), not agent_loop_completed.
  if (durationBucket === "30-60m" || durationBucket === "60m+") {
    return [{ eventType: "agent_loop_long", severity: durationBucket === "60m+" ? "high" : "medium", metadata: { durationBucket, reason: "long_session", trigger: "inferred" } }];
  }
  return [];
}

function getToolName(input: ClaudeHookInput): string | undefined {
  return getString(input, ["toolName", "tool_name", "name"]) ?? getNestedString(input, [["tool", "name"], ["tool_use", "name"], ["payload", "toolName"]]);
}

function isWriteTool(toolName: string | undefined): boolean {
  const value = toolName?.toLowerCase();
  return value === "write" || value === "edit" || value === "multiedit";
}

function sanitiseToolName(toolName: string | undefined): string {
  if (!toolName) return "unknown";
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
}
