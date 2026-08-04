# Cursor Adapter Plan

Aligned to Workload Telemetry Research Direction and Tooling Phase Alignment
(referenced throughout this repo's READMEs; not yet written up as standalone
docs in this `docs/` directory).

Moved here from `ascenda-cursor-extension/docs/` when the Cursor-specific
extension package was retired in favour of one editor extension
(`ascenda-vscode-extension-telemetry`, published as `ascenda-one.ascenda`)
that covers both VS Code and Cursor via runtime host detection
(`packages/ide-extension-core/src/host.ts`). This plan is about Phase
2/3 work that is agent-level, not editor-level, so it is not tied to
either extension package.

## Phase 1: Cursor-compatible extension (current)

Baseline IDE telemetry — same as the VS Code extension, with
`source: cursor_mcp` / `toolType: cursor_mcp` detected at runtime.

Provides:

- loose pairing to Ascenda app
- eventWriteToken storage
- editor telemetry (focus / task-switch proxy)
- terminal command classification (verification load)
- after-hours signals (recovery risk)
- manual simulation commands for backend testing

**Workload inputs served:** `FocusDuration` (partial), `TaskSwitchRate` (partial), verification/friction via terminal events.

## Phase 2: Cursor plugin/hooks/MCP adapter

Capture **AI interaction load** — the highest-value signal for AI engineers per the research direction.

| Cursor / agent signal | Ascenda event | Workload category |
| --- | --- | --- |
| Agent prompt submitted | `ai_prompt_submitted` | Supervision / AI load |
| Agent starts work | `agent_loop_started` | Supervision |
| Agent completes work | `agent_loop_completed` | Completion |
| Agent loop exceeds threshold | `agent_loop_long` | Supervision / overload |
| Agent file edit applied | `ai_file_edit` | Creation |
| Agent file created | `ai_file_write` | Creation |
| User rejects/undoes agent output | `ai_output_rejected` | Supervision |
| Repeated correction prompts | `ai_correction_prompt` | Supervision / friction |
| Agent test/lint/build command | `ai_test_or_build_run` | Verification |
| Agent command/tool failure | `ai_tool_call_failed` | Friction |
| Context reset/pressure signal | `context_pressure_high` | Supervision / risk |
| Context compression signal | `context_compression_manual` or `context_compression_auto` | Supervision / risk |

**Workload inputs served:** `AIInteractionLoad`, workflow friction signals, verification load.

Do not create a Cursor-specific telemetry model. Cursor must emit into the shared Ascenda model. Prefer the same event types as Claude Code hooks (`ascenda-claude-code-hooks/`).

This is superseded, for the semantic-signal case, by
[`ascenda-agent-mcp`](../ascenda-agent-mcp/)'s `ascenda_emit_work_signal` tool —
see that package's README. The generic `ascenda_emit_workload_event` emitter
sketched below is a separate, still-open concern; it has not been built.

### Proposed MCP tools (scaffold, not implemented)

Originally sketched in `ascenda-cursor-extension/mcp-adapter/README.md`,
retained here for reference:

**`ascenda_emit_workload_event`** — generic event emitter.

```json
{
  "eventType": "agent_loop_long",
  "severity": "medium",
  "metadata": {
    "durationBucket": "30-60m",
    "reason": "long_session",
    "privacyMode": "metadata_only"
  }
}
```

**`ascenda_emit_context_pressure`** — maps to `context_pressure_high` with source `cursor_mcp`.

**`ascenda_emit_verification_activity`** — maps to `ai_test_or_build_run` with source `cursor_mcp`.

Authentication: the MCP server should not hold a user identity — either the
same `toolInstallationId` and `eventWriteToken` obtained through pairing, or
a child token created by the extension for the local MCP process. Privacy:
metadata-only by default; never prompts, responses, code, file names,
repository names, or terminal output.

## Phase 3: Personalised workload integration

Backend delivers per-user baselines and `baselineDeltaPercent`. Extension may surface:

- elevated / strained / high-risk band from personalised score
- consent renewal prompts on `403 consent_missing_or_expired`

Fixed population thresholds (e.g. HRV < 50) are explicitly out of scope.

## Metadata targets for backend rollup

Per-event metadata today; session aggregates are a backend concern. Target rollup keys from the research direction:

```json
{
  "aiPromptCount": 18,
  "aiAcceptedCount": 11,
  "compileErrorCount": 3,
  "deepWorkMinutes": 52,
  "taskSwitchCount": 7,
  "interruptionCount": 4
}
```

MCP adapter should emit discrete events; backend aggregates into workload function inputs.
