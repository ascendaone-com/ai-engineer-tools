# Claude Code to Ascenda Mapping

Aligned to [TOOL_PAIRING_API_REFERENCE.md](../../api-docs/TOOL_PAIRING_API_REFERENCE.md) canonical event catalog.

This adapter is the **primary Phase 1 source for `AIInteractionLoad`** and workflow friction signals in the tooling repo.

## Event mapping (catalog only)

| Claude hook | Ascenda event | Workload category |
| --- | --- | --- |
| SessionStart (startup/resume) | `create_focus_session` | creation |
| SessionStart (clear/compact) | *(skipped — a context reset, not a new session)* | — |
| UserPromptSubmit | `ai_prompt_submitted` | creation |
| UserPromptSubmit (correction inferred) | `ai_correction_prompt` | supervision |
| PreToolUse | `ai_tool_call_started` | supervision |
| PostToolUse Write | `ai_file_write` | creation |
| PostToolUse Edit/MultiEdit | `ai_file_edit` | creation |
| PostToolUse Bash test/lint/build | `editor_verification_activity` (`outcome: success`) | verification |
| **PostToolUseFailure** Bash test/lint/build | `compile_error` | risk |
| **PostToolUseFailure** (other tools) | `ai_tool_call_failed` | supervision |
| PostToolUse/Failure interrupted | `ai_tool_call_failed` (`outcome: cancelled`, `reason: manual_interrupt`) | supervision |
| PreCompact manual | `context_compression_manual` | neutral |
| PreCompact auto | `context_compression_auto` | neutral |
| PostCompact | `context_pressure_high` | risk |
| Stop (long duration only) | `agent_loop_long` | risk |
| Notification | *(skipped — no catalog event)* | — |

## Outcome comes from the event, not the payload

Verified against a live Claude Code session (27 Jul 2026), replacing what had
been inferred — and the inference was wrong in a way that silently disabled a
shipped feature:

| | Hook event | Payload carries | Exit code? |
| --- | --- | --- | --- |
| Success | `PostToolUse` | `tool_response` (`stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`), top-level `duration_ms` | **No** |
| Failure | `PostToolUseFailure` | `error` (a string beginning `"Exit code N\n…"`), `is_interrupt`, `duration_ms`; **no `tool_response`** | Only inside the `error` string |

Consequences that shape the adapter (`outcomeForHook` in `@ascenda-one/tool-kit`):

- **The arrival of `PostToolUse` is the success signal** — a failed call never
  reaches it. Nothing needs parsing to know the call succeeded.
- **Registering only `PostToolUse` makes failures invisible entirely**, and
  leaves every outcome `unknown` — which suppresses `compile_error`,
  `ai_tool_call_failed`, and the `outcome: "success"` marker the backend's
  verification and commit boundaries key on. `PostToolUseFailure` is not
  optional.
- **`stderr` is not failure** — successful calls routinely carry it (shell
  notices, tool progress).
- **`is_interrupt` is `cancelled`, not `failure`** — stopped work is not wrong
  work, so an interrupted test run is never a `compile_error`, and `gitAction`
  / milestone facts are only read off `outcome: "success"`.
- Field naming is snake_case throughout: `tool_name`, `tool_input`,
  `tool_response`, `duration_ms`, `is_interrupt`.

Also present in captured payloads and not yet used: `permission_mode` (a
supervision-posture signal), and an Edit's `tool_response.userModified` /
`structuredPatch` (whether the human corrected the agent's output, and real
line counts).

## Acceptance-boundary metadata (`linesChangedBucket`)

`PostToolUse` for `Write`/`Edit`/`MultiEdit` now computes a lines-changed count from `tool_input` (`content` for Write; `old_string`/`new_string` for Edit; summed across `edits` for MultiEdit), buckets it with `bucketLinesChanged` (`@ascenda-one/tool-kit`), and attaches it as `metadata.linesChangedBucket` on the existing `ai_file_write`/`ai_file_edit` event — no new event type. The edited text itself is read only to count lines and is discarded immediately; only the bucket (`"0"` | `"1-10"` | `"10-50"` | `"50-200"` | `"200+"`) ever reaches the wire.

At `"200+"` this is the "substantial accepted change" boundary the Ascenda app's confidence self-report triggers on — the bucket *is* the boundary marker; there's nothing further to emit, since the write already happened.

## SessionStart context injection

Separately from telemetry, `SessionStart` (on `startup`/`resume` only — `clear`/`compact` are mid-session resets, not new sessions) writes a `hookSpecificOutput.additionalContext` JSON payload to **stdout**, inviting the agent to ask what the session should accomplish. This is the only hook in this package that writes anything to stdout; every other hook stays silent.

- Independent of pairing state: the injection happens before config loading, so a broken pairing or no network never suppresses it.
- Opt out with `ASCENDA_DISABLE_INTENTION_INVITE=true`.
- Feeds `session_intention_declared` — but not from here. This hook only asks the question; the semantic event (if the user answers) is the [`ascenda-agent-skills`](../../ascenda-agent-skills/) skill's job, since only the model that saw the answer can judge whether one was actually given. See that package's `docs/EMISSION_CRITERIA.md`.

## Ingest contract

```http
POST /v1/tool-events
Authorization: Bearer <eventWriteToken>
```

Payload fields:

- `consentScope: "ide_telemetry"`
- `provenance: "ai_work_telemetry"`
- `privacyMode: "metadata_only"`
- `source: "claude_code"`

Token renewal (unattended):

```http
POST /v1/tool-events/renew-token
Authorization: Bearer <eventWriteToken>
```

Renewed tokens are persisted under `~/.ascenda/tokens/<toolInstallationId>` (or `ASCENDA_EVENT_WRITE_TOKEN_FILE`).

## Privacy

Metadata-only. Raw prompts are used locally for correction inference only; outbound events carry `reason` and `trigger`, not prompt text.
