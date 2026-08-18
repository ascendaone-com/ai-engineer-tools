# Tool Pairing API Reference (Target Contract)

This is the corrected target-state contract for tool teams to implement against in parallel with backend changes.

It reflects planned behavior for:

- stable pairing status polling
- explicit token renewal
- consent-aware ingest
- canonical telemetry event vocabulary
- route/version alignment

## Route and Versioning

Canonical public base route: `/v1`

No compatibility aliases are provided.

## Lifecycle Summary

1. Tool creates pairing session (anonymous).
2. Authenticated user confirms pairing.
3. Tool polls pairing status until paired.
4. Tool ingests events with event token.
5. Tool renews event token via explicit renew endpoint before/at expiry.
6. On revoke, tool stops ingest and re-pairs.

## Model Shape Spec (Complete Contract)

### Enums and type aliases

```ts
export type PairingSessionStatus = "pending" | "paired" | "expired" | "cancelled";
export type ToolEventSeverity = "low" | "medium" | "high" | "critical";
export type ToolEventPrivacyMode = "metadata_only" | "content_opt_in";

export type ToolConsentScope =
  | "ide_telemetry"
  | "workflow_telemetry"
  | "subjective_checkins"
  | "semantic_work_signals"  // content-derived classification, own opt-in, default off
  | "historical_import";     // retrospective backfill of the past, own opt-in, default off

export type WorkloadCategory =
  | "creation"
  | "verification"
  | "supervision"
  | "risk"
  | "neutral"
  | "unclassified";
```

### Pairing DTOs

```ts
export interface CreateToolPairingSessionRequest {
  toolInstallationId: string;     // required, <= 128
  toolType: string;               // required (see ToolType conventions)
  displayName?: string | null;    // optional
}

export interface CreateToolPairingSessionResponse {
  pairingSessionId: string;       // GUID
  code: string;                   // 6 digits
  deviceCode: string;             // alias of code
  secret: string;                 // opaque secret
  qrUrl: string;                  // deep link
  expiresAt: string;              // ISO8601 UTC, now + 10 min
}

export interface ConfirmToolPairingBySecretRequest {
  secret: string;                 // required
  deviceId: string;               // required
}

export interface ConfirmToolPairingByCodeRequest {
  code: string;                   // required
  deviceId: string;               // required
}

export interface ConfirmToolPairingByDeviceCodeRequest {
  deviceCode: string;             // required
  deviceId: string;               // required
}

export interface ToolPairingStatusResponse {
  status: PairingSessionStatus;
  toolInstallationId: string | null;
  eventWriteToken: string | null; // non-null only on first paired transition
  pairedAt: string | null;        // ISO8601 UTC
}

export interface ConnectedToolDto {
  toolInstallationId: string;
  toolType: string;
  displayName: string | null;
  pairedAt: string | null;
  lastSeenAt: string | null;
}

export interface ConnectedToolsResponse {
  tools: ConnectedToolDto[];
}

export interface RenewToolTokenRequest {
  toolInstallationId: string;     // required
}

export interface RenewToolTokenResponse {
  eventWriteToken: string;
  expiresAt: string;              // ISO8601 UTC
}
```

### Tool telemetry DTOs

```ts
export interface ToolEventRequest {
  toolInstallationId: string;          // required
  source: string;                      // required canonical source (see Source registry)
  eventType: string;                   // required, must be a canonical catalog value
  occurredAt?: string;                 // optional ISO8601 UTC, defaults to now
  severity?: ToolEventSeverity;        // defaults to low
  sessionId?: string | null;
  workspaceHash?: string | null;
  projectHash?: string | null;

  consentScope?: ToolConsentScope | null;
  provenance?: string | null;          // e.g. ai_work_telemetry, app_context
  privacyMode?: ToolEventPrivacyMode;  // top-level preferred

  metadata?: Record<string, unknown> | null;
}

export interface ToolEventBatchRequest {
  events: ToolEventRequest[];          // max configured server-side
}

export interface ToolEventAcceptedResponse {
  status: "accepted" | "duplicate";  // duplicate: already imported, nothing written
}

export interface ToolEventBatchResponse {
  accepted: number;
  duplicate: number;                 // already imported; neither stored nor failed
  rejected: number;
  results: Array<{
    index: number;
    status: "accepted" | "duplicate" | "rejected";
    reason?: string;                 // "already_imported" for duplicates
  }>;
}

export interface ErrorResponse {
  error: string;
  code?: string;
  detail?: string;
}
```

