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

/**
 * `semantic_work_signals` is its own scope, not a variant of `ide_telemetry`.
 * The events it gates are content-derived even though no raw content ever
 * leaves the host: the classification (goal_drift, approach_churn, ...) is
 * produced by reading the prompt/tool stream, which `ide_telemetry`'s
 * lifecycle events (tool calls, file writes, compaction) never require.
 * Default off; a user consenting to `ide_telemetry` has not consented to this.
 */
export type ToolConsentScope = "ide_telemetry" | "workflow_telemetry" | "subjective_checkins" | "semantic_work_signals";

export type AscendaTelemetrySource =
  | "vscode_extension"
  | "cursor_mcp"
  | "claude_code"
  | "copilot_otel"
  | "cli_agent"
  | "mcp_server"
  | "activity_signals"
  | "code_forge";

/**
 * Canonical catalog only — unknown types classify as unclassified on the backend.
 *
 * The six types from `approach_churn_detected` onward are semantic: nobody can
 * derive them from a single deterministic host event the way `tool_failure` or
 * `context_compression_auto` are derived. They come from an agent skill reading
 * the interaction, not from a hook. See `SEMANTIC_WORK_SIGNAL_EVENT_TYPES` —
 * that list, not this comment, is the source of truth a validator or a skill
 * package should import.
 */
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
  | "editor_activity"
  | "approach_churn_detected"
  | "goal_drift_detected"
  | "progress_stalled"
  | "progress_recovered"
  | "session_intention_declared"
  | "scope_change_declared"
  | "review_requested_of_me"
  | "review_given"
  | "pull_request_opened";

/**
 * The semantic subset of {@link AscendaTelemetryEventType} — agent-observed
 * patterns rather than host lifecycle events. A consumer needs exactly one
 * place to ask "is this one of those", so this is it: the skill package (A2)
 * gates emission on it, and backend ingestion (B4) validates against it rather
 * than each maintaining its own copy of the six strings.
 */
export const SEMANTIC_WORK_SIGNAL_EVENT_TYPES: readonly AscendaTelemetryEventType[] = [
  "approach_churn_detected",
  "goal_drift_detected",
  "progress_stalled",
  "progress_recovered",
  "session_intention_declared",
  "scope_change_declared"
];

/**
 * Collaboration events, emitted by a code-forge collector rather than a host
 * hook.
 *
 * **Strictly first-person.** Every one of these describes something the
 * installing user did or had asked of them. No event in this set carries
 * another person's identity, and none is emitted on behalf of a third party —
 * "who reviews for whom" is a picture of a team, and assembling it from
 * individual telemetry is how a wellbeing rail turns into a management tool.
 * Concentration of checking load therefore shows up where it belongs: in one
 * person's own supervision share, and in cohort aggregates that the org rail
 * already suppresses below its minimum.
 *
 * Withdrawal — reviewing *less*, contributing *less* — is deliberately not
 * derivable from this set and must never be inferred from it. A quiet week has
 * too many innocent explanations, and the report is explicit that withdrawal is
 * never to be machine-interpreted.
 */
export const COLLABORATION_EVENT_TYPES: readonly AscendaTelemetryEventType[] = [
  "review_requested_of_me",
  "review_given",
  "pull_request_opened"
];

export type AscendaSeverity = "low" | "medium" | "high" | "critical";
export type AscendaPrivacyMode = "metadata_only" | "content_opt_in";
export type DurationBucket = "0-1m" | "1-5m" | "5-10m" | "10-30m" | "30-60m" | "60m+";
export type LinesChangedBucket = "0" | "1-10" | "10-50" | "50-200" | "200+";
export type CommandClass = "test" | "lint" | "typecheck" | "build" | "run" | "git" | "install" | "unknown";
export type CommandOutcome = "success" | "failure" | "cancelled" | "unknown";

/**
 * What a git command did. `commit` and `push` are the two the backend turns
 * into work boundaries; `revert`, `reset_hard` and `restore` are rework — work
 * produced and then undone. `amend` is neither: it rewrites a commit that
 * already counted, so treating it as a fresh boundary would double-count the
 * same work.
 */
export type GitAction = "commit" | "push" | "amend" | "revert" | "reset_hard" | "restore";
export type PromptClass = "creation" | "verification" | "correction" | "debugging" | "planning" | "unknown";

