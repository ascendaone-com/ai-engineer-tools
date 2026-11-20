# OpenCode Adapter Plan

OpenCode carries both rails already: a plugin API rich enough to cover the
whole catalog, and a SQLite store whose session table holds more per session
than anything else this repo reads.

It also breaks a shape assumption. Every adapter here is a command hook, so
the agent spawns a process, writes JSON to its stdin, and the process exits.
An OpenCode plugin is an ES module the agent imports and calls in-process.
That difference is the bulk of the work below, and Pi needs the same shape
after this, so build it once and build it properly.

Status: **planned, nothing built.** Paths, event names and the schema come
from OpenCode's documentation and its published source. No part of this has
been run against a real installation, which is step one.

## Rail 1: the plugin

A plugin is a module under `~/.config/opencode/plugins/` for a user or
`.opencode/plugins/` for a project. An npm package named in the `plugin`
array of `~/.config/opencode/opencode.json` works too, and that's the install
we want: `setup` adds one string to one JSON file, and updates arrive through
npm like every other package here.

The events worth taking:

| OpenCode event | Ascenda event | Category |
| --- | --- | --- |
| `session.created` | `create_focus_session` | creation |
| `session.idle` | `recovery_offline_period` | neutral |
| `session.compacted` | `context_compression_auto` | neutral |
| `session.error` | `tool_failure` | risk |
| `tool.execute.before` | `ai_tool_call_started` | supervision |
| `tool.execute.after`, write tool | `ai_file_write` / `ai_file_edit` | creation |
| `tool.execute.after`, verification command | `editor_verification_activity` | verification |
| `tool.execute.after`, failure | `ai_tool_call_failed` / `compile_error` | risk |
| `message.updated`, user role | `ai_prompt_submitted` | creation |
| `permission.asked` | none yet | none |

`file.edited` overlaps `tool.execute.after` for every edit an agent makes, so
registering both would double-count creation. Take the tool event. It carries
the tool name and the outcome, and a file edit with neither is a weaker row.

`permission.asked` and `permission.replied` are interesting and unmapped.
A permission prompt is a supervision interrupt, and how long it sits
unanswered is close to a direct measure of attention. No catalog event fits,
so leave them off the wire and raise the catalog question separately.

## The in-process shape

Running inside the agent is an upgrade and a liability at once.

The upgrade: no process spawn per tool call. The plugin imports
`@ascenda-one/tool-kit` and calls the outbox directly, so a busy session
costs a few function calls where a command hook costs hundreds of Node
starts.

The liability: our code is now in the user's agent process. A slow request
is their stall, and a thrown error is their crash. So the plugin does three
things and nothing else. Read the token, hand the event to the outbox,
return. Every handler is fire-and-forget with its own catch, and nothing
awaits a network call on a path the agent is waiting on.

### What carries over

These come out of `cliAgentSetup.ts` unchanged in behaviour:

- pairing, token write, credentials entry
- the merge-don't-clobber settings write
- `setup` / `status` / `uninstall` and their flags

### What's new

The install target is a package name in an array, not a hook entry keyed by
event. `HookSettingsFormat` describes the second and can't describe the
first, so the spec grows a second variant instead of a wider one.

New package: `ascenda-opencode-plugin`, published as
`@ascenda-one/opencode-plugin`, `toolType: cli_agent`, `host: opencode`.

## Rail 2: the store

Since v1.2.0 OpenCode keeps everything in `~/.local/share/opencode/opencode.db`,
SQLite in WAL mode, migrated forward by a versioned migration table. The
older per-file JSON under `~/.local/share/opencode/storage/session` survived
that migration on machines that ran it, so both shapes are live and the
sniffer has to handle each.

`staging.ts` already copies a WAL sibling alongside its database, and
`cursor.ts` already shells to `sqlite3` with `json_extract` so blob content
never enters the process. Both apply here as they stand.

### Two table generations in one file

