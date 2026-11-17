# Pi Adapter Plan

Pi is the best-documented target of the three, and its session format is the
only one published as a spec with a version field on the first line. Where
the Claude Code, Codex and Cursor extractors had to infer a shape and pin it
with fixtures, Pi hands over both the shape and the dispatch key.

Two rails again. The extension covers live work; the session files cover
what already happened, and they sit on disk until someone deletes them, so
the history can wait.

Pi's live event set is richer than any of the five agents this repo already
ships for. That's the argument for doing it, and the reason not to do it
first: the in-process shape it needs is the same one the
[OpenCode plan](./OPENCODE_ADAPTER_PLAN.md) builds. Land that, then this
package is mostly a mapping table.

Status: **planned, nothing built.** Everything here comes from Pi's published
documentation. Nothing has been run.

## Rail 1: the extension

Pi discovers extensions from `~/.pi/agent/extensions/*.ts` for a user and
`.pi/extensions/*.ts` for a project, and a project one loads only after the
project is trusted. An npm package works too, named in the `packages` array
of `settings.json` as `npm:@scope/name@version`. That's the install to build:
one entry in one file, updates through npm.

An extension registers handlers with `pi.on()`:

| Pi event | Ascenda event | Category |
| --- | --- | --- |
| `session_start` | `create_focus_session` | creation |
| `session_shutdown` | `recovery_offline_period` | neutral |
| `turn_start`, user turn | `ai_prompt_submitted` | creation |
| `turn_end`, over a duration bucket | `agent_loop_long` | risk |
| `tool_execution_start` | `ai_tool_call_started` | supervision |
| `tool_execution_end`, write tool | `ai_file_write` / `ai_file_edit` | creation |
| `tool_execution_end`, verification command | `editor_verification_activity` | verification |
| `tool_execution_end`, failure | `ai_tool_call_failed` / `compile_error` | risk |
| `session_before_compact` | `context_pressure_high` | risk |
| `session_compact` | `context_compression_auto` | neutral |
| `session_compact_failed` | `tool_failure` | risk |

`message_start`, `message_update` and `message_end` fire per streamed message
and carry nothing the turn and tool events miss. `tool_execution_update`
fires repeatedly inside one call. All four stay unregistered, for the same
volume reason Gemini's per-inference hooks do.

Pi's own docs say an extension runs with the user's full permissions. That
raises the bar on the handler contract the OpenCode plan sets, it doesn't
change it: read the token, hand the event to the outbox, return, catch
everything, await no request on a path the agent is waiting on.

New package: `ascenda-pi-extension`, published as
`@ascenda-one/pi-extension`, `toolType: cli_agent`, `host: pi`.

## Rail 2: the session files

Sessions are JSONL at
`~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`. The
directory name encodes the working directory with separators replaced by
hyphens, so a session's project comes off the path with no inference.

The first line is a header:

```json
{"type":"session","version":3,"id":"…","timestamp":"…","cwd":"/path/to/project"}
```

`version` is 1, 2 or 3, and Pi documents what changed at each step: 1 is a
linear entry list, 2 introduced the `id`/`parentId` tree, 3 renamed one role.
Fixtures per version, dispatched off that field, and design rule 3 is
satisfied by the file itself.

Entries worth reading:

- `message` carries the work. A `user` role is a prompt, an `assistant` role
  brings `usage`, `model`, `provider` and `stopReason`, and a `toolResult`
  brings `toolCallId`, `toolName` and `isError`. That last one is an outcome
  the store states outright, so no failure has to be inferred from output
  text.
- `compaction` records `tokensBefore` and `firstKeptEntryId`, giving both a
  compression event and a real figure for the pressure that caused it.
- `model_change` and `thinking_level_change` mark where a session's cost
  profile shifts. No catalog event fits either yet.
- `custom` and `custom_message` are other extensions' data. Skip them.

### The tree needs care

Entries form a tree, not a list, and Pi branches in place rather than writing
a new file. A session that was forked and re-run holds both attempts. Walking
every line would count abandoned work as delivered work, and walking only the
active leaf would drop effort the engineer really spent.

Neither is right on its own. The split this repo already draws between
hands-on and agent-supervising minutes is the shape the answer should take,
and settling it needs a real forked session in front of us.

### Oh My Pi is a second agent

Oh My Pi (`omp`) is a fork of Pi with its own store, and its files look
enough like Pi's to be read wrongly. Treat it as a separate source with its
own `host`, sharing the entry parser and nothing above it. Checked against
its published source and `docs/session.md` on 17 Nov 2026:

| | Pi | Oh My Pi |
| --- | --- | --- |
| Sessions | `~/.pi/agent/sessions/` | `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<session-id>.jsonl` |
| Named profiles | none | `~/.omp/profiles/<name>/agent/sessions/` |
| First line | the header | a fixed 256-byte title slot, then the header |
| Header | `type: "session"`, `version` 1 to 3 | the same shape, 3 current |
| Large content | inline | may be a reference into `~/.omp/agent/blobs/<sha256>` |

Four things follow.

- **Skip the title slot before sniffing.** A reader that expects the header
  on line one rejects every Oh My Pi file. The slot is one padded JSON line.
  Older Oh My Pi files have no slot, so accept either.
- **Don't let one reader claim the other's folder.** Both agents honour
  `PI_CODING_AGENT_DIR`. Decide the source from the file (slot present, or
  entry types only one of them writes), never from the path alone.
- **Walk every profile.** Each named profile has its own agent directory,
  and a person who keeps work and personal apart will have two.
- **Expect one transcript in two files.** When a second process writes a
  session another process owns, Oh My Pi moves it to a sibling file with a
  new session id, publishes the whole in-memory transcript there, and sets
  `parentSession` to the old id. The header can also list
  `previousSessionFiles`. Count the shared history once, the way the Claude
  Code extractor handles resumed copies.

Blob references should need no following: the blob store holds content,
which this importer never reads. Confirm on a real file that usage, model
and tool outcome stay on the entry when its content is externalized.

Oh My Pi's entry set is wider than Pi's. Unknown entry types go to the
drift count, as they do for every other source, and a file with any of them
still ships what was understood.

## Order of work

1. Install Pi, run a real session, fork one, snapshot both. Do the same for
   Oh My Pi, and open one session from two terminals to produce a sibling.
2. The extractor, with fixtures for each session `version`, plus an Oh My Pi
   file with a title slot and one without.
3. The extension package, once the OpenCode plan's second setup variant is in
   `tool-kit`.

The extractor leads here, unusually. Its format is specified, its fixtures
are cheap, and it doesn't wait on the setup work the extension does. The
README coverage tables stay as they are until each piece runs.
