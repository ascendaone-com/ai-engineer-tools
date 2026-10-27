# Contributing

Thanks for looking. Bug reports, compatibility reports and new agent adapters
are all welcome. Open an issue first for anything bigger than a small fix, so
we can agree the shape before you write it.

## Build and test

You need Node 20 or newer and git.

```bash
npm install
npm run verify
```

`verify` is what CI runs on every pull request. It runs the DRY guard
(`scripts/check-dry.sh`), builds the shared packages and then every tool, and
runs every workspace's tests. If it passes locally, CI should agree.

None of it needs an Ascenda account. [ascenda-dev-server](./ascenda-dev-server/)
is a local mock of the `/v1` pairing and ingest API: it auto-confirms pairings
and prints every event it receives, so you can watch what a tool sends.
[TESTING.md](./TESTING.md) walks through it:

- `./scripts/dev-quickstart.sh` builds, starts the mock and pipes sample hook
  payloads through the real CLIs.
- `./scripts/replay-agent-hooks.sh` drives every adapter through its CLI with
  no agent installed.
- An install made with `setup --no-pair` writes every event to
  `~/.ascenda/events.jsonl`. `ASCENDA_EVENT_LOG_FILE=<path>` points any tool
  at another file. No server, no pairing.

## Adding an agent adapter

An adapter is a thin package over `packages/tool-kit`. Read
[ascenda-gemini-hooks](./ascenda-gemini-hooks/) before you start; it's the
smallest complete one, at a few hundred lines.

| File | What it does |
| --- | --- |
| `src/types.ts` | The agent's hook names, its host name (`gemini_cli`) and the shared `cli_agent` tool type |
| `src/mapGeminiEvent.ts` | Turns one hook payload into zero or more catalog events. Catalog values only: a hook with no counterpart maps to nothing |
| `src/cli.ts` | Reads stdin, maps, and hands the events to `deliverHookEvents`. Always exits 0 |
| `src/setup.ts` | A `CliAgentSetupSpec`: which hooks to register, where the agent keeps its settings, and the shape of one entry |
| `src/liveSignal.ts` | Optional. What the local live signal says for each hook |
| `docs/GEMINI_MAPPING.md` | The hook-to-event table, and the hooks left unregistered on purpose, with the reason |
| `tests/` | Mapper, setup, wire vocabulary and session-on-the-wire tests |

`deliverHookEvents` in
[hookAdapter.ts](./packages/tool-kit/src/hookAdapter.ts) does the rest:
config, pairing state, the outbox, the event log and the send. `setup`,
`status`, `doctor` and `uninstall` come from `runCliAgentSetup`. Don't
reimplement any of it in the adapter. `check-dry.sh` fails the build if a
package grows a private copy of a shared module.

Then wire the package in:

1. Add it to `workspaces` and `build:tools` in the root `package.json`.
2. Add its `src/` to `consumer_dirs` in `scripts/check-dry.sh`.
3. Add a sample payload per hook to `scripts/replay-agent-hooks.sh`.
4. If the agent runs as a process the live signal should name, add it to
   `AGENT_PROCESS` in [agentProcess.ts](./packages/tool-kit/src/agentProcess.ts).

Leave `scripts/release-artifacts.mjs` alone. A row there publishes the package
on the next tag, and that's the maintainer's call.

A few rules every adapter keeps:

- **Metadata only.** No prompt text, file names, paths, command lines or
  source. Classify, bucket or hash; never forward. A new metadata key goes on
  `AscendaEventMetadata`, in `EVENT_METADATA_FIELDS` and in
  `EVENT_METADATA_DISCLOSURE`, all in
  [tool-contract](./packages/tool-contract/src/index.ts). The contract tests
  fail until all three agree.
- **Never block the agent.** A hook exits 0 whatever happens. Telemetry that
  stalls or fails a user's turn is worse than none.
- **Nothing new on the wire without the catalog.** If the agent reports
  something no event type covers, leave it unmapped and say so in the mapping
  doc. A new event type needs the backend to accept it first, so open an issue.
- **The public event is separate.** Each log line also carries a v0 `event`
  from [packages/agent-events](./packages/agent-events/). A new catalog type
  shows up there as `other` until it gets a kind in
  [agentEvent.ts](./packages/tool-kit/src/agentEvent.ts). Adding a kind is
  fine in v0. Renaming or removing a field has to be listed in the release
  notes, so call it out in your PR.

## Reporting where your agent keeps its history

[ascenda-history-import](./ascenda-history-import/) reads past sessions from
Claude Code, Codex, Cursor and GitHub Copilot. We've mapped where about twenty
other coding agents keep their history, using their docs, their source and
other people's readers. None of that map has been checked on a real machine.

If you use one of the tools below, ten minutes in a terminal tells us whether
we got it right. We need the shape of the store. We don't need what's in it.

### What to send

- The tool's name and version, and your OS.
- Whether the path in the table exists. If it's somewhere else, where.
- The schema or key list, from the commands below.
- Rough counts: how many sessions, how many lines or rows.

### What to leave out

No prompts, no code, no transcripts, no file contents. Write your home folder
as `~` in any path.

Read the output before you paste it. Some stores use file paths or IDs as JSON
keys, and those would show up in a key list. Delete those lines.

