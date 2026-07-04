# ai-engineer-tools

Privacy-first developer telemetry and pairing tooling for Ascenda's AI engineer workload detection platform.

## Research direction

All packages align to the backend-agreed research foundation:

- Workload Telemetry Research Direction: NASA-TLX / human factors thesis, workload scoring, baselines, compliance, phased rollout
- [Tool Pairing API Reference](./api-docs/TOOL_PAIRING_API_REFERENCE.md) — pairing and event ingest contract

**Core thesis:** burnout is a lagging indicator. Ascenda measures workflow friction — context switching, AI prompt loops, verification burden, after-hours pressure — *before* overload is consciously recognised. Signals combine objective telemetry, subjective check-ins (app), and individual baselines (backend).

## Packages

| Package | Phase 1 role |
| --- | --- |
| [ascenda-vscode-extension-telemetry](./ascenda-vscode-extension-telemetry/) | VS Code IDE telemetry — editor activity, terminal classification, sessions |
| [ascenda-cursor-extension](./ascenda-cursor-extension/) | Cursor IDE telemetry + planned MCP/agent adapter |
| [ascenda-claude-code-hooks](./ascenda-claude-code-hooks/) | Claude Code agent hooks — prompts, tool calls, compaction, agent loops |
| [ascenda-pairing-sim](./ascenda-pairing-sim/) | Console app that simulates the mobile app for pairing tests (confirm / list / revoke / e2e) |

## Phase 1 data collection (this repo)

**In scope**

- IDE usage (VS Code / Cursor)
- Terminal test/build/lint signals
- Claude Code AI interaction load
- Metadata-only, hashed workspace identifiers
- Loose app pairing (QR / 6-digit code)

**Out of scope (backend / app / Phase 2+)**

- GitHub, Jira, Slack, Teams, calendar (backend activity-signals path)
- Wearables (Apple Health, Oura, Whoop, Garmin)
- Subjective NASA-TLX-style check-ins (Ascenda mobile app)
- Personalised baseline scoring (backend Phase 3)

## Quick start

Install instructions live in each package README:

| Tool | Install guide |
| --- | --- |
| VS Code | [ascenda-vscode-extension-telemetry § Installation](./ascenda-vscode-extension-telemetry/README.md#installation-vs-code) |
| Cursor | [ascenda-cursor-extension § Installation](./ascenda-cursor-extension/README.md#installation-cursor) |
| Claude Code | [ascenda-claude-code-hooks § Installation](./ascenda-claude-code-hooks/README.md#installation-claude-code) |
| Pairing sim (app stand-in) | [ascenda-pairing-sim § Installation](./ascenda-pairing-sim/README.md#installation-terminal--cli) |

Typical flow:

1. Install and **F5** the VS Code or Cursor extension; run **Ascenda: Connect App**.
2. Confirm with the mobile app or [ascenda-pairing-sim](./ascenda-pairing-sim/) (DevAuth on `localhost:5002` or `https://app-asc-dev-api-aue.azurewebsites.net` — never commit tokens).
3. Optionally install [Claude Code hooks](./ascenda-claude-code-hooks/) with the same `toolInstallationId` / `eventWriteToken`.
4. Events POST to Ascenda per the [API reference](./api-docs/TOOL_PAIRING_API_REFERENCE.md).

Without a phone:

```bash
ascenda-pairing-sim e2e --tool-type cursor_mcp
```

Happy path on Azure Dev has been verified: ingest, tool-scoped renew, `list`, and `revoke` (post-revoke ingest returns `401`).

## Privacy & compliance

Metadata-only by default. Not a medical device — measures workload patterns for self-awareness, not diagnosis or treatment. Australian Privacy Act / GDPR-aligned consent via `ide_telemetry` scope.

See [section 7–8 of the research direction](./docs/WORKLOAD_TELEMETRY_RESEARCH_DIRECTION.md) for full compliance notes.
