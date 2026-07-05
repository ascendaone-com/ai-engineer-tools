import type { AscendaEventPayload } from "@ascenda/tool-contract";

export type {
  AscendaEventMetadata,
  AscendaEventPayload,
  AscendaPrivacyMode,
  AscendaSeverity,
  AscendaTelemetryEventType,
  CommandClass,
  CommandOutcome,
  DurationBucket,
  IngestResult,
  RenewToolTokenResponse,
  ToolConsentScope
} from "@ascenda/tool-contract";
export { ASCENDA_CONSENT_SCOPE, ASCENDA_PROVENANCE } from "@ascenda/tool-contract";

export type ClaudeHookEventName =
  | "UserPromptSubmit" | "PreToolUse" | "PostToolUse"
  | "PreCompact" | "PostCompact" | "Stop" | "Notification";

export type MappedAscendaEvent = Omit<AscendaEventPayload, "toolInstallationId" | "source" | "occurredAt" | "consentScope" | "provenance" | "privacyMode">;
export type ClaudeHookInput = Record<string, unknown>;

export const ASCENDA_TOOL_TYPE = "claude_code";
