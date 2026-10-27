export type { AscendaEventPayload, CommandOutcome, IngestResult } from "@ascenda-one/tool-contract";
import type { AscendaEventMetadata, AscendaSeverity, AscendaTelemetryEventType } from "@ascenda-one/tool-contract";

/**
 * GitHub Copilot CLI hooks, by their camelCase names. Each also has a
 * PascalCase alias that switches the payload to snake_case and Claude Code's
 * tool names; only the camelCase names are registered.
 */
export type CopilotHookEventName =
  | "sessionStart" | "sessionEnd"
  | "userPromptSubmitted" | "userPromptTransformed"
  | "preToolUse" | "postToolUse" | "postToolUseFailure"
  | "preCompact"
  | "subagentStart" | "subagentStop"
  | "agentStop"
  | "permissionRequest" | "notification" | "errorOccurred";

export type CopilotHookInput = Record<string, unknown>;

export type MappedCopilotEvent = {
  eventType: AscendaTelemetryEventType;
  severity: AscendaSeverity;
  metadata?: AscendaEventMetadata;
};

export const ASCENDA_TOOL_TYPE = "cli_agent";
export const COPILOT_HOST = "copilot_cli";
