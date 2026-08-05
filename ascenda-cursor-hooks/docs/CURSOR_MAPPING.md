# Cursor hook → Ascenda event mapping

Source: [cursor.com/docs/agent/hooks](https://cursor.com/docs/agent/hooks).
Catalog: [tool-contract](../../packages/tool-contract/src/index.ts).

Every event carries `metadata.host = "cursor"` and rides `source: "cli_agent"` —
the Cursor *extension* already owns `cursor_mcp`, and the backend registry has
no cursor-agent value yet.

| Cursor hook | Condition | Ascenda event | Severity |
| --- | --- | --- | --- |
| `sessionStart` | | `create_focus_session` | low |
| `sessionEnd` | | `recovery_offline_period` | low |
| `beforeSubmitPrompt` | always | `ai_prompt_submitted` | low |
| `beforeSubmitPrompt` | prompt looks like a correction | `+ ai_correction_prompt` | medium |
| `preToolUse` | | `ai_tool_call_started` | low |
| `postToolUse` | shell + test/lint/typecheck/build, exit 0 | `editor_verification_activity` | low |
| `postToolUse` | shell + verification, exit ≠ 0 | `compile_error` | medium |
| `postToolUse` | `Write` | `ai_file_write` | low |
| `postToolUse` | `Edit` / `MultiEdit` / `search_replace` / `apply_patch` | `ai_file_edit` | low |
| `postToolUse` | anything else failing | `ai_tool_call_failed` | medium |
| `postToolUse` | otherwise | `ai_tool_call_completed` | low |
| `postToolUseFailure` | `is_interrupt: false`, shell + verification | `compile_error` | medium |
| `postToolUseFailure` | `is_interrupt: true` | `ai_tool_call_failed` (`outcome: cancelled`) | low |
| `postToolUseFailure` | otherwise | `ai_tool_call_failed` | medium |
| `preCompact` | `trigger: auto` | `context_compression_auto` | high |
| `preCompact` | `trigger: manual` | `context_compression_manual` | medium |
| `stop` | turn ≥ 30m | `agent_loop_long` | medium / high |

## Deliberately unmapped

`beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`,
`afterMCPExecution`, `afterFileEdit`, `beforeReadFile` are **specialised views
of tool calls that `preToolUse`/`postToolUse` already report**. Registering them
would double-count every command and edit. Register only the hooks in the table.

`subagentStart`, `subagentStop`, `afterAgentResponse`, `afterAgentThought`,
`workspaceOpen`, `beforeTabFileRead`, `afterTabFileEdit` have no catalog
counterpart.

## Quirks

- `tool_output` is a **JSON string**, not an object, so the exit code has to be
  parsed out of it before outcome inference. Unparseable output degrades to
  `outcome: "unknown"`.
- Failure arrives on its own hook (`postToolUseFailure`) rather than as a
  non-zero exit code, so `is_interrupt` is the only way to tell "the user
  cancelled" from "the tool broke". Only the latter is a risk signal.
- Turn length is measured here: `beforeSubmitPrompt` records a start keyed on
  `conversation_id`, `stop` consumes it. Cursor's `stop` payload has no duration.
