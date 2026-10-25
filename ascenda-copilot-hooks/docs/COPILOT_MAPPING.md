# GitHub Copilot CLI hook → Ascenda event mapping

Source: the payloads Copilot CLI sent in a real session, read from the
`hook.start` records in its `~/.copilot/session-state/<id>/events.jsonl`.
They differ from the published hooks reference in three places, listed under
Quirks.
Catalog: [tool-contract](../../packages/tool-contract/src/index.ts).

Every event carries `metadata.host = "copilot_cli"` and rides `source: "cli_agent"`.

| Copilot hook | Condition | Ascenda event | Severity |
| --- | --- | --- | --- |
| `sessionStart` | | `create_focus_session` | low |
| `sessionEnd` | | `recovery_offline_period` | low |
| `userPromptSubmitted` | always | `ai_prompt_submitted` | low |
| `userPromptSubmitted` | prompt looks like a correction | `+ ai_correction_prompt` | medium |
| `preToolUse` | one per element of `toolCalls` | `ai_tool_call_started` | low |
| `postToolUse` | `create` | `ai_file_write` | low |
| `postToolUse` | `edit` | `ai_file_edit` | low |
| `postToolUse` | `bash` + verification command | `editor_verification_activity` | low |
| `postToolUse` | `resultType` failure, `bash` + verification | `compile_error` | medium |
| `postToolUse` | `resultType` failure, anything else | `ai_tool_call_failed` | medium |
| `postToolUse` | otherwise | `ai_tool_call_completed` | low |
| `postToolUseFailure` | `bash` + verification command | `compile_error` | medium |
| `postToolUseFailure` | otherwise | `ai_tool_call_failed` | medium |
| `preCompact` | `trigger` says manual | `context_compression_manual` | medium |
| `preCompact` | otherwise | `context_compression_auto` | high |
| `subagentStart` / `subagentStop` | | `subagent_started` / `subagent_stopped` | low |
| `agentStop` | turn ≥ 30m | `agent_loop_long` | medium / high |
| `agentStop` | every turn, after the above | `ai_turn_completed` | low |

A successful `bash` call that commits, pushes or reverts carries `gitAction`
on its `ai_tool_call_completed`, as on every other adapter.

## Tool names

Copilot CLI's built-in tools, as `tool.execution_start` names them in session
logs on this machine:

| Tool | What it is | Mapped as |
| --- | --- | --- |
| `bash` | runs a shell command, `toolArgs.command` | shell |
| `create` | writes a new file (`path`, `file_text`) | write |
| `edit` | replaces a string in a file (`path`, `old_str`, `new_str`) | edit |
| `view`, `rg`, `grep`, `glob`, `show_file` | reads and searches | other |
| `read_bash`, `write_bash`, `stop_bash` | drive a shell already running; no command | other |
| `task`, `update_todo`, `report_intent` | subagents and bookkeeping | other |

The Windows shell tool hasn't been seen, so it maps as an ordinary tool.

## Deliberately unregistered

- **`userPromptTransformed`** repeats `userPromptSubmitted` with the expanded
  text. Registering both would count each prompt twice.
- **`permissionRequest`** has no documented input.
- **`notification`** carries UI text with no work signal.
- **`errorOccurred`** has no catalog event that fits. Worth a second look
  once a real error has been captured.
- **The PascalCase aliases** (`PostToolUse` and the rest) switch the payload
  to snake_case and Claude Code's tool names. Only the camelCase names are
  registered.

## Quirks

- **`preToolUse` is batched.** One call per batch of tool requests:
  `{ sessionId, cwd, toolCalls: [{ id, name, args }] }`, with no `timestamp`.
  The reference describes a single `toolName` and `toolArgs`; that shape is
  read too.
- **`postToolUse` is per call** and has no call id, so a post can't be joined
  to its pre. The outcome comes from `toolResult.resultType`: `success` is
  the only value seen so far, `failure` and `error` read as failure, and
  `rejected` and `denied` as cancelled.
- **`timestamp` is epoch milliseconds.** Nothing reads it: a hook runs at the
  moment it describes.
- **`sessionStart` can arrive after `userPromptSubmitted`** in a new session.
  The prompt hook records the turn's start and `sessionStart` leaves it
  alone, so `agentStop` still finds it.
- **The payload doesn't name its hook.** Each one is registered as
  `ascenda-copilot-hook <hookName>` and the name arrives on argv.
- **No model, tokens or permission posture** in any hook. The history import
  reads model and tokens from the session log.

## Settings file

Copilot CLI loads every `*.json` in `~/.copilot/hooks/` (or
`$COPILOT_HOME/hooks/`) and in a repository's `.github/hooks/`. Setup owns one
file there, `ascenda.json`, writes it whole and deletes it on uninstall. It
doesn't merge into or back up anyone else's file. See
[examples/hooks.json](../examples/hooks.json).

## Local live bus (not telemetry)

Alongside the cloud send, the adapter writes a one-line JSON signal to the
Ascenda Flow macOS app's Unix socket (`~/.ascenda/live.sock`). Nothing leaves
the machine. The signal reports `tool: "copilot_cli"` and carries no PID,
since there's no process rule for Copilot CLI yet.

| Copilot hook | Live signal |
| --- | --- |
| `userPromptSubmitted` | `prompt_submitted` (+ a coarse size bucket; never the text) |
| `preToolUse` | `tool_call`, once per batch |
| `postToolUse` (failure) | `tool_failure` |
| `postToolUseFailure` | `tool_failure` |
| `preCompact` | `compaction` |
| `agentStop` | `stop` |
| `sessionEnd` | `halted` |
| `sessionStart`, `postToolUse` (otherwise), subagent hooks | *(silent)* |

Copilot has no hook for a permission prompt, so it never sends `awaiting`.
