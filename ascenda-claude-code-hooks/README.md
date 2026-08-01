# Ascenda Claude Code Hooks

Claude Code hooks adapter for Ascenda AI workload telemetry.

Part of [ai-engineer-tools](../). See the [Workload Telemetry Research Direction](../docs/WORKLOAD_TELEMETRY_RESEARCH_DIRECTION.md) and [Tooling Phase Alignment](../docs/TOOLING_PHASE_ALIGNMENT.md) (if present). Event mapping: [docs/CLAUDE_MAPPING.md](./docs/CLAUDE_MAPPING.md).

## Role in workload detection (Phase 1)

This package is the **primary AI interaction load** source in the tooling repo. For AI engineers, digital telemetry from agent workflows is potentially more valuable than wearables in Phase 1.

| Workload input | How this adapter contributes |
| --- | --- |
| AIInteractionLoad | Prompts, tool calls, correction loops, compaction |
| FocusDuration | Long agent loops (`agent_loop_long`) |
| Workflow friction | Tool failures, context pressure |
| Verification load | Test/lint/build bash → `editor_verification_activity` / `compile_error` |

Signals feed backend aggregation into creation / verification / supervision composition and the prototype workload score. Subjective strain and meeting load come from the app; baselines from backend Phase 3.

## Architecture

```text
Claude Code hook adapter
  -> toolInstallationId + eventWriteToken
  -> Ascenda backend (POST /v1/tool-events)
  -> paired anonymous Ascenda user
  -> workload aggregation + baseline comparison
  -> app notification / dashboard
```

Same loose-coupled pairing model as the VS Code and Cursor extensions. See [TOOL_PAIRING_API_REFERENCE.md](../api-docs/TOOL_PAIRING_API_REFERENCE.md).

## Installation (Claude Code)

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and working
- Node.js **20+** and npm
- A paired Ascenda `toolInstallationId` + `eventWriteToken` (from VS Code/Cursor extension or [pairing-sim `e2e`](../ascenda-pairing-sim/))

### 1. Build and install the hook CLI

```bash
# from the repo root (workspace install + shared packages first)
npm install
npm run build:shared

cd ascenda-claude-code-hooks
npm run build
npm link
```

Or:

```bash
./scripts/install-local.sh
```

Confirm the binary is on your PATH:

```bash
which ascenda-claude-hook
ascenda-claude-hook   # prints usage if no hook name is passed
```

### 2. Obtain pairing credentials

This package does **not** show a QR code. Pair first, then export the token:

**Option A — IDE extension**

1. Install and pair [Ascenda for Cursor](../ascenda-cursor-extension/) or [VS Code](../ascenda-vscode-extension-telemetry/).
2. Run **Ascenda: Show Status** and note `tool=…`.
3. Copy `toolInstallationId` and `eventWriteToken` from extension storage, or run pairing-sim `e2e` and use its printed values.

**Option B — pairing-sim e2e (Dev only)**

```bash
cd ../ascenda-pairing-sim
# local.devauth.env configured (gitignored DevAuth tokens)
npm run build
node dist/cli.js e2e --tool-type claude_code
```

Use the printed `ASCENDA_TOOL_INSTALLATION_ID` and `ASCENDA_EVENT_WRITE_TOKEN`. Tokens are also written under `~/.ascenda/tokens/`.

### 3. Configure environment

Add to your shell profile (`~/.zshrc`, `~/.bashrc`) or export in the terminal before starting Claude Code:

```bash
export ASCENDA_API_BASE_URL="https://app-asc-dev-api-aue.azurewebsites.net"   # or http://localhost:5002 / https://api.ascenda.one
export ASCENDA_TOOL_INSTALLATION_ID="claude_code:<uuid>"                     # or cursor_mcp:… / vscode_extension:… from IDE pair
export ASCENDA_EVENT_WRITE_TOKEN="<eventWriteToken>"
```

Optional:

| Variable | Purpose |
| --- | --- |
| `ASCENDA_EVENT_WRITE_TOKEN_FILE` | Override token file path (default `~/.ascenda/tokens/<toolInstallationId>`) |
| `ASCENDA_SESSION_ID` | Stable session id across hooks |
| `ASCENDA_WORKSPACE_HASH` | Opaque workspace hash if you set one |

On first run, the CLI seeds `~/.ascenda/tokens/<toolInstallationId>` so **tool-scoped renew** can persist rotated tokens without updating your shell profile.

### 4. Register hooks in Claude Code settings

Merge the hooks from [`examples/settings.local.json`](./examples/settings.local.json) into your Claude Code settings.

**Project-local** (recommended while testing): create or edit `.claude/settings.local.json` in the project root:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "ascenda-claude-hook UserPromptSubmit" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "ascenda-claude-hook PreToolUse" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "ascenda-claude-hook PostToolUse" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "ascenda-claude-hook PreCompact" }] }],
    "PostCompact": [{ "hooks": [{ "type": "command", "command": "ascenda-claude-hook PostCompact" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "ascenda-claude-hook Stop" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "ascenda-claude-hook Notification" }] }]
  }
}
```

**User-global:** merge the same `hooks` block into Claude Code’s user settings file (location depends on Claude Code version; often under `~/.claude/`).

If `ascenda-claude-hook` is not on PATH inside Claude Code’s environment, use an absolute path:

```text
/Users/<you>/.nvm/versions/node/<ver>/bin/ascenda-claude-hook UserPromptSubmit
```

### 5. Verify

```bash
# Smoke-test one hook with sample payload
npm run test:sample
npm run test:compact
```

Then start Claude Code in a project with hooks configured, submit a prompt / run a tool, and confirm events appear on the Ascenda backend (or that the hook exits `0`).

On auth failure the CLI exits `3` (re-pair). On missing consent it exits `2` (renew consent in the Ascenda app).

## Supported Claude hook events

```text
UserPromptSubmit
PreToolUse
PostToolUse
PreCompact
PostCompact
Stop
Notification
```

## Ascenda event mappings

Full mapping: [docs/CLAUDE_MAPPING.md](./docs/CLAUDE_MAPPING.md). Catalog-only event types (no aliases).

```text
UserPromptSubmit   -> ai_prompt_submitted / ai_correction_prompt
PreToolUse         -> ai_tool_call_started
PostToolUse Edit   -> ai_file_edit
PostToolUse Write  -> ai_file_write
PostToolUse Bash   -> editor_verification_activity / compile_error / ai_tool_call_*
PreCompact         -> context_compression_manual / context_compression_auto
PostCompact        -> context_pressure_high
Stop (long only)   -> agent_loop_long
Notification       -> (skipped — no catalog event)
```

## Privacy defaults

Metadata-only telemetry. Does not send raw prompts, responses, code, file names, repository names, branch names, or terminal output.

Correction detection uses local pattern matching on prompt text in the hook process only — classified metadata (`reason: repeated_reprompting`) is sent; raw prompt text is not.

## Roadmap

| Phase | Scope |
| --- | --- |
| Phase 1 | Hook mappings, metadata-only ingest, shared pairing tokens |
| Phase 2 | Standalone CLI pairing (`ascenda-claude-pair`) |
| Phase 3 | Session rollup metadata aligned with backend baselines |

## Compliance

`consentScope: ide_telemetry` and `provenance: ai_work_telemetry` on every event. Australian-hosted backend with transparent consent. Not a medical device — workload self-awareness only. See [research direction §7–8](../docs/WORKLOAD_TELEMETRY_RESEARCH_DIRECTION.md).
