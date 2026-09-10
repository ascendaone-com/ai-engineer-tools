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
partial and leading-edge. The signal reports `tool: "gemini_cli"`, this host's
own name rather than the shared `cli_agent` tool type, because the app keys
one stream per `tool`/`session` pair and a shared name would fuse the CLI
adapters into one and under-count concurrency.

| Gemini hook | Live signal |
| --- | --- |
| BeforeAgent | `prompt_submitted` (+ a coarse size bucket; never the text) |
| BeforeTool | `tool_call` — the leading edge, so the gauge rises as work starts |
| AfterTool (failure) | `tool_failure` |
| AfterTool (success or unknown) | *(silent — BeforeTool already counted the call)* |
| PreCompress | `compaction` |
| AfterAgent | `stop` |
| SessionStart, SessionEnd | *(silent — the turn is the beat, not the CLI run)* |
| BeforeModel, AfterModel, BeforeToolSelection, Notification | *(silent — per round trip)* |

Emission is additive and best-effort: it is abandoned after 50 ms, swallows
every error, and a machine with no listener — which is most machines, and
every CI runner — behaves exactly as it did before this existed.

`SessionEnd` is silent on purpose: it lands immediately after the last
`AfterAgent`, and a second `stop` would draw two session ends for one turn.

`queued` — the field saying a turn came out of the user's queue — is absent
from every Gemini signal, and its absence is a measurement, not an oversight.
Gemini payloads carry nothing that could answer, and the field is tri-state so
that a tool which cannot know says nothing rather than saying "no".
