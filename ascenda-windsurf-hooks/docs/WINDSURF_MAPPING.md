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

## Local live bus (not telemetry)

A second, entirely local path. Alongside the cloud send, the adapter writes a
one-line JSON signal to a Unix socket on this machine (`~/.ascenda/live.sock`)
that the Ascenda Flow macOS app binds. Nothing leaves the machine, nothing is
stored, and the cloud path is unaffected either way.

It exists because four local features have no other input: the live gauges,
the Away Mode keep-awake assertion (without it the Mac sleeps mid-work), the
settle bell, and the paired handoff to the Waterline screen saver.

The vocabulary is much smaller than the event catalog above — five values —
and the app drops anything it cannot parse, so the mapping is deliberately
partial and leading-edge. The signal reports `tool: "windsurf"`, this host's
own name rather than the shared `cli_agent` tool type, because the app keys
one stream per `tool`/`session` pair and a shared name would fuse the CLI
adapters into one and under-count concurrency.

| Cascade hook | Live signal |
| --- | --- |
| pre_user_prompt | `prompt_submitted` (+ a coarse size bucket; never the text) |
| pre_read_code, pre_write_code, pre_run_command, pre_mcp_tool_use | `tool_call` — the leading edge |
| post_mcp_tool_use (explicit error marker) | `tool_failure` |
| post_read_code, post_write_code, post_run_command | *(silent — the pre_* partner already counted the call)* |
| post_cascade_response | `stop` |
| post_cascade_response_with_transcript | *(silent — the same moment, repeated)* |
| post_setup_worktree | *(silent)* |

Emission is additive and best-effort: it is abandoned after 50 ms, swallows
every error, and a machine with no listener — which is most machines, and
every CI runner — behaves exactly as it did before this existed.

**`compaction` is unreachable from Cascade.** Windsurf ships no compaction
hook, so that ripple never fires for these users — the same gap this document
already records for `context_compression_*`, not a gap in the mapping.

`post_mcp_tool_use` is the only Cascade hook that reports an outcome at all,
so it is the only one that can ring the failure impulse, and only on an
explicit error marker: `mcp_result` is free-form per server, and guessing
would report failures for work that succeeded.

`queued` — the field saying a turn came out of the user's queue — is absent
from every Cascade signal, and its absence is a measurement, not an oversight.
Cascade payloads carry nothing that could answer, and the field is tri-state so
that a tool which cannot know says nothing rather than saying "no".
