# Antigravity Adapter Plan

Antigravity ships an agent CLI (`agy`), an IDE and a hub app. All three write
their work to the same place on disk, and the CLI carries a command-hook API
whose shape is close enough to Claude Code's that most of
`packages/tool-kit/src/cliAgentSetup.ts` applies unchanged.

Two rails, as with every other agent here: hooks for what happens live,
an extractor for what already happened. The hooks come first. A live event
nobody captured is gone, and the transcripts on disk show no purge, so the
history can be read later at no cost.

Status: **planned, nothing built.** Everything below is drawn from
Antigravity's published documentation. None of it has been checked against a
real store, and that check is the first task, not the last.

## Rail 1: hooks

`agy` reads hooks from `~/.gemini/config/hooks.json` for a user and
`.agents/hooks.json` for a workspace. A workspace file wins over the global
one. The entry shape:

```json
{
  "ascenda": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "…", "timeout": 5 }] }
    ]
  }
}
```

Five events exist: `PreInvocation`, `PostInvocation`, `PreToolUse`,
`PostToolUse` and `Stop`.

### What we register

| Antigravity hook | Ascenda event | Category |
| --- | --- | --- |
| `PreToolUse` | `ai_tool_call_started` | supervision |
| `PostToolUse`, success, write tool | `ai_file_write` / `ai_file_edit` | creation |
| `PostToolUse`, success, verification command | `editor_verification_activity` | verification |
| `PostToolUse`, success, anything else | `ai_tool_call_completed` | supervision |
| `PostToolUse`, failure, verification command | `compile_error` | risk |
| `PostToolUse`, failure, anything else | `ai_tool_call_failed` | risk |
| `Stop`, turn over a duration bucket | `agent_loop_long` | risk |

`PreInvocation` and `PostInvocation` fire once per LLM round trip. Gemini CLI's
adapter leaves the equivalent pair unregistered for a reason that holds here
too: they multiply event volume several times over for signal the tool hooks
already carry. Leave them off, and say so in the mapping doc where a reader
looking for them will find the answer.

That leaves no hook for a submitted prompt. Claude Code has `UserPromptSubmit`
and Gemini has `BeforeAgent`; Antigravity has neither, so `ai_prompt_submitted`
and `ai_correction_prompt` have no live source. Document the gap the way
`ascenda-windsurf-hooks` documents its own partial coverage. Don't infer a
prompt from `PreInvocation` — an inference dressed as an observation is worse
than a missing row.

### Wiring

The outer key wrapping the event map is the one thing `HookSettingsFormat`
doesn't already describe. `settingsPath`, `entry` and `commandOf` all need to
reach one level further in. Everything else is the existing spec: pairing,
the self-contained binary under `~/.ascenda/bin`, the credentials entry, and
a settings write that merges rather than clobbers.

New package: `ascenda-antigravity-hooks`, published as
`@ascenda-one/antigravity-hooks`, binary `ascenda-antigravity-hook`,
`toolType: cli_agent`, `host: antigravity`.

## Rail 2: history

Transcripts live under `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/`,
with sibling trees for the IDE and the hub app. Each conversation directory
holds `transcript.jsonl` and `transcript_full.jsonl`. Same records, same
order; the full file keeps content the short one clips and marks in a
`truncated_fields` key.

Read the short one. This package ships metrics, so every field the truncation
touches is content we'd drop anyway, and the smaller file is cheaper to stage
and parse.

Open questions the first real store has to answer:

- What labels a record's version. Design rule 3 dispatches on a self-labelled
  version, and no published field is an obvious candidate yet. If none exists,
  the sniffer keys on record shape and anything unrecognised becomes
  `historical_unparsed`.
- Which record type carries a tool call, and whether a call has a stable id
  across its start and its result. The unit for `ai_tool_call_started` is the
  call, not the line.
- Whether the three trees share a format or only a parent directory.
- What a conversation record says about the working directory, if anything.

## Order of work

1. Install `agy`, run a real session, snapshot the tree.
2. Hooks package, mapping doc, fixtures.
3. Extractor, once a real transcript exists to write fixtures from.

Nothing lands in the README's coverage tables until the code behind the row
runs. A row claiming support that isn't there is the defect
`compatibility.json` was written to avoid.
