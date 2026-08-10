import { classifyCommand, classifyGitAction, isVerificationCommand, isReworkGitAction, classifyWorkMilestone, invitesDebrief } from "@ascenda-one/tool-kit";
import { CLAUDE_HOST, ClaudeHookEventName, ClaudeHookInput, MappedAscendaEvent } from "./types.js";
import { bucketDurationMs, bucketLinesChanged, getNested, getNestedNumber, getNestedString, getNumber, getString, outcomeForHook, looksLikeCorrection } from "./safeExtract.js";

/**
 * Every adapter tags `metadata.host` so one local log or one backend query can
 * separate agents. Claude also has its own `source`, but staying uniform keeps
 * cross-agent queries from needing a special case.
 */
export function mapClaudeEvent(hookName: ClaudeHookEventName, input: ClaudeHookInput): MappedAscendaEvent[] {
  return mapEvent(hookName, input).map((event) => ({
    ...event,
    metadata: { host: CLAUDE_HOST, ...event.metadata }
  }));
}

function mapEvent(hookName: ClaudeHookEventName, input: ClaudeHookInput): MappedAscendaEvent[] {
  switch (hookName) {
    case "SessionStart": return mapSessionStart(input);
    case "UserPromptSubmit": return mapUserPromptSubmit(input);
    case "PreToolUse": return mapPreToolUse(input);
    // Success and failure arrive on different hooks with different payloads —
    // PostToolUse carries tool_response and no exit code; PostToolUseFailure
    // carries `error`/`is_interrupt` and no tool_response. One mapper handles
    // both so the event vocabulary cannot drift between the two paths.
    case "PostToolUse":
    case "PostToolUseFailure": return mapPostToolUse(hookName, input);
    case "PreCompact": return mapPreCompact(input);
    case "PostCompact": return [{ eventType: "context_pressure_high", severity: "medium", metadata: { trigger: "inferred", reason: "context_limit" } }];
    case "Stop": return mapStop(input);
    // No catalog event for notifications; skip to avoid unclassified noise.
    case "Notification": return [];
    default: return [];
  }
}

/**
 * "clear" and "compact" restarts are context resets mid-work, not a new
 * working session — asking "what should this session accomplish" again
 * right after one would be repetitive rather than useful. Exported so
 * cli.ts's context-injection decision uses the exact same rule as the
 * telemetry decision below, rather than a second copy that could drift.
 */
export function isNewSessionStart(input: ClaudeHookInput): boolean {
  const source = getString(input, ["source"]);
  return !source || source === "startup" || source === "resume";
}

/**
 * Whether this PostToolUse just completed a piece of work worth debriefing
 * (H1). Exported so the CLI can decide about the invitation without
 * re-extracting the command — and so the "only completions, only successes"
 * rule has one implementation rather than two that can drift.
 *
 * PostToolUse-only by contract (the CLI's one call site gates on the hook
 * name): a failed merge fires PostToolUseFailure and never gets here, so
 * "only successes" is enforced by the runtime's own event split. The
 * remaining check is for the interrupted case — a merge the user stopped
 * finished nothing, so it asks nothing.
 */
export function milestoneInviting(input: ClaudeHookInput): boolean {
  if (outcomeForHook("PostToolUse", input) !== "success") return false;
  const command = getString(input, ["command"]) ?? getNestedString(input, [["tool_input", "command"], ["input", "command"], ["parameters", "command"]]);
  return invitesDebrief(classifyWorkMilestone(command));
}

