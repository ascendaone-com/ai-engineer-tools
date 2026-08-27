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
/**
 * `historical_import` is its own scope for the same reason, one step further out.
 * Every other scope here is prospective — from now on, as you work, this tool
 * reports what it sees. A retrospective import is a different act on a different
 * corpus: months of past sessions the person already lived, written before they
 * had heard of us, in stores they may have assumed nobody would ever read.
 * Agreeing that a tool may watch you going forward is not agreeing it may go
 * back. Default off, and the backend enforces it on the event's *provenance*
 * (`historical_direct` / `historical_derived` / `historical_unparsed`), not on
 * this string — a client that keeps sending `ide_telemetry` over backdated
 * events is rejected regardless of what it claims.
 */
export type ToolConsentScope = "ide_telemetry" | "workflow_telemetry" | "subjective_checkins" | "semantic_work_signals" | "historical_import";

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

/**
 * A piece of work reaching its own end — a ticket closing, a PR merging —
 * as distinct from the keystroke-scale boundaries `GitAction` records.
 *
 * The distinction is the point. Commits and pushes happen many times inside
 * one piece of work; a milestone happens when the work itself is done, which
 * is the rhythm a review should follow (Hamada's §5.3 note on the Dark Flow
 * report: *"a review at the end of a 'ticket' or 'project' so the app becomes
 * part of their iterative self improvement as their work rolls on from task to
 * task"*). A calendar review asks at a time that suits the app; a milestone
 * review asks at a moment that already means something to the person.
 *
 * Deliberately narrow. `git merge` is **not** classified: `git merge
 * origin/main` is a sync and `git merge feature-x` is an integration, and the
 * command string cannot reliably tell them apart — a classifier that guessed
 * would fire a debrief invitation every time somebody pulled upstream, which
 * is exactly the nag this is trying not to be.
 */
export type WorkMilestoneKind = "pr_merged" | "pr_opened" | "issue_closed";
export type PromptClass = "creation" | "verification" | "correction" | "debugging" | "planning" | "unknown";

/**
 * The permission posture the runtime reported when an event happened —
 * **upstream's own word, snake-cased, and nothing else**.
 *
 * **This vocabulary mirrors the runtime's; it is deliberately not ours.**
 * Claude Code's `permission_mode` has six documented values (`default`,
 * `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, checked 28
 * Aug 2026). Each takes exactly one token here, and the only transformation
 * applied is snake-casing — so the wire vocabulary is auditable against
 * Anthropic's published reference with no translation table in between, and
 * nobody has to defend a word upstream does not use.
 *
 * Codex, checked the same day against its generated wire schemas, sends the
 * same field with five of those six values (no `auto`) — so mirroring means
 * both collectors land on the same tokens without either being translated to
 * the other. That is worth more than a shared invented vocabulary would be:
 * where the two runtimes agree, the wire shows it as agreement, and where they
 * diverge, the wire shows that too instead of hiding it inside a rung.
 * Near-identical today, and nothing guarantees they stay in step. The VS Code
 * extension has no equivalent at all and omits the key; its events are a
 * person's saves and terminal commands, not agent actions under an approval
 * posture.
 *
 * **Granular at capture, coarse at read — never the reverse.** An earlier
 * draft of this type was a five-rung posture ladder
 * (`planning`/`supervised`/`edits_auto`/`delegated`/`unsupervised`) that
 * collapsed `auto` and `dontAsk` into one token. That coarsening is not
 * injective, and this corpus is effectively immutable — `ToolTelemetryEvents`
 * has no retention window and no erasure pathway, and imported rows are never
 * rewritten — so collapsing at capture is indistinguishable from discarding,
 * and it is the one decision here that cannot be revisited. A reader can
 * always coarsen; no reader can un-collapse. The ladder survives as
 * `autonomyBand` in `@ascenda-one/tool-kit`, derived from the stored token at
 * read time, where changing our mind costs a query rewrite rather than a lost
 * year.
 *
 * The values, most supervised first:
 *
 * - `plan`               — nothing executes; the human is deciding before
 *                          work starts.
 * - `default`            — every action is approved one at a time. This is
 *                          the mode the UI labels *Manual*; it never arrives
 *                          on the wire as `"manual"`, and a mapping written
 *                          from the UI's vocabulary would miss the single
 *                          most common posture entirely.
 * - `accept_edits`       — file edits apply without asking; commands still
 *                          ask (upstream `acceptEdits`).
 * - `auto`               — actions proceed without per-action approval, with
 *                          the permission rules still applying.
 * - `dont_ask`           — as `auto`, reached by the user declining to be
 *                          asked again (upstream `dontAsk`). Whether these
 *                          two are one posture or two is a *reader's*
 *                          question, and it stays answerable because both
 *                          tokens are on the wire.
 * - `bypass_permissions` — permission checks bypassed entirely (upstream
 *                          `bypassPermissions`).
 * - `unknown`            — a value the collector did not recognise.
 *
 * **Every mapping onto this type must be a total function**: an unrecognised
 * runtime value becomes `unknown` and is still sent, because "a posture we
 * have not seen before" is a fact worth having and a dropped field is not.
 * Note what that buys `default`: since the fallback is `unknown`, `default`
 * cannot appear on the wire unless upstream actually sent it, so a reader can
 * never mistake a recorded posture for a fallback that ran. That is the whole
 * reason the token is safe to mirror.
 *
 * Absence is not `unknown`: a collector that cannot see a posture at all omits
 * the key, so "this runtime has no such concept" stays distinguishable from
 * "this runtime grew a mode we have not mapped yet".
 *
 * `auto` also appears in `trigger`, with a different meaning (*what initiated
 * this event*). Accepted, not accidental: the keys are namespaced, meaning is
 * per key, and the alternative was inventing a word upstream does not use. It
 * is a trap only for a query that reads values rather than pairs, and it is
 * named here rather than discovered in a dashboard.
 *
 * Live-only by nature. Transcripts do not reliably record permission state, so
 * unlike model mix or token counts this cannot be recovered by a later import
 * — every day it is uncaptured is a day that is simply gone.
 */
