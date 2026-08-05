# @ascenda-one/windsurf-hooks

Windsurf (Cascade) agent hooks adapter for Ascenda AI workload telemetry. Metadata only —
prompt text, file contents and command output never leave the machine.

## Install

```bash
npx @ascenda-one/windsurf-hooks --help
```

Copy `examples/hooks.json` into `.windsurf/hooks.json` (workspace) or `~/.codeium/windsurf/hooks.json` (user), pointing `command` at the installed
`ascenda-windsurf-hook`. Absolute paths are safest: agents spawn hooks with whatever
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

See [docs/WINDSURF_MAPPING.md](docs/WINDSURF_MAPPING.md).

Cascade has no compaction hook and its post_* hooks carry no exit status, so context-pressure events and shell `compile_error` are unreachable. See the mapping doc.

## Test locally

No Windsurf (Cascade) install required:

```bash
./scripts/replay-agent-hooks.sh windsurf
```

Hook invocations always exit `0`: telemetry must never block your work.