## Telemetry Event Catalog

Backend owns this catalog. Producers MUST emit these canonical `eventType` values exactly.
There are no aliases: alternate spellings are treated as `unclassified`, not remapped.
The same registry is used across ingest, aggregate writing, and telemetry reporting.

### Workload category mapping (canonical vocabulary)

| Canonical eventType | Category |
|---|---|
| create_focus_session | creation |
| ai_prompt_submitted | creation |
| ai_generation_completed | creation |
| ai_file_write | creation |
| ai_file_edit | creation |
| editor_verification_activity | verification |
| compile_diagnostic | verification |
| editor_correction_activity | supervision |
| ai_correction_prompt | supervision |
| supervis_meeting_load | supervision |
| ai_tool_call_started | supervision |
| ai_tool_call_completed | supervision |
| ai_tool_call_failed | supervision |
| context_pressure_high | risk |
| agent_loop_long | risk |
| after_hours_ai_session | risk |
| compile_error | risk |
| tool_failure | risk |
| recovery_offline_period | neutral |
| context_compression_manual | neutral |
| context_compression_auto | neutral |
| editor_activity | neutral |
| approach_churn_detected | risk |
| goal_drift_detected | risk |
| progress_stalled | risk |
| progress_recovered | neutral |
| session_intention_declared | neutral |
| scope_change_declared | neutral |