export type AutonomyMode =
  | "default"
  | "plan"
  | "accept_edits"
  | "auto"
  | "dont_ask"
  | "bypass_permissions"
  | "unknown";

/**
 * Which model did the work, at vendor:tier grain and never as a raw id.
 *
 * Coarse on purpose. A raw model string (`claude-opus-5`,
 * `claude-haiku-4-5-20251001`, `us.anthropic.claude-…-v1:0`) carries a dated
 * build and a deployment surface, changes on Anthropic's release cadence
 * rather than ours, and would make every norm table re-bucket itself on a
 * point release. The tier is the part that predicts behaviour, and it is the
 * part a norm table needs: pooling an autocomplete user with an agent-fleet
 * user is wrong for both, and 10.6 tool-calls-per-prompt is a model-dependent
 * number being reported as a universal one.
 *
 * Coarse, but never coarser than the string allowed. The raw identifier
 * travels beside this on {@link AscendaEventMetadata.modelId}, so the
 * coarsening is recoverable rather than destructive — a class is a reading
 * convenience, not the record.
 *
 * As with {@link AutonomyMode}, the mapping must be total — an unrecognised
 * identifier becomes an `unknown` rather than vanishing, so a new tier shows
 * up as a visible bump instead of a quiet hole in the mix.
 *
 * **Partial recognition degrades to the vendor, not to nothing.** An
 * Anthropic model whose tier we have not mapped is `anthropic:unknown`, never
 * bare `unknown`. Bare `unknown` is reserved for a string whose *vendor* could
 * not be read either — `<synthetic>`, a number from an unityped store, a
 * genuine surprise. The classifier therefore reads vendor and tier as two
 * separate steps: coarsening `anthropic:unknown` to `unknown` later is free,
 * and inventing the vendor back is impossible. Tiers churn on a release
 * cadence; vendors persist, and vendor-mix-over-time is the reading this field
 * exists to serve.
 *
 * Claude-Code-first, not uniform. `SessionStart` is the only live hook that
 * can carry a model at all, and even there the docs do not guarantee it (it is
 * omitted after `/clear` and on conversation recovery). The VS Code extension
 * knows no model whatsoever. Codex is the correction to an earlier claim here:
 * its hook payloads carry an active model slug on *every* event, but that
 * adapter does not read it yet, so its rows carry no `modelClass` either. So
 * absence is the normal case everywhere else, and no surface may treat a
 * missing `modelClass` as an anomaly.
 */
