export type { AscendaEventPayload, CommandOutcome, IngestResult } from "@ascenda-one/tool-contract";
import type { AscendaEventMetadata, AscendaSeverity, AscendaTelemetryEventType } from "@ascenda-one/tool-contract";

/** Cascade hooks (docs.windsurf.com/windsurf/cascade/hooks). */
export type WindsurfHookEventName =
  | "pre_read_code" | "post_read_code"
  | "pre_write_code" | "post_write_code"
  | "pre_run_command" | "post_run_command"
  | "pre_mcp_tool_use" | "post_mcp_tool_use"
  | "pre_user_prompt"
  | "post_cascade_response" | "post_cascade_response_with_transcript"
  | "post_setup_worktree";

export type WindsurfHookInput = Record<string, unknown>;

export type MappedWindsurfEvent = {
  eventType: AscendaTelemetryEventType;
  severity: AscendaSeverity;
  metadata?: AscendaEventMetadata;
};

export const ASCENDA_TOOL_TYPE = "cli_agent";
export const WINDSURF_HOST = "windsurf";
