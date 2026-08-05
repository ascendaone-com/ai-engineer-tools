import {
  bucketDurationMs,
  classifyCommand,
  getNested,
  getNestedString,
  isVerificationCommand,
  looksLikeCorrection
} from "@ascenda-one/tool-kit";
import { MappedWindsurfEvent, WINDSURF_HOST, WindsurfHookEventName, WindsurfHookInput } from "./types.js";

/**
 * Maps Cascade hooks to the canonical Ascenda event catalog.
 * Catalog values only; hooks without a catalog counterpart map to nothing.
 * See docs/WINDSURF_MAPPING.md.
 *
 * Two coverage gaps are inherent to Cascade's hook set, not to this mapper:
 * there is no compaction hook, so `context_compression_*` and
 * `context_pressure_high` are unreachable; and the post_* hooks carry no exit
 * status, so command outcome is always `unknown` and `compile_error` can never
 * fire. Everything else in the agent catalog is covered.
 */
export function mapWindsurfEvent(hookName: WindsurfHookEventName, input: WindsurfHookInput, turnDurationMs?: number): MappedWindsurfEvent[] {
  switch (hookName) {
    case "pre_user_prompt": return mapUserPrompt(input);
    case "pre_read_code": return [started("read_code")];
    case "post_read_code": return [{ eventType: "ai_tool_call_completed", severity: "low", metadata: withHost({ toolName: "read_code", outcome: "unknown" }) }];
    case "pre_write_code": return [started("write_code")];
    case "post_write_code": return [{ eventType: "ai_file_edit", severity: "low", metadata: withHost({ toolName: "write_code", outcome: "unknown" }) }];
    case "pre_run_command": return [started("run_command", classifyCommand(getCommand(input)))];
    case "post_run_command": return mapPostRunCommand(input);
    case "pre_mcp_tool_use": return [started(mcpToolName(input))];
    case "post_mcp_tool_use": return mapPostMcpToolUse(input);
    case "post_cascade_response": return mapTurnEnd(turnDurationMs);

    // post_cascade_response_with_transcript repeats the turn end and points at
    // a transcript file (raw conversation content — never read or transmitted).
    // post_setup_worktree has no catalog counterpart.
    default: return [];
  }
}

function mapUserPrompt(input: WindsurfHookInput): MappedWindsurfEvent[] {
  const prompt = getNestedString(input, [["tool_info", "user_prompt"]]);
  const events: MappedWindsurfEvent[] = [{ eventType: "ai_prompt_submitted", severity: "low", metadata: withHost({ promptClass: "unknown" }) }];
  if (looksLikeCorrection(prompt)) {
    events.push({ eventType: "ai_correction_prompt", severity: "medium", metadata: withHost({ reason: "repeated_reprompting", trigger: "inferred" }) });
  }
  return events;
}

function mapPostRunCommand(input: WindsurfHookInput): MappedWindsurfEvent[] {
  const commandClass = classifyCommand(getCommand(input));
  if (isVerificationCommand(commandClass)) {
    return [{ eventType: "editor_verification_activity", severity: "low", metadata: withHost({ toolName: "run_command", commandClass, outcome: "unknown", activity: "ai_test_or_build_run" }) }];
  }
  return [{ eventType: "ai_tool_call_completed", severity: "low", metadata: withHost({ toolName: "run_command", commandClass, outcome: "unknown" }) }];
}

/** The only Cascade hook carrying a result, so the only one that can report failure. */
function mapPostMcpToolUse(input: WindsurfHookInput): MappedWindsurfEvent[] {
  const toolName = mcpToolName(input);
  const failed = mcpResultFailed(input);
  if (failed) {
    return [{ eventType: "ai_tool_call_failed", severity: "medium", metadata: withHost({ toolName, outcome: "failure", reason: "tool_failure" }) }];
  }
  return [{ eventType: "ai_tool_call_completed", severity: "low", metadata: withHost({ toolName, outcome: "unknown" }) }];
}

function mapTurnEnd(turnDurationMs: number | undefined): MappedWindsurfEvent[] {
  const durationBucket = bucketDurationMs(turnDurationMs);
  if (durationBucket === "30-60m" || durationBucket === "60m+") {
    return [{ eventType: "agent_loop_long", severity: durationBucket === "60m+" ? "high" : "medium", metadata: withHost({ durationBucket, reason: "long_session", trigger: "inferred" }) }];
  }
  return [];
}

function started(toolName: string, commandClass?: string): MappedWindsurfEvent {
  return { eventType: "ai_tool_call_started", severity: "low", metadata: withHost(commandClass ? { toolName, commandClass } : { toolName }) };
}

function getCommand(input: WindsurfHookInput): string | undefined {
  return getNestedString(input, [["tool_info", "command_line"]]);
}

function mcpToolName(input: WindsurfHookInput): string {
  const name = getNestedString(input, [["tool_info", "mcp_tool_name"]]);
  return sanitiseToolName(name ? `mcp_${name}` : "mcp_tool");
}

/**
 * `mcp_result` is free-form per server, so only an explicit error marker counts
 * as failure — guessing from arbitrary payload shapes would invent failures.
 */
function mcpResultFailed(input: WindsurfHookInput): boolean {
  const result = getNested(input, ["tool_info", "mcp_result"]);
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  if (record.isError === true || record.is_error === true) return true;
  return typeof record.error === "string" && record.error.trim().length > 0;
}

function sanitiseToolName(toolName: string): string {
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
}

function withHost(metadata: Record<string, unknown>): MappedWindsurfEvent["metadata"] {
  return { host: WINDSURF_HOST, ...metadata } as MappedWindsurfEvent["metadata"];
}
