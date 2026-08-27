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

## `autonomyMode` — the permission posture, mirrored

Codex hook payloads carry `permission_mode`, and this adapter reads it. Source
of truth is Codex's own generated wire schema
([`codex-rs/hooks/schema/generated/*.command.input.schema.json`](https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated),
read 28 Aug 2026), not the prose page: the schema pins the enum to exactly five
values, which the [hooks reference](https://learn.chatgpt.com/docs/hooks) states
as `default`, `acceptEdits`, `plan`, `dontAsk`, or `bypassPermissions`.

| `permission_mode` | `autonomyMode` |
| --- | --- |
| `default` | `default` |
| `plan` | `plan` |
| `acceptEdits` | `accept_edits` |
| `dontAsk` | `dont_ask` |
| `bypassPermissions` | `bypass_permissions` |
| *anything else* | `unknown` |
| *field not in the payload* | *key omitted* |

**Upstream's own word, snake-cased, and nothing else** — the same rule the
[Claude adapter](../../ascenda-claude-code-hooks/docs/CLAUDE_MAPPING.md#autonomymode--the-permission-posture-mirrored)
follows. This is Claude Code's table minus `auto`, spelled identically, so both
collectors land on the same tokens without either being translated into a
vocabulary we invented. Where the two runtimes agree the wire shows agreement;
where they diverge, it shows the divergence rather than hiding it inside a
shared rung. The enum is `AutonomyMode` in `@ascenda-one/tool-contract`,
imported, never redefined.

**No posture ladder is emitted here, by design.** The five-rung ladder this
field first shipped with — `planning`/`supervised`/`edits_auto`/`delegated`/
`unsupervised` — now lives in `autonomyBand` in `@ascenda-one/tool-kit`,
derived from the stored token at read time. The corpus is append-only, so a
coarsening applied at capture can never be undone; one applied at read is a
query away from being reconsidered. Whether `accept_edits` on Codex is the same
*posture* as `accept_edits` on Claude Code is exactly the kind of question that
stays answerable because both tokens are on the wire and the collector name is
on every row.

- **The mapping is total.** An unrecognised value becomes `unknown` and is
  still sent, so a mode OpenAI ships next month shows up as a rising `unknown`
  count rather than as nothing having changed.
- **Absent is not `unknown`.** Where the payload carries no posture the key is
  omitted, so "this hook has no such field" stays distinguishable from "we
  failed to map a value we were given".
- **`auto` is deliberately unmapped**, though Claude Code has it and emits it.
  Codex has no such mode today, and its own UI preset named *Auto* is a
  different thing — it still escalates commands for approval. A shared spelling
  would not be evidence of a shared meaning, so if it ever appears it arrives
  as `unknown` and the mapping is chosen from what the mode actually does. This
  is the one row where the two adapters' tables differ, and they differ because
  the payloads do.
- **Codex's native vocabulary is unmapped too, and not by oversight.** The
  `approval_policy` (`untrusted`/`unless-trusted`/`on-failure`/`on-request`/
  `never`) and `sandbox_mode` (`read-only`/`workspace-write`/
  `danger-full-access`) pair is what `/permissions` and `config.toml` actually
  control, but no hook payload carries either, they are two orthogonal axes,
  and inventing tokens for wire values nothing is known to send would be a
  guess dressed as a measurement.
- **Not gated on success.** A call that failed still happened under a posture,
  and a failure under `bypass_permissions` is a different fact from the same
  failure under `default`.

### Which events carry it

| Hook | Ascenda event | Posture |
| --- | --- | --- |
| SessionStart | `create_focus_session` | ✅ opening posture |
| UserPromptSubmit | `ai_prompt_submitted`, `ai_correction_prompt` | ✅ |
| PreToolUse | `ai_tool_call_started` | ❌ *(deduplicated — see below)* |
| PostToolUse | `ai_file_edit`, `ai_tool_call_*`, `compile_error`, `editor_verification_activity` | ✅ |
| PreCompact / PostCompact | `context_compression_*`, `context_pressure_high` | ❌ *(Codex sends no `permission_mode` on these two)* |
| Stop | `agent_loop_long` | ✅ |

`PreToolUse` is skipped because it and `PostToolUse` are a pair over the same
call under the same mode: carrying it once halves the cost on the
highest-volume event with no information lost. The exception is a call that
starts and never completes; if that turns out to matter, adding it to the
`PreToolUse` branch is a one-line change. This matches the Claude adapter.

Two differences from the Claude adapter, both from the payloads rather than
from choice: Codex **does** send the mode on `SessionStart` (Claude does not),
and Codex's enum has no `auto`. The `SessionStart` value is the *opening*
posture only — the mode can be switched mid-session and every later hook
carries the current one — so no reader may treat it as the session's posture.

Live-only by nature: transcripts do not record permission state, so unlike
model mix this cannot be recovered by a later import. Every day uncaptured is
gone.

### Still on the wire and not read

`model` — a "Codex-specific extension. Active model slug" present on **every**
hook payload, not just `SessionStart`. It is not mapped here yet, and the
`ModelClass` note in `@ascenda-one/tool-contract` was written believing Codex
knew no model at all. Mapping it is a separate piece of work: the slug values
(`gpt-5.6-sol` and friends) need matching against real ones before a
`vendor:tier` bucket can be claimed rather than guessed.

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
