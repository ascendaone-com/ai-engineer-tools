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
- A pairing to reuse (see [Pair first](#pair-first) below)

### 1. Run the published CLI

No clone, no build — the package is on npm:

```bash
npx @ascenda-one/codex-hooks --help
```

### 2. Pair first

```bash
npx -y @ascenda-one/claude-code-hooks pair --tool-type cli_agent
```

It prints a 6-digit code — confirm it in the Ascenda app under
**Connections → Ingest telemetry** — then saves the write token to
`~/.ascenda/tokens/` and prints the export line:

```bash
export ASCENDA_TOOL_INSTALLATION_ID="cli_agent:<uuid>"   # printed by `pair`
```

Add it to your shell profile. **Without this variable every hook invocation
exits with `Missing ASCENDA_TOOL_INSTALLATION_ID`.**

On a Dev backend with no phone:

```bash
cd ../ascenda-pairing-sim && npm run build
node dist/cli.js e2e --tool-type cli_agent --name "Codex CLI"
```

`ASCENDA_API_BASE_URL` defaults to `https://api.ascenda.one`; set it to
`http://localhost:5002` or the Azure Dev host for development.

### 3. Register hooks in Codex

Merge [`examples/hooks.json`](./examples/hooks.json) into `~/.codex/hooks.json`
(machine-wide) or `<repo>/.codex/hooks.json` (per project). Inline `config.toml`
form works too:

```toml
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "npx -y @ascenda-one/codex-hooks UserPromptSubmit"
timeout = 10
```

### 4. Verify

Run a Codex session and confirm events arrive on the backend — or simply that
the hook exits `0`, which it always does (see the safety contract above).

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

Metadata-only. Does not send prompts, responses, code, file names, repository names, or terminal output. Correction detection runs locally on prompt text; only the classification is transmitted. `consentScope: ide_telemetry`, `provenance: ai_work_telemetry` on every event.
