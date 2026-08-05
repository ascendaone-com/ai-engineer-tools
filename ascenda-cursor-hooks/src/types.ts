export type { AscendaEventPayload, CommandOutcome, IngestResult } from "@ascenda-one/tool-contract";
import type { AscendaEventMetadata, AscendaSeverity, AscendaTelemetryEventType } from "@ascenda-one/tool-contract";

/** Cursor agent lifecycle hooks (cursor.com/docs/agent/hooks). */
export type CursorHookEventName =
  | "sessionStart" | "sessionEnd"
  | "beforeSubmitPrompt"
  | "preToolUse" | "postToolUse" | "postToolUseFailure"
  | "beforeShellExecution" | "afterShellExecution"
  | "beforeMCPExecution" | "afterMCPExecution"
  | "beforeReadFile" | "afterFileEdit"
  | "subagentStart" | "subagentStop"
  | "afterAgentResponse" | "afterAgentThought"
  | "preCompact" | "stop"
  | "beforeTabFileRead" | "afterTabFileEdit"
  | "workspaceOpen";

export type CursorHookInput = Record<string, unknown>;

export type MappedCursorEvent = {
  eventType: AscendaTelemetryEventType;
  severity: AscendaSeverity;
  metadata?: AscendaEventMetadata;
};

/**
 * Backend toolType/source registry has no cursor-agent value yet. The Cursor
 * *extension* already owns `cursor_mcp`, so the agent hooks ride `cli_agent`
 * like Codex, with metadata.host separating them for later disaggregation.
 */
export const ASCENDA_TOOL_TYPE = "cli_agent";
export const CURSOR_HOST = "cursor";
