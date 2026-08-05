# @ascenda-one/gemini-hooks

Gemini CLI agent hooks adapter for Ascenda AI workload telemetry. Metadata only —
prompt text, file contents and command output never leave the machine.

## Install

```bash
npx @ascenda-one/gemini-hooks --help
```

Copy `examples/settings.json` into `~/.gemini/settings.json` (user) or `.gemini/settings.json` (project), pointing `command` at the installed
`ascenda-gemini-hook`. Absolute paths are safest: agents spawn hooks with whatever
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

See [docs/GEMINI_MAPPING.md](docs/GEMINI_MAPPING.md).

`BeforeModel`/`AfterModel` are deliberately unregistered: they fire per LLM round trip and would multiply event volume. See the mapping doc.

## Test locally

No Gemini CLI install required:

```bash
./scripts/replay-agent-hooks.sh gemini
```

Hook invocations always exit `0`: telemetry must never block your work.