export type ModelClass =
  | "anthropic:opus"
  | "anthropic:sonnet"
  | "anthropic:haiku"
  | "anthropic:fable"
  | "anthropic:unknown"
  | "openai:gpt"
  | "openai:unknown"
  | "google:gemini"
  | "google:unknown"
  | "local:on_device"
  | "local:unknown"
  | "unknown";

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

  /** Set on a bash event whose command completed a piece of work (H1). */
  milestoneKind?: WorkMilestoneKind;

  /**
   * The permission posture in force when this event happened, in upstream's
   * own vocabulary. Per event, not per session, because it is: the mode is
   * switched mid-session, and a session summarised by one posture would
   * average away the very transition this exists to see — approving every
   * step and reviewing after the fact are different qualities of demand, and
   * until now the record could not tell them apart at all.
   *
   * Sent on every event whose payload carries a posture. Omitted — never
   * `unknown` — where the runtime does not report one, so a collector without
   * the concept stays distinguishable from a value we failed to map. See
   * {@link AutonomyMode} for why an unmapped value must still be sent, and for
   * why no posture *band* is ever computed here rather than in a reader.
   */
  autonomyMode?: AutonomyMode;

  /**
   * Which model was in use, at vendor:tier grain. Session-grain in practice:
   * only `create_focus_session` carries it, because `SessionStart` is the only
   * live hook that can see a model — and even there it is optional, so the
   * absent case is normal rather than an error.
   *
   * Without it, every per-person norm derived from live events pools models
   * that behave nothing alike and is wrong for each of them. The imported
   * corpus has carried the raw `primaryModel` since the first extractor; the
   * live stream, which costs roughly twenty times the storage, has carried
   * nothing. See {@link ModelClass}.
   *
   * Never sent alone. {@link AscendaEventMetadata.modelId} carries the raw
   * string it was derived from on the same row, so the class can always be
   * re-derived if the vocabulary changes.
   */
  modelClass?: ModelClass;

  /**
   * The raw model identifier exactly as the payload reported it, trimmed and
   * not otherwise altered — `claude-opus-5`, `claude-haiku-4-5-20251001`,
   * `us.anthropic.claude-…-v1:0`, `<synthetic>`.
   *
   * Sent beside {@link AscendaEventMetadata.modelClass}, never instead of it,
   * and for the reason the class alone was not enough: a class is a lossy
   * derivation, and this corpus is append-only. When a vendor ships a tier we
   * have not mapped, a row holding only `anthropic:unknown` has lost which
   * model actually ran, permanently. Holding the slug makes the coarsening
   * injective in practice — the reading can be recomputed, so it can be
   * revised.
   *
   * **Not the same measurement as the importer's `primaryModel`, and
   * deliberately not the same key.** `primaryModel` is the *dominant* model
   * across a whole imported session, folded out of a transcript after the
   * fact. This is the model at *session open* — read off `SessionStart`, the
   * only live hook that can see one — and a mid-session model switch is
   * invisible to it. Two derivations under one key would fuse two different
   * things into one column, the same error as fusing provenances into one
   * rollup row, and no reader downstream could tell which it had.
   *
   * Session-grain, so the cost is one field per session rather than per
   * event. Omitted when the payload reported no model at all.
   */
  modelId?: string;

  /**
   * Whether the human had edited the file since the agent last wrote it, as
   * reported by an Edit-family `tool_response.userModified`. The one live
   * signal of *correction* rather than production: everything else on a file
   * event counts what the agent did, and none of it says whether a person then
   * had to go and fix it.
   *
   * Rides the existing `ai_file_edit` / `ai_file_write` events on purpose. A
   * correction is not a different kind of thing happening — it is a fact about
   * the write that just happened, the same reasoning that keeps `gitAction`
   * and `milestoneKind` off event types of their own.
   *
   * `false` is sent, not suppressed: without the negatives there is a
   * numerator and no denominator, and no rate can be computed. Absence still
   * means the payload said nothing.
   *
   * **Read the corpus before trusting a zero.** The import side records this
   * as `userModifiedEditCount` and had to document that Claude Code never sets
   * it true in transcripts, so a 0 there would have asserted "no AI edit was
   * ever corrected by hand" when it only meant the store never says so. If the
   * live field turns out to be inert in the same way, an all-`false` corpus is
   * evidence about the field, not about the work.
   */
  userModified?: boolean;
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

  /**
   * Required whenever `provenance` is one of the historical classes. The stable
   * reference to the source record this event was reconstructed from — identical
   * on every re-run of the importer over the same records, and therefore the key
   * backend ingestion dedups on. Without it a second import run is
   * indistinguishable from a second span of work, and doubles the person's whole
   * historical baseline; ingestion rejects a historical event that omits it.
   *
   * Deliberately not `extractionId`, and not a composite with it: an extraction
   * id is minted per run, so a key including it would be unique on every run and
   * would dedup exactly nothing.
   */
  importKey?: string;

  /** Which import run produced this event. Provenance, never identity — see {@link importKey}. */
  extractionId?: string;

  /** Version of the normalized historical event shape the importer emitted. */
  importSchema?: number;
};