function mapSessionStart(input: ClaudeHookInput): MappedAscendaEvent[] {
  if (!isNewSessionStart(input)) return [];
  return [{ eventType: "create_focus_session", severity: "low", metadata: { activity: "session_started" } }];
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

function mapPostToolUse(hookName: ClaudeHookEventName, input: ClaudeHookInput): MappedAscendaEvent[] {
  const toolName = getToolName(input);
  const safeToolName = sanitiseToolName(toolName);
  // The outcome is carried by *which hook fired*, not by the payload: there
  // is no exit code anywhere in a PostToolUse payload, and a failed call is
  // routed to PostToolUseFailure instead. inferOutcome read fields Claude
  // never sends, so every outcome was "unknown" — which silently disabled
  // compile_error, ai_tool_call_failed, and every outcome:"success" marker
  // the backend's verification/commit boundaries key on.
  const outcome = outcomeForHook(hookName, input);
  // `duration_ms` is the real, top-level field (captured 27 Jul); the
  // camelCase and nested forms remain as harmless fallbacks.
  const durationMs = getNumber(input, ["duration_ms", "durationMs", "elapsedMs"]) ?? getNestedNumber(input, [["tool_response", "durationMs"], ["result", "durationMs"]]);
  const command = getString(input, ["command"]) ?? getNestedString(input, [["tool_input", "command"], ["input", "command"], ["parameters", "command"]]);
  const commandClass = classifyCommand(command);
  // Only a git action that actually succeeded is a boundary or a reversion —
  // a failed push moved nothing, a failed reset undid nothing, and an
  // interrupted push proved nothing either way.
  const gitAction = outcome === "success" ? classifyGitAction(command) : undefined;
  // A failed `gh pr merge` did not complete anything, so — like gitAction — a
  // milestone is only read off a command that actually succeeded.
  const milestoneKind = outcome === "success" ? classifyWorkMilestone(command) : undefined;

  if (outcome === "cancelled") {
    // Stopped work is not wrong work: an interrupted test run is not a
    // compile_error (it proved nothing either way), and severity stays low —
    // the user pressing escape is routine, not risk.
    return [{ eventType: "ai_tool_call_failed", severity: "low", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs), reason: "manual_interrupt" } }];
  }

  if (outcome === "failure") {
    if (toolName?.toLowerCase() === "bash" && isVerificationCommand(commandClass)) {
      return [{ eventType: "compile_error", severity: "medium", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs), reason: "test_failure" } }];
    }
    return [{ eventType: "ai_tool_call_failed", severity: "medium", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs), reason: "tool_failure" } }];
  }

  if (isWriteTool(toolName)) {
    const linesChanged = computeLinesChanged(toolName, input);
    return [{
      eventType: toolName?.toLowerCase() === "write" ? "ai_file_write" : "ai_file_edit",
      severity: "low",
      metadata: {
        toolName: safeToolName,
        outcome,
        durationBucket: bucketDurationMs(durationMs),
        // The boundary C2/the macOS work-self-report card triggers on: at
        // "200+" this is the "substantial accepted change" moment. No
        // second event type exists for this — the bucket on the existing
        // creation event *is* the boundary, deliberately, since the write
        // already happened; there is nothing else to mark.
        ...(linesChanged !== undefined ? { linesChangedBucket: bucketLinesChanged(linesChanged) } : {})
      }
    }];
  }

  if (toolName?.toLowerCase() === "bash" && isVerificationCommand(commandClass)) {
    return [{ eventType: "editor_verification_activity", severity: "low", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs), activity: "ai_test_or_build_run" } }];
  }

  return [{
    eventType: "ai_tool_call_completed",
    severity: "low",
    metadata: {
      toolName: safeToolName,
      commandClass,
      outcome,
      durationBucket: bucketDurationMs(durationMs),
      // The boundary and rework signal both ride this existing event rather
      // than minting a type: the backend already reads `gitAction` off any
      // event, and a commit is not a different *kind* of thing happening, it
      // is a fact about the tool call that just happened.
      ...(gitAction !== undefined ? { gitAction } : {}),
      ...(isReworkGitAction(gitAction) ? { activity: "rework_reversion" } : {}),
      // Same reasoning as `gitAction` above, one grain coarser: a milestone is
      // a fact about the tool call that just happened, not a different kind of
      // event. It rides here so the record carries the work's own rhythm —
      // ticket closed, PR merged — beside the keystroke boundaries (H1).
      ...(milestoneKind !== undefined ? { milestoneKind } : {})
    }
  }];
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

/**
 * Reads `old_string`/`new_string`/`content`/`edits` from `tool_input` — the
 * same fields the model just wrote — purely to count lines, then discards
 * them. Nothing here is transmitted; only the bucketed count downstream
 * ever reaches an event. Returns undefined when the shape doesn't match
 * (missing fields, wrong types), so a version drift in the hook payload
 * degrades to "not collected" rather than a wrong count.
 */
function computeLinesChanged(toolName: string | undefined, input: ClaudeHookInput): number | undefined {
  const toolInput = getNested(input, ["tool_input"]) ?? getNested(input, ["input"]) ?? getNested(input, ["parameters"]);
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const record = toolInput as Record<string, unknown>;

  switch (toolName?.toLowerCase()) {
    case "write": {
      const content = record["content"];
      return typeof content === "string" ? countLines(content) : undefined;
    }
    case "edit": {
      const oldStr = record["old_string"];
      const newStr = record["new_string"];
      if (typeof oldStr !== "string" || typeof newStr !== "string") return undefined;
      return Math.max(countLines(oldStr), countLines(newStr));
    }
    case "multiedit": {
      const edits = record["edits"];
      if (!Array.isArray(edits)) return undefined;
      let total = 0;
      let sawOne = false;
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue;
        const oldStr = (edit as Record<string, unknown>)["old_string"];
        const newStr = (edit as Record<string, unknown>)["new_string"];
        if (typeof oldStr !== "string" || typeof newStr !== "string") continue;
        sawOne = true;
        total += Math.max(countLines(oldStr), countLines(newStr));
      }
      return sawOne ? total : undefined;
    }
    default:
      return undefined;
  }
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function isWriteTool(toolName: string | undefined): boolean {
  const value = toolName?.toLowerCase();
  return value === "write" || value === "edit" || value === "multiedit";
}

function sanitiseToolName(toolName: string | undefined): string {
  if (!toolName) return "unknown";
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
}
