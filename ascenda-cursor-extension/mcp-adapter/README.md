# Ascenda Cursor MCP Adapter Scaffold

The Cursor-compatible extension is the Phase 1 installable tool. The MCP adapter is the Phase 2 agent-level telemetry bridge.

See [Workload Telemetry Research Direction](../../docs/WORKLOAD_TELEMETRY_RESEARCH_DIRECTION.md) §10 and [CURSOR_ADAPTER_PLAN.md](../docs/CURSOR_ADAPTER_PLAN.md). Phase 2 MCP events primarily feed `AIInteractionLoad` and workflow friction detection.

## Purpose

Expose Ascenda telemetry tools that Cursor agents can call when AI work becomes long, repetitive, high-context, or error-prone.

## Proposed MCP tools

### ascenda_emit_workload_event

Generic event emitter.

```json
{
  "eventType": "agent_loop_long",
  "severity": "medium",
  "metadata": {
    "durationBucket": "30-60m",
    "reason": "long_session",
    "privacyMode": "metadata_only"
  }
}
```

### ascenda_emit_context_pressure

Maps to `context_pressure_high` with source `cursor_mcp`.

### ascenda_emit_verification_activity

Maps to `ai_test_or_build_run` with source `cursor_mcp`.

## Authentication

The MCP server should not hold a user identity. It should use either the same `toolInstallationId` and `eventWriteToken` obtained through pairing, or a child token created by the Cursor extension for the local MCP process.

## Privacy

The MCP tools must default to metadata-only. Do not send prompts, responses, code, file names, repository names, or terminal output.