export type AscendaEventMetadata = Record<string, string | number | boolean | null | undefined> & {
  language?: string | null;
  fileType?: string | null;
  durationBucket?: DurationBucket;
  tokenPressureBucket?: "low" | "medium" | "high" | "critical";
  linesChangedBucket?: LinesChangedBucket;
  commandClass?: CommandClass;

  /**
   * Set on a bash event whose command was a recognised git action. The backend
   * has read this key since the demand view shipped and, until the hooks began
   * sending it, nothing ever wrote it — so no user could produce a commit or
   * push boundary, and `commits_per_day` was unmeasurable for everyone.
   */
  gitAction?: GitAction;
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

  /**
   * Required whenever `eventType` is in {@link SEMANTIC_WORK_SIGNAL_EVENT_TYPES}.
   * Emission depends on the model remembering to call the tool, which drifts
   * with every model or skill revision — without this, a jump in (or drop in)
   * a semantic event's rate is indistinguishable from an actual change in the
   * work. Backend ingestion (B4) is expected to reject a semantic event that
   * omits it; this package only documents the requirement, since the payload
   * shape here stays a flat bag rather than a discriminated union per type.
   */
  skillVersion?: string;

  /** Hashed, local-only task identifier — never raw task content. */
  taskFingerprint?: string;
};

export type AscendaEventPayload = {
  toolInstallationId: string;
  source: AscendaTelemetrySource;
  eventType: AscendaTelemetryEventType;
  occurredAt: string;
  /**
   * For a type in {@link SEMANTIC_WORK_SIGNAL_EVENT_TYPES}, always send `"low"`.
   * Severity is a judgement against the person's own baseline, which the
   * emitter — hook or skill — cannot see; computing it here would mean an
   * agent asserting "this is elevated" from a single interaction, exactly the
   * inference §12e rules out. The only legitimate severity for these six comes
   * from the backend's own z-scored evaluation, never from the payload.
   */
  severity: AscendaSeverity;
  sessionId?: string | null;
  workspaceHash?: string | null;
  projectHash?: string | null;
  consentScope: ToolConsentScope;
  provenance: string;
  privacyMode: AscendaPrivacyMode;
  metadata?: AscendaEventMetadata;
};

export type WorkloadCategory = "creation" | "verification" | "supervision" | "risk" | "neutral" | "unclassified";

/** Canonical event -> workload category mapping, per the API reference catalog table. */
export const EVENT_WORKLOAD_CATEGORY: Record<AscendaTelemetryEventType, WorkloadCategory> = {
  create_focus_session: "creation",
  ai_prompt_submitted: "creation",
  ai_generation_completed: "creation",
  ai_file_write: "creation",
  ai_file_edit: "creation",
  editor_verification_activity: "verification",
  compile_diagnostic: "verification",
  editor_correction_activity: "supervision",
  ai_correction_prompt: "supervision",
  supervis_meeting_load: "supervision",
  ai_tool_call_started: "supervision",
  ai_tool_call_completed: "supervision",
  ai_tool_call_failed: "supervision",
  // Collaboration (the report's §4.2 collaboration family). Both review
  // events are supervision: being asked to check work, and checking it, are
  // the load the report's "verification overload" concern is about — the one
  // that concentrates on senior engineers as a team adopts AI. Opening a pull
  // request is creation: it is the point your own work leaves your hands.
  review_requested_of_me: "supervision",
  review_given: "supervision",
  pull_request_opened: "creation",
  context_pressure_high: "risk",
  agent_loop_long: "risk",
  after_hours_ai_session: "risk",
  compile_error: "risk",
  tool_failure: "risk",
  recovery_offline_period: "neutral",
  context_compression_manual: "neutral",
  context_compression_auto: "neutral",
  editor_activity: "neutral",

  // Semantic (agent-observed) — see SEMANTIC_WORK_SIGNAL_EVENT_TYPES.
  approach_churn_detected: "risk",
  goal_drift_detected: "risk",
  progress_stalled: "risk",
  progress_recovered: "neutral",
  session_intention_declared: "neutral",
  scope_change_declared: "neutral"
};

export type IngestResult = "accepted" | "auth_failed" | "consent_missing" | "validation_failed" | "other";

export const ASCENDA_CONSENT_SCOPE: ToolConsentScope = "ide_telemetry";
export const ASCENDA_PROVENANCE = "ai_work_telemetry";

/** The consent scope every event in {@link SEMANTIC_WORK_SIGNAL_EVENT_TYPES} must carry. */
export const ASCENDA_SEMANTIC_CONSENT_SCOPE: ToolConsentScope = "semantic_work_signals";

/**
 * Collaboration events ride `workflow_telemetry`, not `ide_telemetry`: a pull
 * request is not an IDE event, and the two are separately revocable on purpose
 * — someone may be willing to share how they work in their editor and not how
 * they work with their team.
 */
export const ASCENDA_COLLABORATION_CONSENT_SCOPE: ToolConsentScope = "workflow_telemetry";
export const ASCENDA_SEMANTIC_PROVENANCE = "semantic_work_signals";
