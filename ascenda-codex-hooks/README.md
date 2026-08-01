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

## Installation

### Prerequisites

- [Codex CLI](https://developers.openai.com/codex) with hooks support (v0.117+)
- Node.js **20+** and npm
- A paired Ascenda `toolInstallationId` + `eventWriteToken` (from an IDE extension pair, or [pairing-sim](../ascenda-pairing-sim/) `e2e --tool-type cli_agent` on Dev)

### 1. Build and install the hook CLI

```bash
# from the repo root (workspace install + shared packages first)
npm install
npm run build:shared

cd ascenda-codex-hooks
npm run build
npm link
```

Confirm: `which ascenda-codex-hook`.

### 2. Obtain pairing credentials

Same loose-coupling model as every Ascenda tool — pair once, reuse the credentials:

```bash
# Dev only, without a phone:
cd ../ascenda-pairing-sim
node dist/cli.js e2e --tool-type cli_agent --name "Codex CLI"
```

Export the printed values (tokens also land in `~/.ascenda/tokens/`):

```bash
export ASCENDA_API_BASE_URL="https://app-asc-dev-api-aue.azurewebsites.net"   # or http://localhost:5002 / https://api.ascenda.one
export ASCENDA_TOOL_INSTALLATION_ID="cli_agent:<uuid>"
export ASCENDA_EVENT_WRITE_TOKEN="<eventWriteToken>"
```

### 3. Register hooks in Codex

Merge [`examples/hooks.json`](./examples/hooks.json) into `~/.codex/hooks.json` (machine-wide) or `<repo>/.codex/hooks.json` (per project). Inline `config.toml` form works too:

```toml
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "ascenda-codex-hook UserPromptSubmit"
timeout = 10
```

If `ascenda-codex-hook` is not on Codex's PATH, use the absolute path to the binary.

### 4. Verify

```bash
npm run test          # unit tests for the mapping
npm run test:sample   # pipes a sample PostToolUse payload through the CLI
```

Then run a Codex session and confirm events arrive on the backend.

## Supported Codex hook events

`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, `Stop`. (`PermissionRequest`, `SubagentStart`, `SubagentStop` have no catalog counterpart and are skipped.)

## Turn duration

Codex's `Stop` payload has no duration, so the adapter records a turn-start timestamp per session under `~/.ascenda/state/` at `UserPromptSubmit` and consumes it at `Stop`; turns of 30+ minutes emit `agent_loop_long`. State failures degrade silently to "no duration".

## Privacy defaults

Metadata-only. Does not send prompts, responses, code, file names, repository names, or terminal output. Correction detection runs locally on prompt text; only the classification is transmitted. `consentScope: ide_telemetry`, `provenance: ai_work_telemetry` on every event.
