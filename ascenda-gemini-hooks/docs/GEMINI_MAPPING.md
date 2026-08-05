# Gemini CLI hook → Ascenda event mapping

Source: [geminicli.com/docs/hooks/reference](https://geminicli.com/docs/hooks/reference/).
Catalog: [tool-contract](../../packages/tool-contract/src/index.ts).

Every event carries `metadata.host = "gemini_cli"` and rides `source: "cli_agent"`.
Hooks are enabled by default in Gemini CLI v0.26.0+.

| Gemini hook | Condition | Ascenda event | Severity |
| --- | --- | --- | --- |
| `SessionStart` | | `create_focus_session` | low |
| `SessionEnd` | | `recovery_offline_period` | low |
| `BeforeAgent` | always | `ai_prompt_submitted` | low |
| `BeforeAgent` | prompt looks like a correction | `+ ai_correction_prompt` | medium |
| `BeforeTool` | | `ai_tool_call_started` | low |
| `AfterTool` | `run_shell_command` + verification, success | `editor_verification_activity` | low |
| `AfterTool` | `run_shell_command` + verification, failure | `compile_error` | medium |
| `AfterTool` | `write_file` | `ai_file_write` | low |
| `AfterTool` | `replace` / `edit` | `ai_file_edit` | low |
| `AfterTool` | anything else failing | `ai_tool_call_failed` | medium |
| `AfterTool` | otherwise | `ai_tool_call_completed` | low |
| `PreCompress` | | `context_compression_auto` | high |
| `AfterAgent` | turn ≥ 30m | `agent_loop_long` | medium / high |

## Deliberately unmapped

`BeforeModel`, `AfterModel` and `BeforeToolSelection` fire on **every LLM round
trip**. A single agent turn produces many, so registering them would multiply
event volume several-fold for signal the tool hooks already carry. They are the
one place any agent exposes per-inference latency, so revisit if model-level
timing becomes a wanted metric — but do it deliberately, with volume in mind.

`Notification` has no catalog counterpart.

## Quirks

- `PreCompress` carries no trigger field, so compaction is always recorded as
  `auto`. Gemini has no manual-compaction hook, so `context_compression_manual`
  is unreachable.
- Tool names are Gemini's own: `run_shell_command`, `write_file`, `replace`,
  `read_file`, `glob`, `search_file_content`.
- Config nests one level deeper than the other agents: each event maps to an
  array of `{ matcher, hooks: [{ type, command }] }`. See `examples/settings.json`.
- The event name arrives in `hook_event_name` on stdin, so one `command` works
  for every hook.
