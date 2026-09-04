# @ascenda-one/gemini-hooks

Gemini CLI agent hooks adapter for Ascenda AI workload telemetry. Metadata only —
prompt text, file contents and command output never leave the machine.

## Install

```bash
npx @ascenda-one/gemini-hooks setup
```

This pairs (printing a 6-digit code to confirm in the Ascenda app), installs a
self-contained hook bundle to `~/.ascenda/bin`, records the pairing under
`tools.gemini_cli` in `~/.ascenda/credentials.json`, and registers the hooks
in this project's `.gemini/settings.json`. Restart Gemini CLI and events flow — no
shell exports, no settings file to hand-edit. That matters more than it
sounds: a GUI-launched editor never sees a shell rc file, so an id that lives
only in an `export` line silently stops telemetry the next time the app is
opened from the Dock.

```bash
npx @ascenda-one/gemini-hooks status      # exits non-zero if anything is unwired
npx @ascenda-one/gemini-hooks uninstall   # removes hooks, the binary and this pairing
```

| Option | |
| --- | --- |
| `--api-base-url <url>` | ingest host (default `https://api.ascenda.one`) |
| `--local [port]` | shorthand for a local [dev server](../ascenda-dev-server/) (default `4477`) |
| `--tool-installation-id <id>` / `--token <t>` | reuse an existing pairing instead of creating one |
| `--scope project\|user` | register in this project (default) or in `~/.gemini/settings.json` |
| `--project-dir <path>` | project root for `--scope project` (default cwd) |
| `--dry-run` | print what would change, write nothing |

`examples/` holds the equivalent hand-written config for anyone who would
rather not run `setup`.

## Configure

Nothing is required after `setup`. A hook resolves its identity from, in
order: the environment, its own entry in `~/.ascenda/credentials.json`, and
— when exactly one `cli_agent` token is on disk — the token store. A hook that
still cannot name its installation records the skipped send in the journal
`status` reads, rather than exiting silently.

| Variable | |
| --- | --- |
| `ASCENDA_TOOL_INSTALLATION_ID` | overrides the pairing `setup` recorded |
| `ASCENDA_EVENT_WRITE_TOKEN` | overrides the stored token |
| `ASCENDA_API_BASE_URL` | overrides the ingest host |
| `ASCENDA_EVENT_LOG_FILE` | optional local JSONL log of every event |

With `ASCENDA_EVENT_LOG_FILE` set and no pairing, events are written locally as
`not_sent` instead of failing — so you can see exactly what would be
transmitted before connecting anything. Every payload carries the UTC offset
and an idempotency key; both come from the shared sender in `tool-kit`, so
this adapter holds only its mapping.

## Event mapping

See [docs/GEMINI_MAPPING.md](docs/GEMINI_MAPPING.md).

`BeforeModel`/`AfterModel` are deliberately unregistered: they fire per LLM round trip and would multiply event volume. See the mapping doc.

## Test locally

No Gemini CLI install required:

```bash
./scripts/replay-agent-hooks.sh gemini
```

Hook invocations always exit `0`: telemetry must never block your work.
