# Ascenda IDE Extension (VS Code & Cursor)

Privacy-first extension for pairing a local developer tool installation with the Ascenda mobile app and sending AI workload telemetry events. One extension, one package identity (`ascenda-one.ascenda`) published to both the VS Code Marketplace and Open VSX — Cursor installs the same VSIX from Open VSX. The host is detected at runtime (`packages/ide-extension-core/src/host.ts`); there is no separate Cursor build.

Part of [ai-engineer-tools](../). See the [Workload Telemetry Research Direction](../docs/WORKLOAD_TELEMETRY_RESEARCH_DIRECTION.md) and [Tooling Phase Alignment](../docs/TOOLING_PHASE_ALIGNMENT.md).

## Role in workload detection (Phase 1)

This package is the **baseline IDE telemetry** source for both hosts. It contributes objective signals to the prototype workload function:

| Workload input | How this extension contributes |
| --- | --- |
| FocusDuration | Session boundaries, file-save cadence (partial proxy) |
| TaskSwitchRate | `active_editor_changed` events (partial proxy) |
| Interruptions | Session end, after-hours flag |
| AIInteractionLoad | Not yet — use [Claude hooks](../ascenda-claude-code-hooks/) or the [Cursor MCP adapter plan](../docs/CURSOR_ADAPTER_PLAN.md) |
| Verification / friction | Terminal test/lint/build/typecheck classification, failure outcomes |

Subjective strain (NASA-TLX-style check-ins), meeting load, and personalised baselines are handled by the Ascenda app and backend — not this extension.

### Running in Cursor

Identical telemetry to VS Code, reported with `source: cursor_mcp` /
`toolType: cursor_mcp` — detected automatically, no separate install or
config. Cursor is treated as a first-class telemetry producer for AI
engineers; for richer AI-agent signals today, also run [Claude Code
hooks](../ascenda-claude-code-hooks/). Deeper agent-level capture
(prompts, tool calls, correction loops) is tracked as a separate future
surface — see [CURSOR_ADAPTER_PLAN.md](../docs/CURSOR_ADAPTER_PLAN.md) — not
a second editor extension.

## What this version provides

- Common Ascenda telemetry event types
- Privacy-safe editor activity events
- Terminal command classification where VS Code shell integration exposes execution events
- Session start/end events
- After-hours AI session signalling
- Event queue + periodic flush
- Loose-coupled pairing model:
  - extension stores only `toolInstallationId`
  - extension stores scoped `eventWriteToken`
  - backend privately maps tool → anonymous app user → push device

## Loose coupling invariant

The extension does **not** know:

- user email
- phone number
- real name
- Ascenda app user ID
- mobile push token
- organisation identity

The extension only knows:

- `toolInstallationId`
- scoped `eventWriteToken`

The backend resolves:

```text
toolInstallationId
  -> anonymous Ascenda user
  -> active app device
  -> APNs / FCM push token
```

## Installation (VS Code)

### Prerequisites

- [Visual Studio Code](https://code.visualstudio.com/) **1.90+**
- Node.js **20+** and npm
- Access to an Ascenda Development or production API (see pairing below)

### 1. Build the extension

```bash
# from the repo root — the workspace install resolves @ascenda-one/* locally
npm install
npm run build:shared

cd ascenda-vscode-extension-telemetry
npm run compile
```

### 2. Run in Extension Development Host (recommended for local/dev)

1. Open **this folder** (`ascenda-vscode-extension-telemetry`) as the workspace in VS Code  
   (`File → Open Folder…`).
2. Press **F5** (or **Run and Debug → Run Ascenda Extension**).  
   VS Code launches a second window: the **Extension Development Host**.
3. In that host window, open any project folder you want to work in.
4. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

```text
Ascenda: Connect App
```

5. Confirm pairing with the Ascenda mobile app, or with [ascenda-pairing-sim](../ascenda-pairing-sim/) for Dev backends:

```bash
# In another terminal (DevAuth — see pairing-sim README)
ascenda-pairing-sim confirm-device-code <6-digit-code>
```

6. Verify with **Ascenda: Show Status** and **Ascenda: Send Test Signal**.

### 3. Point at the right API

In the Extension Development Host (or User Settings), set:

| Setting | Example |
| --- | --- |
| `ascenda.apiBaseUrl` | `https://app-asc-dev-api-aue.azurewebsites.net` (Dev) or `http://localhost:5002` (local BE) or `https://api.ascenda.one` (prod) |

Settings UI: **Preferences → Settings → search “Ascenda”**, or in `settings.json`:

```json
{
  "ascenda.apiBaseUrl": "https://app-asc-dev-api-aue.azurewebsites.net",
  "ascenda.telemetry.enabled": true
}
```

### 4. Optional: install as a local VSIX (daily driver)

```bash
npm install -g @vscode/vsce
npm run compile
npx vsce package --no-dependencies
code --install-extension ascenda-0.0.2.vsix
```

**On macOS**, if `code` is not on your PATH, first run **Cmd+Shift+P → Install 'code' command in PATH** in VS Code, or use the full path: `/Applications/Visual\ Studio\ Code.app/Contents/Resources/app/bin/code --install-extension ascenda-0.0.2.vsix`.

In Cursor, use **Extensions → … (Views and More Actions) → Install from
VSIX…** and select the same file, or, if `cursor` is on your PATH:

```bash
cursor --install-extension ascenda-0.0.2.vsix
```

**On macOS**, the easiest approach is the menu: **Extensions → Install from VSIX** and select the built file directly.

Reload the editor, then run **Ascenda: Connect App**. Uninstall with Extensions view → Ascenda → Uninstall.

### Commands

| Command | Purpose |
| --- | --- |
| `Ascenda: Connect App` | Start QR/code pairing |
| `Ascenda: Disconnect App` | Clear local token (local only) |
| `Ascenda: Send Test Signal` | Smoke-test ingest |
| `Ascenda: Simulate Context Compression` | Manual catalog event |
| `Ascenda: Simulate Context Pressure High` | Manual catalog event |
| `Ascenda: Show Status` | Paired / token / tool id |

### Backend contract

See [TOOL_PAIRING_API_REFERENCE.md](../api-docs/TOOL_PAIRING_API_REFERENCE.md). Tool-side routes use `/v1` (not `/api`).

## Privacy defaults

Metadata-only telemetry. Does not send source code, raw prompts, AI responses, file names, branch names, terminal output, or repository names.

May send:

- event type, timestamp, workspace hash, session ID
- language ID, file extension/type, changed line count bucket
- terminal command class (test/lint/build/typecheck/run/git/install)
- success/failure/cancelled outcome
- after-hours flag

Disallowed metadata keys are stripped server-side. See [compliance notes](../docs/WORKLOAD_TELEMETRY_RESEARCH_DIRECTION.md#8-primary-compliance-requirements).

## Roadmap

| Phase | Scope |
| --- | --- |
| Phase 1 | Editor + terminal signals, pairing contract alignment, consent scope on ingest |
| Phase 2 | Copilot OTEL adapter (if available) |
| Phase 3 | Consume backend personalised baseline deltas in status UX |

## Production QR note

For convenience, this demo renders the QR using a public QR image endpoint. For production, use local QR generation or a backend-provided QR data URI.
