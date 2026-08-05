# @ascenda-one/cursor-hooks

Cursor agent hooks adapter for Ascenda AI workload telemetry. Metadata only —
prompt text, file contents and command output never leave the machine.

## Install

```bash
npx @ascenda-one/cursor-hooks --help
```

Copy `examples/hooks.json` into `~/.cursor/hooks.json` (user) or `.cursor/hooks.json` (project), pointing `command` at the installed
`ascenda-cursor-hook`. Absolute paths are safest: agents spawn hooks with whatever
environment they were launched from.

## Configure

Identity comes from the environment:

| Variable | |
| --- | --- |
| `ASCENDA_TOOL_INSTALLATION_ID` | required — pair via an Ascenda IDE extension or `ascenda-pairing-sim` |
| `ASCENDA_EVENT_WRITE_TOKEN` | required unless a token file already exists |
| `ASCENDA_API_BASE_URL` | defaults to `https://api.ascenda.one` |
| `ASCENDA_EVENT_LOG_FILE` | optional local JSONL log of every event |

With `ASCENDA_EVENT_LOG_FILE` set and no pairing, events are written locally as
`not_sent` instead of failing — so you can see exactly what would be
transmitted before connecting anything.

## Event mapping

See [docs/CURSOR_MAPPING.md](docs/CURSOR_MAPPING.md).

Register only the hooks in `examples/hooks.json` — the shell/MCP/file-edit hooks are specialised views of tool calls that `preToolUse`/`postToolUse` already report, so adding them double-counts.

## Test locally

No Cursor install required:

```bash
./scripts/replay-agent-hooks.sh cursor
```

Hook invocations always exit `0`: telemetry must never block your work.
