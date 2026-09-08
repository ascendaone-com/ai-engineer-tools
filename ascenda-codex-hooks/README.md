# Ascenda Codex Hooks

OpenAI Codex hooks adapter for Ascenda AI workload telemetry.

Part of [ai-engineer-tools](../). Event mapping: [docs/CODEX_MAPPING.md](./docs/CODEX_MAPPING.md). Codex hooks reference: [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks).

## Role in workload detection

Third agent producer after the IDE extensions and [Claude Code hooks](../ascenda-claude-code-hooks/). Contributes the same AI interaction load signals — prompts, correction loops, tool calls, verification runs, compaction pressure, long agent turns — from Codex sessions, into the shared canonical event catalog.

| Workload input | How this adapter contributes |
| --- | --- |
| AIInteractionLoad | Prompts, tool calls, correction loops, compaction |
| FocusDuration | Session starts, long turns (`agent_loop_long`, measured locally) |
| Workflow friction | Tool failures, context pressure |
| Verification load | shell test/lint/build → `editor_verification_activity` / `compile_error` |

Identity: Codex rides the canonical `cli_agent` toolType/source (the backend registry has no codex value yet); events carry `metadata.host: "codex"` for later disaggregation.

## Hook safety contract

Codex **awaits** command hooks and treats **exit code 2 as blocking** the user's action. This adapter therefore always exits `0` and caps every HTTP call at 3 s (`ASCENDA_HTTP_TIMEOUT_MS` to change): telemetry failures surface as a one-line `systemMessage` or stderr note and never stall or block the engineer.

## Install

### Prerequisites

- [Codex CLI](https://developers.openai.com/codex) with hooks support (v0.117+)
- Node.js **20+**

### 1. Set up

One command pairs Codex, installs the hook binary, and registers the hooks:

```bash
npx -y @ascenda-one/codex-hooks setup --scope user
```

It prints a 6-digit code — confirm it in the Ascenda app under
**Connections → Ingest telemetry** — then writes:

- the write token to `~/.ascenda/tokens/`
- the pairing to `tools.codex` in `~/.ascenda/credentials.json`
- the hook entries to `~/.codex/hooks.json`

**There is no shell profile line to add.** Codex reads its identity from the
credentials file, which is per agent — so pairing Codex cannot disturb a
Claude Code or Cursor pairing on the same machine, and a Codex hook launched
from the Dock with an empty environment still names itself correctly.

`--scope user` registers machine-wide. Omit it and hooks land in
`<cwd>/.codex/hooks.json`, instrumenting that project only — which is the
default, so pass the flag unless you mean one repo.

### 2. Check it

```bash
npx @ascenda-one/codex-hooks status
```

Names the pairing, the binary and how many of the 7 events are registered.
Exits non-zero when something is missing, so it can gate a CI step.

To undo everything it wrote:

```bash
npx @ascenda-one/codex-hooks uninstall
```

### 3. Restart Codex

Hooks are read at startup.

### On a Dev backend with no phone

`setup --local` points at the [dev server](../ascenda-dev-server), which
auto-confirms the pairing:

```bash
node ../ascenda-dev-server/dist/cli.js      # in another terminal
npx @ascenda-one/codex-hooks setup --local --scope user
```

`--api-base-url` takes any other host; the default is `https://api.ascenda.one`.

### Registering hooks by hand

`setup` is the supported path. [`examples/hooks.json`](./examples/hooks.json)
is the same content for anyone who would rather merge it themselves, or who
needs the inline `config.toml` form:

```toml
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "npx -y @ascenda-one/codex-hooks UserPromptSubmit"
timeout = 10
```

A hand-merged file still needs a pairing — run `setup` for that, or export
`ASCENDA_TOOL_INSTALLATION_ID` yourself. The environment variable wins over
the credentials file when both are present, so exporting one id on a machine
running two agents sends both agents' work under it.

### Verify

Run a Codex session, then read the send journal at
`~/.ascenda/state/<installationId>.json`. It records every attempt including
failures, so an absent file means "never ran" rather than "ran and failed" —
which is the distinction the hook's own exit code cannot give you, since it
always exits `0` (see the safety contract above).

Set `ASCENDA_EVENT_LOG_FILE` to also log each payload locally.

## Build from source

Not needed to use this — npm ships it prebuilt. It is here so you can verify
what runs.

```bash
# from the repo root (workspace install + shared packages first)
npm install
npm run build:shared

cd ascenda-codex-hooks
npm run build
npm link                # exposes `ascenda-codex-hook`
which ascenda-codex-hook

npm run test            # unit tests for the mapping
npm run test:sample     # pipes a sample PostToolUse payload through the CLI
```

A local build exposes the binary as `ascenda-codex-hook` — substitute it for
`npx -y @ascenda-one/codex-hooks` in the hook config above. If it is not on
Codex's PATH, use the absolute path to the binary.

## Supported Codex hook events

`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, `Stop`. (`PermissionRequest`, `SubagentStart`, `SubagentStop` have no catalog counterpart and are skipped.)

## Turn duration

Codex's `Stop` payload has no duration, so the adapter records a turn-start timestamp per session under `~/.ascenda/state/` at `UserPromptSubmit` and consumes it at `Stop`; turns of 30+ minutes emit `agent_loop_long`. State failures degrade silently to "no duration".

## Privacy defaults

Metadata-only. Does not send prompts, responses, code, file names, repository names, branch names, or terminal output. Correction detection runs locally on prompt text; only the classification is transmitted. `consentScope: ide_telemetry`, `provenance: ai_work_telemetry` on every event.

Repository and branch identity travel only as machine-salted digests, never as
text: `workspaceHash`/`projectHash` from folder names, and `metadata.branchHash`
from the branch the checkout is on. A branch name is low-entropy, so that digest
is not a security boundary — the machine salt is what makes the input space
unguessable. On a detached HEAD, outside a checkout, or with no readable salt
the key is omitted rather than sent blank.