export type AscendaEventPayload = {
  toolInstallationId: string;
  source: AscendaTelemetrySource;
  eventType: AscendaTelemetryEventType;
  occurredAt: string;
  /**
   * Minutes the emitter's local clock is AHEAD of UTC at `occurredAt`
   * (Brisbane = 600, Los Angeles = -420). Optional only so an older
   * collector's payload still validates; every collector in this repo sends
   * it.
   *
   * It exists because `occurredAt` is UTC and carries no offset, so a
   * consumer had no way to recover the person's own clock — and the backend
   * was reading UTC hours as if they were local. On the reference machine
   * (UTC+10) that flagged the working day as after-hours and missed the
   * actual evenings: 83% of prompts marked after-hours against a true 15%,
   * the two rules agreeing on 14% of 22,535 prompts.
   *
   * An offset rather than an IANA zone, deliberately. It answers every
   * question a consumer actually has — after-hours, which local day, which
   * local week — while naming only a rough longitude band, where
   * "Australia/Brisbane" narrows a person considerably. Sending less that
   * still answers the question is the cheaper privacy position.
   *
   * Per event, not per install: an offset is a property of an instant, so a
   * DST boundary inside a backfill is captured rather than flattened.
   */
  utcOffsetMinutes?: number | null;
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

/**
 * `transport_error` covers everything that stopped the event reaching a verdict
 * — DNS failure, connection reset, timeout, and every HTTP status the ingest
 * door does not spell out (429, 5xx, a proxy's 502). It exists because the
 * alternative was a thrown `AscendaApiError`, and on the hook path a throw is
 * indistinguishable from silence: it unwound to a top-level catch that wrote to
 * a stderr the host discards. A named outcome can be recorded, retried and
 * reported; an exception could only be swallowed.
 */
export type IngestResult = "accepted" | "auth_failed" | "consent_missing" | "validation_failed" | "transport_error" | "other";

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

/**
 * The consent scope every retrospectively imported event must carry — see
 * `@ascenda-one/history-import`, which is the only thing that emits them.
 */
export const ASCENDA_HISTORICAL_CONSENT_SCOPE: ToolConsentScope = "historical_import";
export const ASCENDA_SEMANTIC_PROVENANCE = "semantic_work_signals";

// The metric-key vocabulary — the `metrics{}` counterpart to
// EVENT_WORKLOAD_CATEGORY above. See ./metricKeys.ts.
export {
  METRIC_KEYS,
  backendMetricKeys,
  type MetricKey,
  type MetricKeySpec,
  type MetricReader,
  type MetricValue
} from "./metricKeys";
