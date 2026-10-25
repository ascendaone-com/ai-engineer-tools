# @ascenda-one/copilot-hooks

GitHub Copilot CLI hooks adapter for Ascenda AI workload telemetry. Metadata
only: prompt text, file contents and command output never leave the machine.

## Install

```bash
npx @ascenda-one/copilot-hooks setup
```

This pairs (printing a 6-digit code to confirm in the Ascenda app), installs a
self-contained hook bundle to `~/.ascenda/bin`, records the pairing under
`tools.copilot_cli` in `~/.ascenda/credentials.json`, and writes
`~/.copilot/hooks/ascenda.json`. Start a new Copilot CLI session and events
flow.

Copilot CLI loads every `*.json` in its hooks directory, so the file is
Ascenda's alone. Setup writes it whole, uninstall deletes it, and no other
hooks file is read or changed. `$COPILOT_HOME` moves the user-level directory,
as it does for Copilot CLI.

```bash
npx @ascenda-one/copilot-hooks status      # exits non-zero if anything is unwired
npx @ascenda-one/copilot-hooks doctor      # can the hooks run, has one run, and does the screen saver hear them
npx @ascenda-one/copilot-hooks uninstall   # removes the hooks file, the binary and this pairing
```

| Option | |
| --- | --- |
| `--api-base-url <url>` | ingest host (default `https://api.ascenda.one`) |
| `--local [port]` | shorthand for a local [dev server](../ascenda-dev-server/) (default `4477`) |
| `--tool-installation-id <id>` / `--token <t>` | reuse an existing pairing instead of creating one |
| `--scope user\|project` | write `~/.copilot/hooks/ascenda.json` for every project (default), or `.github/hooks/ascenda.json` in this repository only |
| `--project-dir <path>` | project root for `--scope project` (default cwd) |
| `--no-pair` | install without pairing: the screen saver and live view work, nothing is sent |
| `--dry-run` | print what would change, write nothing |

[examples/hooks.json](examples/hooks.json) is the equivalent hand-written
file for anyone who'd rather not run `setup`.

## Which Copilot runtimes read the file

Open. The CLI's documentation says it reads `~/.copilot/hooks/` and
`.github/hooks/`, but none of these has been checked on a clean machine yet:

- the standalone Copilot CLI reading `~/.copilot/hooks/`;
- the CLI running as VS Code's agent host, reading the same directory;
- VS Code's own chat, whose hook settings (`chat.useHooks`,
  `chat.hookFilesLocations`) are documented separately.

Until they are, the repository README doesn't list Copilot as covered.

## Configure

Nothing is required after `setup`. A hook resolves its identity from, in
order: the environment, its own entry in `~/.ascenda/credentials.json`, and,
when exactly one `cli_agent` token is on disk, the token store. A hook that
still can't name its installation records the skipped send in the journal
`status` reads.

| Variable | |
| --- | --- |
| `ASCENDA_TOOL_INSTALLATION_ID` | overrides the pairing `setup` recorded |
| `ASCENDA_EVENT_WRITE_TOKEN` | overrides the stored token |
| `ASCENDA_API_BASE_URL` | overrides the ingest host |
| `ASCENDA_EVENT_LOG_FILE` | local JSONL log of every event, or `off` |
| `COPILOT_HOME` | where setup writes the user-level hooks file (default `~/.copilot`) |

Without a pairing, every event is written to `~/.ascenda/events.jsonl` as
`not_sent`, so you can see exactly what would be transmitted.
[examples/local-event-reader](../examples/local-event-reader/) reads it.

## Privacy defaults

Metadata only. Doesn't send prompts, responses, code, file paths, command
text, tool arguments or results, repository names or branch names.
Correction detection runs locally on prompt text; only the classification is
transmitted.

`setup` prints the full list before it pairs. That block is generated from
the adapter's declaration in `src/setup.ts`, and
`packages/tool-kit/tests/setupDisclosure.test.mjs` fails the build when the
declaration and the mapper disagree.

## Event mapping

See [docs/COPILOT_MAPPING.md](docs/COPILOT_MAPPING.md). The camelCase hooks
are registered; `userPromptTransformed`, `permissionRequest`, `notification`
and `errorOccurred` are left out, with the reasons in the mapping doc.

## Test locally

No Copilot CLI install required:

```bash
./scripts/replay-agent-hooks.sh copilot
```

Hook invocations always exit `0`: telemetry must never block your work.
