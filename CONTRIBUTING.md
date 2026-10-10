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
- `ASCENDA_EVENT_LOG_FILE=<path>` makes any tool append what it would send to
  a JSONL file. No server, no pairing.

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
  it keeps, and what breaks if it changes. Leave out measurements taken from a
  real machine.

Before you push:

```bash
git diff origin/main | grep -nE "/Users/|/home/[a-z]"
```

## Licence

This project is licensed under [Apache-2.0](./LICENSE). By opening a pull
request you agree your contribution is licensed under it too, as section 5 of
the licence describes.

<!-- MAINTAINER: decide whether contributions need a CLA or a DCO sign-off, and state it here. -->
