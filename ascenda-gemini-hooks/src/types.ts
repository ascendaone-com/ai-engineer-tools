export type { AscendaEventPayload, CommandOutcome, IngestResult } from "@ascenda-one/tool-contract";
import type { AscendaEventMetadata, AscendaSeverity, AscendaTelemetryEventType } from "@ascenda-one/tool-contract";

/** Gemini CLI hooks (geminicli.com/docs/hooks/reference). Enabled by default since v0.26.0. */
export type GeminiHookEventName =
  | "SessionStart" | "SessionEnd"
  | "BeforeAgent" | "AfterAgent"
  | "BeforeModel" | "AfterModel" | "BeforeToolSelection"
  | "BeforeTool" | "AfterTool"
  | "PreCompress"
  | "Notification";

export type GeminiHookInput = Record<string, unknown>;

export type MappedGeminiEvent = {
  eventType: AscendaTelemetryEventType;
  severity: AscendaSeverity;
  metadata?: AscendaEventMetadata;
};

export const ASCENDA_TOOL_TYPE = "cli_agent";
export const GEMINI_HOST = "gemini_cli";
