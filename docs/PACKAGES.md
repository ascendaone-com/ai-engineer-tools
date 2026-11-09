# Packages

| Package | Published as | What it does |
| --- | --- | --- |
| [ascenda-claude-code-hooks](../ascenda-claude-code-hooks/) | `@ascenda-one/claude-code-hooks` (npm) | Claude Code hooks: prompts, tool calls, compaction, waits, subagents |
| [ascenda-codex-hooks](../ascenda-codex-hooks/) | `@ascenda-one/codex-hooks` (npm) | Codex CLI hooks, through Codex's `hooks.json` |
| [ascenda-cursor-hooks](../ascenda-cursor-hooks/) | `@ascenda-one/cursor-hooks` (npm) | Cursor agent hooks |
| [ascenda-windsurf-hooks](../ascenda-windsurf-hooks/) | `@ascenda-one/windsurf-hooks` (npm) | Windsurf Cascade hooks; the gaps in Windsurf's hook set are documented, not filled in |
| [ascenda-gemini-hooks](../ascenda-gemini-hooks/) | `@ascenda-one/gemini-hooks` (npm) | Gemini CLI hooks; the per-inference hooks are deliberately left unregistered |
| [ascenda-copilot-hooks](../ascenda-copilot-hooks/) | `@ascenda-one/copilot-hooks` (npm) | GitHub Copilot CLI hooks. Which Copilot runtimes load the hooks file hasn't been checked yet |
| [ascenda-vscode-extension-telemetry](../ascenda-vscode-extension-telemetry/) | `ascenda-one.ascenda` (VS Code Marketplace and Open VSX) | The editor extension for VS Code and Cursor: editor activity, terminal classification, sessions |
| [ascenda-agent-skills](../ascenda-agent-skills/) | `ascenda@ascenda-one` (Claude Code plugin) | The plugin: the work-signals skill, the hooks and the MCP server in one install, plus the Cursor rule |
| [ascenda-agent-mcp](../ascenda-agent-mcp/) | `@ascenda-one/agent-mcp` (npm) | MCP server exposing `ascenda_emit_work_signal`, for patterns only the agent can see |
| [ascenda-history-import](../ascenda-history-import/) | `@ascenda-one/history-import` (npm) | Reads the AI-tool history already on your machine (Claude Code, Codex, Cursor, VS Code, git) into a baseline |
| [ascenda-github-collector](../ascenda-github-collector/) | `@ascenda-one/github-collector` (npm) | Your own review load and pull request activity from a code forge, never anyone else's |
| [ascenda-pairing-sim](../ascenda-pairing-sim/) | not published | Stands in for the app in pairing tests: confirm, list, revoke, end to end |
| [ascenda-dev-server](../ascenda-dev-server/) | not published | A local mock of the `/v1` pairing and ingest API, so any tool runs with no backend. Binds to `127.0.0.1` |

## Shared packages

The repo is an npm workspace. The tools above are thin shells over these:

| Package | Role |
| --- | --- |
| [packages/tool-contract](../packages/tool-contract/) | The event catalog, DTOs and constants, declared once. Mirrors the [Tool Pairing API Reference](../api-docs/TOOL_PAIRING_API_REFERENCE.md) |
| [packages/tool-kit](../packages/tool-kit/) | The shared runtime: `setup`, `status` and `doctor` for the CLI agents, the hook launcher, the live signal, the command classifier, the token store and the `/v1` client |
| [packages/ide-extension-core](../packages/ide-extension-core/) | The single extension implementation; whether it runs in VS Code or Cursor is detected at runtime |
| [packages/agent-events](../packages/agent-events/) | `@ascenda-one/agent-events` on npm. The public event format, v0 and experimental: a JSON Schema, types and a log reader |
