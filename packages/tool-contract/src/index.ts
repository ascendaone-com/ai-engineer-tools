/**
 * Canonical Ascenda tool telemetry contract.
 * Mirrors api-docs/TOOL_PAIRING_API_REFERENCE.md — change that document first.
 */

export type PairingSessionStatus = "pending" | "paired" | "expired" | "cancelled";

export type PairingSessionResponse = {
  pairingSessionId: string;
  code: string;
  deviceCode: string;
  secret?: string;
  qrUrl: string;
  expiresAt: string;
};

export type PairingStatusResponse = {
  status: PairingSessionStatus;
  toolInstallationId: string | null;
  eventWriteToken: string | null;
  pairedAt: string | null;
};

export type RenewToolTokenResponse = {
  eventWriteToken: string;
  expiresAt: string;
};

export type ConnectedTool = {
  toolInstallationId: string;
  toolType: string;
  displayName: string | null;
  pairedAt: string | null;
  lastSeenAt: string | null;
};

export type ToolConsentScope = "ide_telemetry" | "workflow_telemetry" | "subjective_checkins";

export type AscendaTelemetrySource =
  | "vscode_extension"
  | "cursor_mcp"
  | "claude_code"
  | "copilot_otel"
  | "cli_agent"
  | "mcp_server"
  | "activity_signals";

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
export type DurationBucket = "0-1m" | "1-5m" | "5-10m" | "10-30m" | "30-60m" | "60m+";
export type LinesChangedBucket = "0" | "1-10" | "10-50" | "50-200" | "200+";
export type CommandClass = "test" | "lint" | "typecheck" | "build" | "run" | "git" | "install" | "unknown";
export type CommandOutcome = "success" | "failure" | "cancelled" | "unknown";
export type PromptClass = "creation" | "verification" | "correction" | "debugging" | "planning" | "unknown";

export type AscendaEventMetadata = Record<string, string | number | boolean | null | undefined> & {
  language?: string | null;
  fileType?: string | null;
  durationBucket?: DurationBucket;
  tokenPressureBucket?: "low" | "medium" | "high" | "critical";
  linesChangedBucket?: LinesChangedBucket;
  commandClass?: CommandClass;
  outcome?: CommandOutcome;
  trigger?: "manual" | "auto" | "inferred";
  promptClass?: PromptClass;
  reason?: "context_limit" | "repeated_reprompting" | "tool_failure" | "test_failure" | "manual_interrupt" | "after_hours" | "long_session" | "unknown";
  afterHours?: boolean;
  activity?: string;
  message?: string;
  host?: string;
  toolName?: string;
  simulated?: boolean;
  relatedEventType?: string;
};

export type AscendaEventPayload = {
  toolInstallationId: string;
  source: AscendaTelemetrySource;
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

export type IngestResult = "accepted" | "auth_failed" | "consent_missing" | "validation_failed" | "other";

export const ASCENDA_CONSENT_SCOPE: ToolConsentScope = "ide_telemetry";
export const ASCENDA_PROVENANCE = "ai_work_telemetry";
