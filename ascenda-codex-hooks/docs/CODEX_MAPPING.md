# Codex to Ascenda Mapping

Aligned to [TOOL_PAIRING_API_REFERENCE.md](../../api-docs/TOOL_PAIRING_API_REFERENCE.md) canonical event catalog and the [Codex hooks reference](https://developers.openai.com/codex/hooks).

Codex rides the canonical `cli_agent` toolType/source (the registry has no codex-specific value yet); every event carries `metadata.host: "codex"` so the backend can disaggregate later without a contract change.

## Event mapping (catalog only)

| Codex hook | Ascenda event | Workload category |
| --- | --- | --- |
| SessionStart (startup/resume) | `create_focus_session` | creation |
| SessionStart (clear/compact) | *(skipped — not a new working session)* | — |
| UserPromptSubmit | `ai_prompt_submitted` | creation |
| UserPromptSubmit (correction inferred) | `ai_correction_prompt` | supervision |
| PreToolUse | `ai_tool_call_started` | supervision |
| PostToolUse apply_patch | `ai_file_edit` | creation |
| PostToolUse shell test/lint/build (ok) | `editor_verification_activity` | verification |
| PostToolUse shell test/lint/build (fail) | `compile_error` | risk |
| PostToolUse failure | `ai_tool_call_failed` | supervision |
| PostToolUse (other, ok) | `ai_tool_call_completed` | supervision |
| PreCompact manual | `context_compression_manual` | neutral |
| PreCompact auto | `context_compression_auto` | neutral |
| PostCompact | `context_pressure_high` | risk |
| Stop (turn ≥ 30 min) | `agent_loop_long` | risk |
| Stop (shorter) | *(skipped)* | — |
| PermissionRequest | *(skipped — no catalog event)* | — |
| SubagentStart / SubagentStop | *(skipped — no catalog event)* | — |

## Turn duration

Codex's `Stop` payload carries no duration, so the adapter measures it:
`UserPromptSubmit` records a per-session timestamp under `~/.ascenda/state/`
(override with `ASCENDA_STATE_DIR`), and `Stop` consumes it. Any state failure
degrades to "no duration" — never to a hook error.

## Hook safety contract

Codex treats **exit code 2 as blocking** the user's action and awaits command
hooks synchronously. This adapter therefore:

- always exits `0` — consent/auth problems surface as a one-line
  `systemMessage`, other failures go to stderr, and the agent proceeds;
- caps every HTTP call at 3 s (`ASCENDA_HTTP_TIMEOUT_MS` to change) so a slow
  backend cannot stall a turn.

## Ingest contract

Same as all producers: `POST /v1/tool-events` with Bearer eventWriteToken,
`consentScope: "ide_telemetry"`, `provenance: "ai_work_telemetry"`,
`privacyMode: "metadata_only"`, `source: "cli_agent"`. Tool-scoped renew
persists rotated tokens under `~/.ascenda/tokens/<toolInstallationId>`.

## Privacy

Metadata-only. Prompt text is used locally for correction inference only;
outbound events carry the classification, never the text. Commands reduce to
a class (test/lint/build/…) plus outcome; no file paths, code, or output.
