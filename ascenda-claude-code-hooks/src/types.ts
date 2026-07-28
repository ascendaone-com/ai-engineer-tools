import type { AscendaEventPayload } from "@ascenda-one/tool-contract";

export type { AscendaEventPayload, CommandOutcome, IngestResult } from "@ascenda-one/tool-contract";
export { ASCENDA_CONSENT_SCOPE, ASCENDA_PROVENANCE } from "@ascenda-one/tool-contract";

export type ClaudeHookEventName =
  | "UserPromptSubmit" | "PreToolUse" | "PostToolUse"
  | "PreCompact" | "PostCompact" | "Stop" | "Notification";

export type MappedAscendaEvent = Omit<AscendaEventPayload, "toolInstallationId" | "source" | "occurredAt" | "consentScope" | "provenance" | "privacyMode">;
export type ClaudeHookInput = Record<string, unknown>;

export const ASCENDA_TOOL_TYPE = "claude_code";
