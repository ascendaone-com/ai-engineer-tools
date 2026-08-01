import {
  bucketDurationMs,
  classifyCommand,
  getNestedString,
  getString,
  inferOutcome,
  isVerificationCommand,
  looksLikeCorrection
} from "@ascenda-one/tool-kit";
import { CODEX_HOST, CodexHookEventName, CodexHookInput, MappedCodexEvent } from "./types.js";

/**
 * Maps Codex lifecycle hooks to the canonical Ascenda event catalog.
 * Catalog values only; hooks without a catalog counterpart map to nothing.
 * See docs/CODEX_MAPPING.md.
 */
export function mapCodexEvent(hookName: CodexHookEventName, input: CodexHookInput, turnDurationMs?: number): MappedCodexEvent[] {
  switch (hookName) {
    case "SessionStart": return mapSessionStart(input);
    case "UserPromptSubmit": return mapUserPromptSubmit(input);
    case "PreToolUse": return [{ eventType: "ai_tool_call_started", severity: "low", metadata: withHost({ toolName: sanitiseToolName(getToolName(input)) }) }];
    case "PostToolUse": return mapPostToolUse(input);
    case "PreCompact": return mapPreCompact(input);
    case "PostCompact": return [{ eventType: "context_pressure_high", severity: "medium", metadata: withHost({ trigger: "inferred", reason: "context_limit" }) }];
    case "Stop": return mapStop(turnDurationMs);
    // No catalog events for approvals or subagent lifecycle; skip to avoid unclassified noise.
    case "PermissionRequest":
    case "SubagentStart":
    case "SubagentStop":
      return [];
    default: return [];
  }
}

function mapSessionStart(input: CodexHookInput): MappedCodexEvent[] {
  const source = getString(input, ["source"]);
  // "clear" and "compact" restarts are not new working sessions.
  if (source && source !== "startup" && source !== "resume") return [];
  return [{ eventType: "create_focus_session", severity: "low", metadata: withHost({ activity: "session_started" }) }];
}

function mapUserPromptSubmit(input: CodexHookInput): MappedCodexEvent[] {
  const prompt = getString(input, ["prompt", "userPrompt", "message"]) ?? getNestedString(input, [["payload", "prompt"]]);
  const events: MappedCodexEvent[] = [{ eventType: "ai_prompt_submitted", severity: "low", metadata: withHost({ promptClass: "unknown" }) }];
  if (looksLikeCorrection(prompt)) {
    events.push({ eventType: "ai_correction_prompt", severity: "medium", metadata: withHost({ reason: "repeated_reprompting", trigger: "inferred" }) });
  }
  return events;
}

function mapPostToolUse(input: CodexHookInput): MappedCodexEvent[] {
  const toolName = getToolName(input);
  const safeToolName = sanitiseToolName(toolName);
  const outcome = inferOutcome(input);
  const command = getString(input, ["command"]) ?? getNestedString(input, [["tool_input", "command"], ["input", "command"]]);
  const commandClass = classifyCommand(command);
  const lowered = toolName?.toLowerCase();
  const isShell = lowered === "bash" || lowered === "shell" || lowered === "local_shell";

  if (outcome === "failure") {
    if (isShell && isVerificationCommand(commandClass)) {
      return [{ eventType: "compile_error", severity: "medium", metadata: withHost({ toolName: safeToolName, commandClass, outcome, reason: "test_failure" }) }];
    }
    return [{ eventType: "ai_tool_call_failed", severity: "medium", metadata: withHost({ toolName: safeToolName, commandClass, outcome, reason: "tool_failure" }) }];
  }

  // apply_patch is Codex's file-modification tool.
  if (lowered === "apply_patch") {
    return [{ eventType: "ai_file_edit", severity: "low", metadata: withHost({ toolName: safeToolName, outcome }) }];
  }

  if (isShell && isVerificationCommand(commandClass)) {
    return [{ eventType: "editor_verification_activity", severity: "low", metadata: withHost({ toolName: safeToolName, commandClass, outcome, activity: "ai_test_or_build_run" }) }];
  }

  return [{ eventType: "ai_tool_call_completed", severity: "low", metadata: withHost({ toolName: safeToolName, commandClass, outcome }) }];
}

function mapPreCompact(input: CodexHookInput): MappedCodexEvent[] {
  const trigger = getString(input, ["trigger", "reason"]);
  const isManual = trigger?.toLowerCase().includes("manual") ?? false;
  return [{ eventType: isManual ? "context_compression_manual" : "context_compression_auto", severity: isManual ? "medium" : "high", metadata: withHost({ trigger: isManual ? "manual" : "auto", reason: "context_limit" }) }];
}

function mapStop(turnDurationMs: number | undefined): MappedCodexEvent[] {
  const durationBucket = bucketDurationMs(turnDurationMs);
  if (durationBucket === "30-60m" || durationBucket === "60m+") {
    return [{ eventType: "agent_loop_long", severity: durationBucket === "60m+" ? "high" : "medium", metadata: withHost({ durationBucket, reason: "long_session", trigger: "inferred" }) }];
  }
  return [];
}

function getToolName(input: CodexHookInput): string | undefined {
  return getString(input, ["tool_name", "toolName", "name"]);
}

function sanitiseToolName(toolName: string | undefined): string {
  if (!toolName) return "unknown";
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
}

function withHost(metadata: Record<string, unknown>): MappedCodexEvent["metadata"] {
  return { host: CODEX_HOST, ...metadata } as MappedCodexEvent["metadata"];
}
