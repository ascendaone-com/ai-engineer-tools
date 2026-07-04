# Ascenda for Cursor

Cursor-compatible extension for privacy-first AI workload telemetry and loose app pairing.

Part of [ai-engineer-tools](../). See the [Workload Telemetry Research Direction](../docs/WORKLOAD_TELEMETRY_RESEARCH_DIRECTION.md) and [Tooling Phase Alignment](../docs/TOOLING_PHASE_ALIGNMENT.md).

## Role in workload detection (Phase 1)

Same baseline IDE telemetry as the [VS Code extension](../ascenda-vscode-extension-telemetry/), with `source: cursor_mcp` and `toolType: cursor_mcp`. Cursor is treated as a first-class telemetry producer for AI engineers.

| Workload input | Phase 1 (extension) | Phase 2 (MCP adapter) |
| --- | --- | --- |
| FocusDuration | Session + editor activity | Agent loop duration |
| TaskSwitchRate | Active editor changes | — |
| AIInteractionLoad | Simulated test commands only | `ai_prompt_submitted`, tool calls, correction loops |
| Verification load | Terminal test/lint/build | `editor_verification_activity` |
| Workflow friction | Terminal failures, after-hours | `ai_tool_call_failed`, `context_pressure_high` |

For richest AI agent signals today, pair this extension and also run [Claude Code hooks](../ascenda-claude-code-hooks/).

## What this provides

- QR/code pairing to Ascenda mobile app
- Loose coupling via `toolInstallationId` + scoped `eventWriteToken`
- Cursor source detection (`cursor_mcp`)
- Privacy-safe editor activity telemetry
- Terminal command classification where shell integration is available
- Session start/end telemetry
- After-hours AI session detection
- Manual simulation commands for context pressure / context compression / long agent loops
- Scaffold for MCP/agent adapter ([CURSOR_ADAPTER_PLAN.md](./docs/CURSOR_ADAPTER_PLAN.md))

## Installation (Cursor)

Cursor supports VS Code–compatible extensions. Install and run this package **from Cursor** (not only from VS Code).

### Prerequisites

- [Cursor](https://cursor.com/) (recent build)
- Node.js **20+** and npm
- Access to an Ascenda Development or production API

### 1. Build the extension

```bash
cd ascenda-cursor-extension
npm install
npm run compile
```

### 2. Run in Extension Development Host (recommended for local/dev)

1. Open **this folder** (`ascenda-cursor-extension`) as the workspace in **Cursor**  
   (`File → Open Folder…`).
2. Press **F5** (or **Run and Debug → Run Ascenda Extension**).  
   Cursor opens an **Extension Development Host** window.
3. In that host window, open the project you normally work in.
4. Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

```text
Ascenda: Connect App
```

5. Confirm pairing with the Ascenda mobile app, or with [ascenda-pairing-sim](../ascenda-pairing-sim/) on Dev:

```bash
ascenda-pairing-sim confirm-device-code <6-digit-code>
```

6. Check **Ascenda: Show Status**, then **Ascenda: Send Test Signal**.

### 3. Point at the right API

In the Extension Development Host settings (search “Ascenda”):

| Setting | Example |
| --- | --- |
| `ascenda.apiBaseUrl` | `https://app-asc-dev-api-aue.azurewebsites.net` (Dev), `http://localhost:5002` (local BE), or `https://api.ascenda.one` (prod) |

```json
{
  "ascenda.apiBaseUrl": "https://app-asc-dev-api-aue.azurewebsites.net",
  "ascenda.telemetry.enabled": true
}
```

### 4. Optional: install as a local VSIX in Cursor

```bash
npm install -g @vscode/vsce
npm run compile
npm run package
# produces ascenda-cursor-0.1.0.vsix (version may vary)
```

In Cursor: **Extensions → … (Views and More Actions) → Install from VSIX…** and select the `.vsix` file. Reload Cursor, then run **Ascenda: Connect App**.

CLI alternative (if `cursor` is on your PATH):

```bash
cursor --install-extension ascenda-cursor-0.1.0.vsix
```

### Commands

| Command | Purpose |
| --- | --- |
| `Ascenda: Connect App` | Start QR/code pairing |
| `Ascenda: Disconnect App` | Clear local token |
| `Ascenda: Send Test Signal` | Smoke-test ingest |
| `Ascenda: Simulate Context Compression` | Manual catalog event |
| `Ascenda: Simulate Context Pressure High` | Manual catalog event |
| `Ascenda: Simulate Agent Loop Long` | Manual catalog event |
| `Ascenda: Show Status` | Paired / token / host / tool id |

### Backend contract

See [TOOL_PAIRING_API_REFERENCE.md](../api-docs/TOOL_PAIRING_API_REFERENCE.md). Tool-side routes use `/v1`.

## Privacy defaults

Metadata-only telemetry. Does not send source code, raw prompts, AI responses, file names, branch names, terminal output, or repository names.

Not a medical device — measures workload patterns for self-awareness. See [compliance notes](../docs/WORKLOAD_TELEMETRY_RESEARCH_DIRECTION.md#7-security--compliance-discussion).

## Richer Cursor adapter path

The `mcp-adapter/` directory and [CURSOR_ADAPTER_PLAN.md](./docs/CURSOR_ADAPTER_PLAN.md) describe Phase 2: capture real agent workload events (`ai_prompt_submitted`, `ai_file_edit`, `agent_loop_long`, etc.) into the shared Ascenda model — no Cursor-specific schema.

## Roadmap

| Phase | Scope |
| --- | --- |
| Phase 1 | Editor + terminal + pairing (current) |
| Phase 2 | MCP / hooks adapter for agent events |
| Phase 3 | Backend personalised workload score integration |