OpenCode 2 renamed and split the session tables. A reader that only knows
`session`, `message` and `part` finds a 2.x database, opens it cleanly, and
imports nothing written since the upgrade. Checked against OpenCode's
published source at v2.3.0 on 17 Nov 2026 (`packages/core/src/session/sql.ts`
and `packages/core/src/database/migration/`):

| | 1.x | 2.x |
| --- | --- | --- |
| Session header | `session` | `session_v2` |
| Messages | `message` | `session_message`, with `type` and `seq` as real columns |
| Parts | `part` | `session_part`, keyed by `message_id` + `ordinal`, with `type` and `call_id` as real columns |
| Queued user input | none | `session_inbox` |

Migration `20260804233008` does the rename. A database already on the 2.x
lineage has `session` renamed in place. Any other database gets `session_v2`
created beside whatever was there, so the old tables can stay behind with
the pre-upgrade history in them. `session_part` arrived later, in migration
`20261029002625`, so a 2.x store from before that date has `session_message`
and no part table.

That gives three shapes to dispatch on, and the session `version` column
can't tell them apart. Use the tables that exist:

1. Read `sqlite_master` for `session_v2`, `session_message`, `session_part`,
   `session`, `message`, `part`.
2. Record the newest `id` in the `migration` table as the schema revision.
   Several earlier migrations cleared `session_message` outright, so a
   fixture is only good for the revision it was taken at.
3. When both generations hold rows, read both and dedupe on session `id`,
   2.x winning. Whether one session can appear in both is a question for
   the real store in step 1.
4. An unknown combination ships nothing and reports the table list as
   drift.

### The tables that matter

- **`session_v2`** (`session` on 1.x), one row per session, and the richest
  header this repo has read: `tokens_input`, `tokens_output`,
  `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `cost`,
  `summary_additions`, `summary_deletions`, `summary_files`, `agent`,
  `directory`, `time_created`, `time_updated`, `time_compacting`. On 2.x,
  `model` is a JSON object (`id`, `providerID`, optional `variant`), so
  select its fields with `json_extract`. 2.x also adds `time_busy`,
  `time_idle` and `time_archived`. Check on the real store whether
  `time_busy` is a duration or a timestamp before leaning on it for active
  time.
- **Subagents and forks are separate columns.** `parent_id` links a child
  session to its parent, the same subagent problem Cursor's `subagentInfo`
  posed and the same fix. `fork_session_id` and `fork_boundary` mark a
  session forked from another. Check on the real store whether a fork
  copies its parent's messages. If it does, count only what follows the
  boundary, as the Claude Code extractor does for resumed copies.
- **`session_part`** (`part` on 1.x) holds one row per message part, tool
  calls included, with the payload in a `data` JSON column. Select scalars
  out of it with `json_extract`; never read the column whole. On 2.x the
  part `type` and the tool `call_id` are columns, so counting tool calls
  needs no JSON at all. Tool calls ship per row, because the backend
  derives `toolCallCount` by counting `ai_tool_call_started` and reads no
  aggregate.
- **`session_message`** (`message` on 1.x) gives one row per message, `data`
  JSON. On 2.x `type` is a column and `seq` orders messages within a
  session, unique per session, so order by it.
- **`session_inbox`** holds user input queued for delivery. Count prompts
  from `session_message` only, and confirm on the real store that a
  delivered prompt leaves the inbox, so none is counted twice.
- **`event`** is OpenCode's own log, typed and sequenced. Read it on a real
  store before writing anything. If it records what the messages imply,
  reconstructing from parts is work we can skip.

## Order of work

1. Install OpenCode 2, run a real session, fork one, snapshot the database.
   Do the same on a 1.x install, then upgrade it and snapshot again: that
   third snapshot is the one that shows what the migration leaves behind.
2. The second setup variant in `tool-kit`, with its own tests.
3. The plugin package, its mapping doc, and fixtures per event.
4. The extractor, with a fixture per table generation, each labelled with
   the migration id it was taken at.

Steps 2 and 3 are the ones Pi reuses. The README coverage tables stay as they
are until each piece runs.
