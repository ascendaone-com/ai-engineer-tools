# Ascenda Agent MCP

MCP server exposing `ascenda_emit_work_signal` — the one submission interface any agent host can call to report an **agent-observed** work-friction pattern.

Part of [ai-engineer-tools](../). See the [Tool Pairing API Reference](../api-docs/TOOL_PAIRING_API_REFERENCE.md#semantic-event-rules) for the wire-level rules this server enforces, and [`ascenda-cursor-extension/mcp-adapter`](../ascenda-cursor-extension/mcp-adapter/README.md) for the earlier scaffold this supersedes for the semantic-signal case (that scaffold's broader `ascenda_emit_workload_event` generic emitter is a separate, still-open concern).

## What this is for

The deterministic hook adapters (`ascenda-claude-code-hooks`, `ascenda-codex-hooks`) map host lifecycle events — a tool call, a compaction, a long session — to the telemetry catalog. They cannot see **semantic** patterns: an agent circling the same problem with three different approaches, drift from a goal the user stated at the start of the session, a session that has gone quiet without resolution. Nobody can derive those from a single host event; they require an agent reading the interaction.

This server is where that reading becomes a wire event, and it is deliberately narrow:

- **One tool.** `ascenda_emit_work_signal`, nothing else.
- **Six event types**, exactly `SEMANTIC_WORK_SIGNAL_EVENT_TYPES` from `@ascenda-one/tool-contract`: `approach_churn_detected`, `goal_drift_detected`, `progress_stalled`, `progress_recovered`, `session_intention_declared`, `scope_change_declared`.
- **Report the pattern, not a diagnosis.** The schema has no field for the model's read of the user's emotional state, and no severity field a caller can set — severity is the backend's own judgement against the person's baseline, never the emitter's.
- **Never raw content.** No field accepts free text. `taskFingerprint` must be hash-shaped; `evidenceCounts`/`evidenceFlags` keys must be bare identifiers, not sentences — both enforced by the schema itself, not by a length heuristic on the way out.

## Architecture

```text
Agent (Claude Code / Cursor / other MCP host)
  -> ascenda-agent-mcp (stdio, this package)
  -> AscendaEventSender.sendSemanticSignal (@ascenda-one/tool-kit)
  -> Ascenda backend (POST /v1/tool-events, consentScope: semantic_work_signals)
  -> paired anonymous Ascenda user
  -> Weekly Loop trigger evaluation / work-map (asc-core-be)
```

Reuses the same pairing model as the hooks and IDE extensions — same `toolInstallationId` + `eventWriteToken`, same token file convention — but **does not mint its own tool type**. See `src/config.ts`: this process is host-agnostic (the same binary runs under Claude Code or Cursor), so it refuses to guess a prefix the way `ascenda-claude-hook`/`ascenda-codex-hook` do. Passing an id that already contains `:` (i.e. the exact value your existing pairing shows) reuses that pairing's token file; a bare id is rejected rather than silently minting a second, unpaired tool identity.

## Installation

### Prerequisites

- Node.js **20+**
- A paired Ascenda `toolInstallationId` + `eventWriteToken` — pair first via the Claude Code hooks, Cursor extension, or [pairing-sim `e2e`](../ascenda-pairing-sim/), then reuse that pairing here.
- The paired lease must include the `semantic_work_signals` consent scope. `ide_telemetry` alone does not cover these six event types (see the Tool Pairing API Reference).

### Build

```bash
# from the repo root
npm install
npm run build:shared
cd ascenda-agent-mcp
npm run build
```

### Configure your MCP host

Add to your Claude Code (`.mcp.json`) or Cursor MCP config — see [`examples/mcp.json`](./examples/mcp.json):

```json
{
  "mcpServers": {
    "ascenda-agent": {
      "command": "node",
      "args": ["/absolute/path/to/ascenda-agent-mcp/dist/cli.js"],
      "env": {
        "ASCENDA_TOOL_INSTALLATION_ID": "claude_code:abc123",
        "ASCENDA_API_BASE_URL": "https://api.ascenda.one"
      }
    }
  }
}
```

Use the **exact** `toolInstallationId` your existing pairing already shows (it contains a `:`). `ASCENDA_EVENT_WRITE_TOKEN` is read from the same token file the hook/extension already wrote (`~/.ascenda/tokens/...`); set `ASCENDA_EVENT_WRITE_TOKEN` directly only if you have no prior pairing to reuse.

## What calls this tool

This server is the transport. It does not decide *when* a semantic pattern is worth reporting or *what* the six event types mean in practice — that judgement belongs to an agent skill reading the actual interaction. See [`ascenda-agent-skills`](../ascenda-agent-skills/) for the Claude Code skill / Cursor rules that call this tool, including the emission criteria and the vocabulary the skill is written never to use.

## Privacy

- Metadata-only, always (`privacyMode: "metadata_only"`) — never negotiable per call.
- No field in the schema accepts arbitrary text. `evidenceCounts`/`evidenceFlags` are closed to bare-identifier keys with numeric/boolean values only.
- `taskFingerprint` must already be a hash when it reaches this tool; this server does not compute it and never sees the task itself.