The last six are **semantic**: agent-observed interaction patterns (repeated
approach churn, drift from a declared goal, a stalled or recovered session, an
intention or scope change the user or agent declared) rather than a single
deterministic host event. They require `consentScope: "semantic_work_signals"`
and `metadata.skillVersion` — see Privacy and Metadata Rules. **As of this
revision the client-side contract package defines these types; backend
ingestion classification (asc-core-be's `WorkloadCategoryMap`) has not yet
been extended to recognise them, so until that lands they accept but classify
as `unclassified`, per the rule below.** That is the expected, tracked state
of an in-progress rollout, not drift to fix.

Unknown `eventType` handling:

- Accepted (not rejected) but tagged as `unclassified`.
- Counted in the `unclassifiedPercent` operational metric so drift is visible.
- Tools should treat a rising unclassified percentage as a contract mismatch to fix.

## Source Registry

Canonical `source` values (emit exactly; no aliases):

- `vscode_extension`
- `cursor_mcp`
- `claude_code`
- `copilot_otel`
- `cli_agent`
- `mcp_server`
- `activity_signals`

Canonical `toolType` values (emit exactly; no aliases):

- `vscode_extension`
- `cursor_mcp`
- `claude_code`
- `copilot_otel`
- `cli_agent`
- `mcp_server`
- `other`

Validation:

- Unknown `toolType` is rejected at pairing with `400`.
- Unknown `source` is accepted but its events classify as `unclassified` (visible in metrics).

## Endpoints

All endpoints are shown as canonical `/v1`.

### 1) Create pairing session

- Method: `POST`
- Path: `/v1/tool-pairing-sessions`
- Auth: none

### 2) Confirm pairing (authenticated user)

- `POST /v1/tool-pairing-sessions/{pairingSessionId}/confirm` (secret)
- `POST /v1/tool-pairing-sessions/confirm-by-code`
- `POST /v1/tool-pairing-sessions/confirm-device-code`

Auth: user bearer auth

### 3) Poll pairing status

- Method: `GET`
- Path: `/v1/tool-pairing-sessions/{pairingSessionId}/status`
- Auth: none

Status semantics:

- Polling status does not rotate token repeatedly.
- On first transition to `paired`, response includes `eventWriteToken`.
- After that, status may return `eventWriteToken: null` while still paired.

Pending response shape is always full:

```json
{
  "status": "pending",
  "toolInstallationId": null,
  "eventWriteToken": null,
  "pairedAt": null
}
```

### 4) Renew event token

- Method: `POST`
- Path: `/v1/connected-tools/{toolInstallationId}/renew-token`
- Auth: user bearer auth

Response:

```json
{
  "eventWriteToken": "eyJ...",
  "expiresAt": "2026-08-02T10:41:44.013Z"
}
```

Rules:

- Token TTL is 30 days.
- Renewal rotates token and revokes previous active token.
- Clients should renew when near expiry or on 401 token failures.

### 4a) Tool-scoped renew event token (unattended tools)

- Method: `POST`
- Path: `/v1/tool-events/renew-token`
- Auth: `Authorization: Bearer <eventWriteToken>`

Response:

```json
{
  "eventWriteToken": "eyJ...",
  "expiresAt": "2026-08-02T10:41:44.013Z"
}
```

### 5) Ingest tool event

- Method: `POST`
- Path: `/v1/tool-events`
- Auth: `Authorization: Bearer <eventWriteToken>`

### 6) Batch ingest tool events

- Method: `POST`
- Path: `/v1/tool-events/batch`
- Auth: `Authorization: Bearer <eventWriteToken>`

### 7) Connected tools

- `GET /v1/connected-tools`
- `DELETE /v1/connected-tools/{toolInstallationId}`

### 8) Operational metrics (admin)

- Method: `GET`
- Path: `/v1/tool-telemetry/metrics`
- Auth: user bearer auth, Admin role required
- Query: `window_start`, `window_end` (ISO8601 UTC; defaults to last 24h)

Returns ingest accepted/rejected-by-reason counts, pairing success/expiry/revoke counts,
aggregate writer row count + lag, unclassified-event percent, and baseline coverage.

## Consent Lease Enforcement

Ingest requires active consent for the resolved scope.

Primary resolution:

1. `consentScope` field (if provided)
2. source-based mapping fallback

Scope mapping:

- `ide_telemetry` -> `AiDataProcessing`
- `workflow_telemetry` -> `DataSharing`
- `subjective_checkins` -> `WeeklyCheckins`
- `semantic_work_signals` -> `SemanticWorkSignals`
- `historical_import` -> `HistoricalImport`

**Provenance overrides the claimed scope for retrospective events.** An event
whose `provenance` is `historical_direct`, `historical_derived` or
`historical_unparsed` requires an active `HistoricalImport` lease whatever
`consentScope` it sends — an unrecognised scope otherwise falls back to
`AiDataProcessing`, which would let a backfill ride in on live-telemetry
consent. Neither lease implies the other, and pairing grants neither.

Source fallback mapping examples:

- `vscode_extension`, `cursor_mcp`, `claude_code`, `copilot_otel`, `cli_agent`, `mcp_server` -> `AiDataProcessing`
- `calendar`, `meeting`, `email`, `slack`, `teams`, `activity_signals` -> `DataSharing`

Persisted audit fields on ingested events:

- `consentScope` (resolved)
- `provenance`
- `ingestionSource`

## Privacy and Metadata Rules

Privacy mode resolution order:

1. `request.privacyMode`
2. `request.metadata.privacyMode`
3. `metadata_only`

Sanitized metadata strips sensitive keys:

- `prompt`, `response`, `sourceCode`, `code`, `fileName`, `filePath`, `branch`, `repository`, `terminalOutput`

Semantic event rules (the six `*_detected`/`*_declared`/`progress_*` types):

- `consentScope` must be `"semantic_work_signals"` — a lease on `ide_telemetry` alone does not cover these.
- `metadata.skillVersion` is required. Planned backend behavior: reject with `validation_failed` if absent (tracked with B4; not yet implemented server-side as of this revision).
- `severity` must be `"low"`. The emitter has no baseline to judge against; any elevated reading comes from the backend's own evaluation, never the payload.
- `metadata.taskFingerprint`, when present, must be a hash — never raw task text.

Retrospective import rules (events with a `historical_*` provenance):

- `provenance` must be `historical_direct`, `historical_derived` or
  `historical_unparsed` — exact match, not a prefix rule. Anything else is
  ordinary telemetry, gated the ordinary way.
- `consentScope` must be `"historical_import"`, and an active `HistoricalImport`
  lease is required regardless of what the field says (see Consent Lease
  Enforcement). Pairing does not grant it.
- `metadata.importKey` is **required**: the stable reference to the source record
  the event was reconstructed from, identical on every re-run over the same
  records. Absent or blank → `validation_failed`; longer than 128 chars →
  `validation_failed` (truncating would break dedup in both directions).
- Ingest dedups on `(pairedUser, toolInstallation, importKey)`. A replay answers
  `duplicate` and writes nothing. It dedups on that key **alone** — not on
  `(extractionId, importKey)`, since an extraction id is fresh per run and would
  make every key unique. A re-run with a new `extractionId` over the same source
  records therefore still dedups.
- `metadata.extractionId` is provenance, not identity. The first run's value stays
  on the stored event; a replay does not restamp it.
- Backdated events never fire moment triggers.
- Non-historical events may also send `importKey` to get idempotent retries; dedup
  keys off the key, the consent gate off the provenance, independently.

## Revocation Behavior

Revocation endpoint:

- `DELETE /v1/connected-tools/{toolInstallationId}`

Effects:

- installation marked revoked
- active event tokens revoked
- subsequent event ingest rejected with `401`

Client behavior:

- clear local token
- stop telemetry sends
- require new pairing flow

Important pairing rule:

- Anonymous create-session does not clear revoked state.
- Revoked state is cleared only after authenticated user confirmation.

## Error Semantics

### Pairing

- `400` invalid/expired code or secret
- `401` unresolved/invalid authenticated user
- `423` confirmation lockout active after repeated failures (`pairing_locked_out`)
- `429` too many confirmation attempts in short window (`pairing_rate_limited`)

### Tool ingest

- `400` malformed payload
- `401` missing/invalid/revoked token
- `403` `consent_missing_or_expired`
- `422` validation failure (when strict schema mode enabled)

Example:

```json
{ "error": "consent_missing_or_expired" }
```

## ToolInstallationId and ToolType Conventions

`toolInstallationId`:

- stable per installation
- max 128 chars
- recommended format: `<toolType>:<uuid>`
- examples:
  - `vscode_extension:3b53f1dc-13ee-45b4-9f5f-845f4abf829f`
  - `cursor_mcp:6a2eab0e-0df6-4c90-bf2b-f8a47eaa7a0e`

`toolType` allowed values:

- `vscode_extension`
- `cursor_mcp`
- `claude_code`
- `copilot_otel`
- `cli_agent`
- `mcp_server`
- `other`

## Recommended Client Flow

```mermaid
sequenceDiagram
    participant T as Tool Client
    participant A as Ascenda API
    participant U as User App (Authenticated)

    T->>A: POST /v1/tool-pairing-sessions
    A-->>T: pairingSessionId, code/deviceCode, secret

    U->>A: POST /v1/tool-pairing-sessions/confirm-device-code
    A-->>U: status=paired

    loop Poll every 2-5s until paired
      T->>A: GET /v1/tool-pairing-sessions/{id}/status
      A-->>T: pending OR paired (+ initial eventWriteToken)
    end

    T->>A: POST /v1/tool-events (Bearer eventWriteToken)
    A-->>T: accepted OR 401/403

    alt token near expiry or 401 token failure
      T->>A: POST /v1/tool-events/renew-token (Bearer eventWriteToken)
      A-->>T: fresh eventWriteToken + expiresAt
      Note over T: Persist token; re-pair only if renew returns 401
    end

    alt user revokes tool
      U->>A: DELETE /v1/connected-tools/{toolInstallationId}
      A-->>T: subsequent ingest = 401
      Note over T: Renew fails; clear token and require full re-pair
    end
```

User-JWT renew (`POST /v1/connected-tools/{toolInstallationId}/renew-token`) is for the authenticated app only. Unattended tools must use tool-scoped renew (`POST /v1/tool-events/renew-token`).

## Integration Checklist

1. Use `/v1` routes only.
2. Persist `toolInstallationId`, `toolType`, and `pairingSessionId`.
3. Use `confirm-device-code` for modern clients.
4. Treat status polling as state check, not continuous token refresh.
5. Renew token via tool-scoped `POST /v1/tool-events/renew-token` (Bearer eventWriteToken).
6. Send explicit `consentScope` and `provenance`.
7. Use canonical event catalog values exactly (no aliases; unknown types classify as `unclassified`).
8. Send top-level `privacyMode`; avoid raw code/prompt payloads.
9. Handle `403 consent_missing_or_expired` by prompting consent renewal.
10. Handle `401` by tool-scoped renew first, then full re-pair if renew fails.

## Pairing Abuse Controls

Confirmation endpoints protected by abuse controls:

- `POST /v1/tool-pairing-sessions/{pairingSessionId}/confirm`
- `POST /v1/tool-pairing-sessions/confirm-by-code`
- `POST /v1/tool-pairing-sessions/confirm-device-code`

Policy:

- Rate limit: max 12 confirmation attempts per user per minute.
- Lockout: 5 failed confirmation attempts in a 15-minute window triggers lockout.
- Lockout and rate-limit responses include `retryAfterSeconds`.

Responses:

```json
{ "error": "pairing_rate_limited", "retryAfterSeconds": 60 }
```

```json
{ "error": "pairing_locked_out", "retryAfterSeconds": 900 }
```

## AIWorkloadAggregates Writer Pipeline

`AIWorkloadAggregates` is written by a server-side background pipeline, not directly by tool clients.

Pipeline components:

- `IAIWorkloadAggregateWriter` computes weekly user aggregates from `ToolTelemetryEvents`.
- `AIWorkloadAggregateBackgroundService` runs the writer every 15 minutes.
- `TelemetrySourceService` uses the same shared event catalog for reporting telemetry breakdowns.

Reporting source of truth:

- Telemetry breakdowns in reporting are aggregate-first and read from `AIWorkloadAggregates`.
- Legacy raw-event substring collation is retired.

Server-side rollup and baseline fusion:

- Backend derives workload rollups from raw events (`taskSwitchCount`, `interruptionCount`, `aiPromptCount`, `deepWorkMinutes`, `compileErrorCount`).
- Backend computes personal telemetry baseline deltas using a rolling 28-day lookback.
- Baseline deltas and rollups are fused with subjective metrics during normalization; tools only send discrete events and optional metadata.

Persisted baselines:

- `TelemetryUserBaseline` stores per-user rolling norms (AI prompt/day, task switch/day, after-hours %, deep-work minutes/day, compile-error/day).
- `TelemetryBaselineBackgroundService` recomputes baselines every 6 hours over a 28-day window.
- Reporting prefers persisted baselines and falls back to ad-hoc computation when none exist.

First-class audit columns:

- `ToolTelemetryEvents` persists `ConsentScope`, `Provenance`, `IngestionSource`, `RawEventType`, `CanonicalEventType`, and `WorkloadCategory` as dedicated columns (not only metadata) for query, compliance auditing, and retention.

Aggregation window and keying:

- Rolling lookback: 12 weeks (84 days).
- Grouping key: `AnonymousUserId + PeriodStart + PeriodEnd` (weekly buckets, UTC week start Monday).

Current derived fields:

- category scores and percentages (`creation`, `verification`, `supervision`)
- stress/risk counters (`ContextCompressionCount`, `ContextPressureHighCount`, `AgentLoopLongCount`, `ToolFailureCount`)
- `AfterHoursSessionCount` (distinct sessions outside 08:00-18:00 UTC)

Policy alignment:

- After-hours logic is standardized at UTC `<08:00` or `>=18:00` for aggregate writing and telemetry reporting.
