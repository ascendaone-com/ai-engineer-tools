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

## Local live bus (not telemetry)

A second, entirely local path. Alongside the cloud send, the adapter writes a
one-line JSON signal to a Unix socket on this machine (`~/.ascenda/live.sock`)
that the Ascenda Flow macOS app binds. Nothing leaves the machine, nothing is
stored, and the cloud path is unaffected either way.

It exists because four local features have no other input: the live gauges,
the Away Mode keep-awake assertion (without it the Mac sleeps mid-work), the
settle bell, and the paired handoff to the Waterline screen saver.

The signal reports `tool: "cursor"` — this host's own name, and **distinct
from the Cursor extension's `cursor_mcp`**. That distinction has a cost worth
naming: run both the extension and these hooks and the same work arrives on
the bus twice, under session ids with nothing in common, so the concurrency
gauge reads two streams where a person would count one. There is no shared
session id to dedupe on today. It was accepted because someone who takes only
the hooks route had all four features silently dead, and a gauge that
over-counts for the doubly-installed is the smaller defect. What must not
happen is the two names collapsing into one, since a single install would
then be indistinguishable from a double one.

The vocabulary is much smaller than the event catalog above — five values —
and the app drops anything it cannot parse, so the mapping is deliberately
partial and leading-edge.

| Cursor hook | Live signal |
| --- | --- |
| `beforeSubmitPrompt` | `prompt_submitted` (+ a coarse size bucket; never the text) |
| `preToolUse` | `tool_call` — the leading edge, so the gauge rises as work starts |
| `postToolUseFailure` (`is_interrupt: false`) | `tool_failure` |
| `postToolUseFailure` (`is_interrupt: true`) | *(silent — a user pressing stop is not a failure)* |
| `postToolUse` | *(silent — failure has its own hook, so this would only double-count)* |
| `preCompact` | `compaction` |
| `stop` | `stop` |
| `sessionStart`, `sessionEnd` | *(silent — the turn is the beat, not the app session)* |
| the shell / MCP / file / Tab / subagent hooks | *(silent — views of calls `preToolUse` already reported)* |

Emission is additive and best-effort: it is abandoned after 50 ms, swallows
every error, and a machine with no listener — which is most machines, and
every CI runner — behaves exactly as it did before this existed.

`queued` — the field saying a turn came out of the user's queue — is absent
from every Cursor signal, and its absence is a measurement, not an oversight.
Cursor payloads carry nothing that could answer, and the field is tri-state so
that a tool which cannot know says nothing rather than saying "no".

## Quirks

- `tool_output` is a **JSON string**, not an object, so the exit code has to be
  parsed out of it before outcome inference. Unparseable output degrades to
  `outcome: "unknown"`.
- Failure arrives on its own hook (`postToolUseFailure`) rather than as a
  non-zero exit code, so `is_interrupt` is the only way to tell "the user
  cancelled" from "the tool broke". Only the latter is a risk signal.
- Turn length is measured here: `beforeSubmitPrompt` records a start keyed on
  `conversation_id`, `stop` consumes it. Cursor's `stop` payload has no duration.
