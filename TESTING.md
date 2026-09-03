# Testing ai-engineer-tools locally

Everything here works **without a backend, a phone, or DevAuth tokens**. The
repo ships a local mock of the Ascenda `/v1` contract
([ascenda-dev-server](./ascenda-dev-server/)) that auto-confirms pairings and
pretty-prints every event it receives — so you can watch, live, exactly what
each tool emits.

Prerequisites: Node **20+**, git. Everything stays on your machine.

## Path A — the two-minute tour

```bash
git clone <repo> && cd ai-engineer-tools
./scripts/dev-quickstart.sh
```

This installs, builds, starts the dev server on `http://localhost:4477`, pairs
a demo tool (auto-confirmed), pipes real sample agent payloads through the
actual hook CLIs, and leaves the server running. You should see events print
with their workload category:

```
12:03:41 claude_code      ai_file_edit                   [creation] low {"toolName":"Edit",...}
12:03:41 claude_code      context_compression_auto       [neutral]  high {"trigger":"auto",...}
```

## Path B — wire your real agents to the local server

Start the server in one terminal (it prints these instructions too):

```bash
node ascenda-dev-server/dist/cli.js        # http://localhost:4477
```

| Tool | How |
| --- | --- |
| **VS Code / Cursor** | F5 the extension (or install the VSIX), set `ascenda.apiBaseUrl` = `http://localhost:4477`, run **Ascenda: Connect App** — pairing auto-confirms, no app needed. Then just work: saves, editor switches, and terminal test/build runs stream to the server. |
| **Claude Code hooks** | `./scripts/setup-local.sh` — builds, starts this server detached, pairs, and registers the hooks for you. Restart Claude Code and work normally; prompts and tool calls arrive live. No exports needed: config lands in `~/.ascenda/credentials.json`. |
| **Cursor / Windsurf / Gemini CLI hooks** | With the dev server running, `node ascenda-<agent>-hooks/dist/cli.js setup --local` pairs, installs the bundle and registers that agent's hooks; config lands under `tools.<host>` in the same `~/.ascenda/credentials.json`. `./scripts/replay-agent-hooks.sh` drives all five adapters through their real CLIs with no agent installed. |
| **pairing-sim** | `export ASCENDA_API_BASE_URL=http://localhost:4477 ASCENDA_USER_TOKEN=dev` — the mock accepts any bearer, so `e2e`, `list`, `revoke` all work without DevAuth. |

### Without even the dev server

Set `ASCENDA_EVENT_LOG_FILE` and every tool appends what it emits to a JSONL
file — the exact wire payload plus a `delivery` field recording how it went.
It needs no server and no pairing (unpaired events log as `not_sent`, an
unreachable backend as `other`), so it is the shortest path to seeing for
yourself what a tool actually transmits:

```bash
export ASCENDA_EVENT_LOG_FILE=~/.ascenda/logs/events.jsonl
jq -c '[.delivery, .payload.eventType, .payload.metadata]' ~/.ascenda/logs/events.jsonl
```

The editors take the same setting as `ascenda.eventLogFile` instead: an editor
is launched from a dock icon with no shell environment, so an env var never
reaches it. The env var wins when both are set.

### Things worth trying (the interesting failure modes)

```bash
# Simulate consent expiry -> tools pause politely, extensions show one warning:
curl -X POST http://localhost:4477/_dev/consent -d '{"active":false}'
# ...renew it:
curl -X POST http://localhost:4477/_dev/consent -d '{"active":true}'

# Revoke a tool -> its next send gets 401 and it must re-pair:
ascenda-pairing-sim revoke cli_agent:local-demo

# See everything received so far as JSON:
curl http://localhost:4477/_dev/events
```

Manual-confirm mode (exercises the real pairing UX incl. the 6-digit code):
`node ascenda-dev-server/dist/cli.js --manual`, then confirm with
`ascenda-pairing-sim confirm-device-code <code>`.

## Path C — unit and integration tests

```bash
npm run verify   # DRY guard + full build + every test suite
```

The dev-server suite drives the **real kit HTTP client** through the full
contract flow (pair → ingest → renew → rotate → revoke → 401, consent expiry,
unclassified-event drift) — a local stand-in for the Azure Dev happy path.

## What feedback helps most

1. Did the quickstart work first try on your machine (OS + Node version)?
2. Wire one real agent — do the events you see match what you actually did?
3. Anything in the event stream that feels too revealing? (That's a privacy
   bug — the whole design claim is metadata-only.)
4. Where did you get stuck or need to read source to proceed?

## Limits of the mock

The dev server validates the wire contract and vocabulary, but does no
scoring, baselines, or aggregation — dashboards and the app need the real
backend. Numbers it accepts are exactly what a real backend would receive.
