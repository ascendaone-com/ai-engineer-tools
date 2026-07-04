# Claude Code to Ascenda Mapping

Aligned to [TOOL_PAIRING_API_REFERENCE.md](../../api-docs/TOOL_PAIRING_API_REFERENCE.md) canonical event catalog.

This adapter is the **primary Phase 1 source for `AIInteractionLoad`** and workflow friction signals in the tooling repo.

## Event mapping (catalog only)

| Claude hook | Ascenda event | Workload category |
| --- | --- | --- |
| UserPromptSubmit | `ai_prompt_submitted` | creation |
| UserPromptSubmit (correction inferred) | `ai_correction_prompt` | supervision |
| PreToolUse | `ai_tool_call_started` | supervision |
| PostToolUse Write | `ai_file_write` | creation |
| PostToolUse Edit/MultiEdit | `ai_file_edit` | creation |
| PostToolUse Bash test/lint/build (ok) | `editor_verification_activity` | verification |
| PostToolUse Bash test/lint/build (fail) | `compile_error` | risk |
| PostToolUse failure | `ai_tool_call_failed` | supervision |
| PreCompact manual | `context_compression_manual` | neutral |
| PreCompact auto | `context_compression_auto` | neutral |
| PostCompact | `context_pressure_high` | risk |
| Stop (long duration only) | `agent_loop_long` | risk |
| Notification | *(skipped — no catalog event)* | — |

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
