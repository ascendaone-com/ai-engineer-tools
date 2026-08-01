export type { AscendaEventPayload, CommandOutcome, IngestResult } from "@ascenda-one/tool-contract";
import type { AscendaEventMetadata, AscendaSeverity, AscendaTelemetryEventType } from "@ascenda-one/tool-contract";

/** Codex lifecycle hook events (developers.openai.com/codex/hooks). */
export type CodexHookEventName =
  | "SessionStart" | "UserPromptSubmit"
  | "PreToolUse" | "PermissionRequest" | "PostToolUse"
  | "PreCompact" | "PostCompact"
  | "SubagentStart" | "SubagentStop" | "Stop";

export type CodexHookInput = Record<string, unknown>;

export type MappedCodexEvent = {
  eventType: AscendaTelemetryEventType;
  severity: AscendaSeverity;
  metadata?: AscendaEventMetadata;
};

/**
 * Backend toolType/source registry has no codex-specific value yet; Codex
 * rides the canonical cli_agent identity, with metadata.host distinguishing
 * it for later disaggregation.
 */
export const ASCENDA_TOOL_TYPE = "cli_agent";
export const CODEX_HOST = "codex";