### Commands

For a SQLite file, list the tables and their columns. This prints no rows:

```bash
sqlite3 "PATH/TO/store.db" .schema
```

For a JSON file, list every key path with the values stripped:

```bash
jq -r '[paths | map(if type == "number" then "[]" else . end) | join(".")] | unique[]' "PATH/TO/session.json"
```

For a JSONL file, the same across every line:

```bash
jq -rn '[inputs | paths | map(if type == "number" then "[]" else . end) | join(".")] | unique[]' "PATH/TO/events.jsonl"
```

If the lines have a type field, a count of each type helps too. Swap `.kind`
for whatever the field is called:

```bash
jq -rn '[inputs | .kind] | group_by(.) | map("\(.[0]) \(length)")[]' "PATH/TO/events.jsonl"
```

### The tools

Ordered roughly by how much a report would help. Paths are for macOS.

| Tool | Where we think history lives | What we most want to know |
| --- | --- | --- |
| Goose | `~/.local/share/goose/sessions/sessions.db` | The `schema_version` value, and whether forked sessions show up as full copies |
| Cline 4.x | `~/.cline/data/db/sessions.db` and `~/.cline/data/sessions/<id>/` | Whether pre-4.0 tasks are still in VS Code's `globalStorage/saoudrizwan.claude-dev/` beside the new store |
| Kilo Code 7.x | `~/.local/share/kilo/kilo.db` | Schema, and whether migrated sessions have `ses_migrated_` IDs |
| OpenCode, or Tabnine's OpenCode plugin | Kilo's layout, and `~/.tabnine/opencode` for Tabnine | Whether the schema matches Kilo's |
| Zed | `~/Library/Application Support/Zed/threads/threads.db` | Schema, and which file holds the `sidebar_threads` table |
| Junie CLI | `~/.junie/sessions/index.jsonl` and `session-*/events.jsonl` | Key list for `events.jsonl`, and where prompt text sits |
| Trae CLI 2.x | `~/.trae/cli/sessions/YYYY/MM/DD/rollout-*.jsonl` | Record types, and whether they match Codex's rollouts |
| Devin CLI | `~/.local/share/devin/cli/sessions.db` and `transcripts/` | Schema. Nobody official has documented it |
| Kiro, IDE or CLI | `~/.kiro/sessions/`, or `~/Library/Application Support/kiro-cli/data.sqlite3` on older CLIs | Are current sessions plain files or SQLite? The docs and the readers disagree |
| Warp | `~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite` | Schema, and the path on Warp Preview |
| Amp | `~/.local/share/amp/threads/T-*.json` | Does the current CLI still write these files? Do threads started on the web get one? |
| Augment CLI | `~/.augment/sessions/<id>.json` | Key list |
| JetBrains AI Assistant | `~/Library/Application Support/JetBrains/<Product><version>/workspace/*.xml` and `aia-task-history/*.events` | Whether `.events` files start with `AUI_EVENTS_V1`, and your IDE version |
| Continue | `~/.continue/sessions/` | Key list, if you still have history from before the project stopped |
| Roo Code | VS Code `globalStorage/rooveterinaryinc.roo-cline/tasks/` | Whether `tasks/_index.json` exists |
| Aider | `.aider.chat.history.md` and `.aider.input.history` in each repo | Whether you've turned on `--analytics-log` or `--llm-history-file` |

On Linux, swap `~/Library/Application Support/` for `~/.config/`. On Windows,
use `%APPDATA%`. If the tool runs inside Cursor, Windsurf or VSCodium, its
`globalStorage` folder sits under that editor's directory, not under `Code`.

### Cloud agents

Jules, Devin, the GitHub Copilot coding agent and Codex cloud don't keep
history on your machine. Each has an API of some kind. If you use one, tell us
your plan tier and whether its session or log endpoint answers for you. Never
send an API key or token.

### Sending it

Open a [new integration proposal](https://github.com/ascendaone-com/ai-engineer-tools/issues/new?template=new-integration.yml)
and pick "Reading history the tool stores on disk". One tool per issue keeps
the threads readable. A store that doesn't match the table is the most useful
report you can send.

## This repository is public

Everything you commit is readable by anyone, including commit messages and
PR descriptions, and it stays readable after a force-push. [AGENTS.md](./AGENTS.md)
has the full rules. The ones that bite contributors:

- **No absolute paths from your machine.** Use a placeholder or a
  repo-relative path, in code, fixtures and docs alike.
- **Synthetic fixtures only.** Don't copy a real agent transcript, a real
  hook payload or real counts from your own history into a test. Build the
  smallest payload that shows the case.
- **No names from private codebases.** Describe a thing by what it does.
- **Comments say what a maintainer needs:** what the code does, the invariant
  it keeps, and what breaks if it changes. A count you measured backs a rule
  up, so keep it, and say what it was measured on. Leave out the content
  behind it: prompt text, paths and names.

Before you push:

```bash
git diff origin/main | grep -nE "/Users/|/home/[a-z]"
```

## Licence

This project is licensed under [Apache-2.0](./LICENSE). By opening a pull
request you agree your contribution is licensed under it too, as section 5 of
the licence describes.

<!-- MAINTAINER: decide whether contributions need a CLA or a DCO sign-off, and state it here. -->
