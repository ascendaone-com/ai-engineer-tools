# Cascade hook → Ascenda event mapping

Source: [docs.windsurf.com/windsurf/cascade/hooks](https://docs.windsurf.com/windsurf/cascade/hooks).
Catalog: [tool-contract](../../packages/tool-contract/src/index.ts).

Every event carries `metadata.host = "windsurf"` and rides `source: "cli_agent"`.
All Cascade payloads nest their event-specific fields under `tool_info`.

| Cascade hook | Condition | Ascenda event | Severity |
| --- | --- | --- | --- |
| `pre_user_prompt` | always | `ai_prompt_submitted` | low |
| `pre_user_prompt` | `tool_info.user_prompt` looks like a correction | `+ ai_correction_prompt` | medium |
| `pre_read_code` | | `ai_tool_call_started` (`read_code`) | low |
| `post_read_code` | | `ai_tool_call_completed` | low |
| `pre_write_code` | | `ai_tool_call_started` (`write_code`) | low |
| `post_write_code` | | `ai_file_edit` | low |
| `pre_run_command` | | `ai_tool_call_started` + `commandClass` | low |
| `post_run_command` | test/lint/typecheck/build | `editor_verification_activity` | low |
| `post_run_command` | otherwise | `ai_tool_call_completed` | low |
| `pre_mcp_tool_use` | | `ai_tool_call_started` (`mcp_<name>`) | low |
| `post_mcp_tool_use` | `mcp_result.isError` or non-empty `.error` | `ai_tool_call_failed` | medium |
| `post_mcp_tool_use` | otherwise | `ai_tool_call_completed` | low |
| `post_cascade_response` | turn ≥ 30m | `agent_loop_long` | medium / high |

## Coverage gaps — Cascade's, not this mapper's

**No compaction hook exists.** `context_compression_auto`,
`context_compression_manual` and `context_pressure_high` are unreachable for
Windsurf. Context pressure is a core workload signal, so Windsurf data will
under-report it relative to Claude Code, Codex, Cursor and Gemini.

**`post_*` hooks carry no exit status.** `post_run_command` reports the command
and cwd but never a result, so `outcome` is always `unknown` and `compile_error`
can never fire from a shell command. Verification *activity* is still captured;
verification *failure* is not. `post_mcp_tool_use` is the only hook exposing a
result, and therefore the only source of `ai_tool_call_failed`.

**No session-start hook.** `create_focus_session` is unreachable; the first
`pre_user_prompt` of a trajectory is the closest proxy.

## Deliberately unmapped

`post_cascade_response_with_transcript` repeats the turn end and points at a
JSONL transcript of raw conversation content, which this tool never reads.
`post_setup_worktree` has no catalog counterpart.

## Quirks

- The event name arrives in `agent_action_name` on stdin, so the adapter does
  not need it as an argv argument — one `command` works for every hook.
- `trajectory_id` is the conversation; `execution_id` is a single turn within
  it. Turn length keys on `trajectory_id`.
- `mcp_result` is free-form per MCP server, so only an explicit error marker
  counts as failure. Guessing from arbitrary shapes would invent failures.
