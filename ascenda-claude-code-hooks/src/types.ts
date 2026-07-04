export type ClaudeHookEventName =
  | "UserPromptSubmit" | "PreToolUse" | "PostToolUse"
  | "PreCompact" | "PostCompact" | "Stop" | "Notification";

export type ToolConsentScope = "ide_telemetry" | "workflow_telemetry" | "subjective_checkins";

/** Canonical catalog only — unknown types classify as unclassified on the backend. */
export type AscendaTelemetryEventType =
  | "create_focus_session"
  | "ai_prompt_submitted"
  | "ai_generation_completed"
  | "ai_file_write"
  | "ai_file_edit"
  | "editor_verification_activity"
  | "compile_diagnostic"
  | "editor_correction_activity"
  | "ai_correction_prompt"
  | "supervis_meeting_load"
  | "ai_tool_call_started"
  | "ai_tool_call_completed"
  | "ai_tool_call_failed"
  | "context_pressure_high"
  | "agent_loop_long"
  | "after_hours_ai_session"
  | "compile_error"
  | "tool_failure"
  | "recovery_offline_period"
  | "context_compression_manual"
  | "context_compression_auto"
  | "editor_activity";

export type AscendaSeverity = "low" | "medium" | "high" | "critical";
export type AscendaPrivacyMode = "metadata_only" | "content_opt_in";
export type CommandClass = "test" | "lint" | "typecheck" | "build" | "run" | "git" | "install" | "unknown";
export type CommandOutcome = "success" | "failure" | "cancelled" | "unknown";
export type DurationBucket = "0-1m" | "1-5m" | "5-10m" | "10-30m" | "30-60m" | "60m+";

export type AscendaEventMetadata = Record<string, string | number | boolean | null | undefined> & {
  commandClass?: CommandClass;
  outcome?: CommandOutcome;
  durationBucket?: DurationBucket;
  trigger?: "manual" | "auto" | "inferred";
  reason?: "context_limit" | "repeated_reprompting" | "tool_failure" | "test_failure" | "manual_interrupt" | "after_hours" | "long_session" | "unknown";
  promptClass?: string;
  toolName?: string;
  activity?: string;
};

export type AscendaEventPayload = {
  toolInstallationId: string;
  source: "claude_code";
  eventType: AscendaTelemetryEventType;
  occurredAt: string;
  severity: AscendaSeverity;
  sessionId?: string | null;
  workspaceHash?: string | null;
  projectHash?: string | null;
  consentScope: ToolConsentScope;
  provenance: string;
  privacyMode: AscendaPrivacyMode;
  metadata?: AscendaEventMetadata;
};

export type MappedAscendaEvent = Omit<AscendaEventPayload, "toolInstallationId" | "source" | "occurredAt" | "consentScope" | "provenance" | "privacyMode">;
export type ClaudeHookInput = Record<string, unknown>;

export type RenewToolTokenResponse = {
  eventWriteToken: string;
  expiresAt: string;
};

export const ASCENDA_TOOL_TYPE = "claude_code";
export const ASCENDA_CONSENT_SCOPE: ToolConsentScope = "ide_telemetry";
export const ASCENDA_PROVENANCE = "ai_work_telemetry";

export type IngestResult = "accepted" | "auth_failed" | "consent_missing" | "validation_failed" | "other";
