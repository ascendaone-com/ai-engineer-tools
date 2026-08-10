import type { AscendaEventPayload } from "@ascenda-one/tool-contract";

export type { AscendaEventPayload, CommandOutcome, IngestResult } from "@ascenda-one/tool-contract";
export { ASCENDA_CONSENT_SCOPE, ASCENDA_PROVENANCE } from "@ascenda-one/tool-contract";

export type ClaudeHookEventName =
  | "SessionStart" | "UserPromptSubmit" | "PreToolUse"
  // Success and failure are separate events in Claude Code's hook model — a
  // failed tool call fires PostToolUseFailure and never reaches PostToolUse.
  // Registering only PostToolUse makes failures invisible entirely.
  | "PostToolUse" | "PostToolUseFailure"
  | "PreCompact" | "PostCompact" | "Stop" | "Notification";

export type MappedAscendaEvent = Omit<AscendaEventPayload, "toolInstallationId" | "source" | "occurredAt" | "consentScope" | "provenance" | "privacyMode">;
export type ClaudeHookInput = Record<string, unknown>;

export const ASCENDA_TOOL_TYPE = "claude_code";
export const CLAUDE_HOST = "claude_code";
