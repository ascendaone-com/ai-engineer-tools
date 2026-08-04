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

## Install

### Recommended: the Claude Code plugin

One command installs this adapter, the work-signals skill, and the MCP server
together — already wired to every lifecycle event, no settings file to edit:

```bash
claude plugin marketplace add ascendaone-com/ai-engineer-tools
claude plugin install ascenda@ascenda-one
```

From inside a session, use `/plugin marketplace add …` then `/plugin install …`.
See [ascenda-agent-skills](../ascenda-agent-skills/) for what the bundle holds.

### Alternative: this adapter on its own

If you want the deterministic hooks without the skill or MCP server, the
published package runs with no clone and no build:

```bash
npx @ascenda-one/claude-code-hooks --help
```

Then wire the events yourself — see [Register hooks manually](#register-hooks-manually).

### Pair first (both routes)

Neither route sends anything until this machine is paired. This package shows
no QR code of its own; it reuses a pairing made elsewhere.

1. Install and pair the [Ascenda extension](../ascenda-vscode-extension-telemetry/)
   in VS Code or Cursor, then run **Ascenda: Connect App**.
2. Run **Ascenda: Show Status** and copy the tool installation id.
3. Export it where Claude Code will see it:

```bash
export ASCENDA_TOOL_INSTALLATION_ID="claude_code:<uuid>"   # or the cursor_mcp:… / vscode_extension:… id you already have
```

Add that to your shell profile (`~/.zshrc`, `~/.bashrc`) and restart Claude
Code. The write token is read from `~/.ascenda/tokens/`, written at pairing
time — you do not copy it separately.

> **This variable is required, not optional.** Without it every hook
> invocation exits with `Missing ASCENDA_TOOL_INSTALLATION_ID`. The adapter
> refuses to guess rather than silently mint a second, unpaired identity that
> would fragment your telemetry across two installations.

On a Dev backend with no phone, [pairing-sim](../ascenda-pairing-sim/) stands in
for the app:

```bash
cd ../ascenda-pairing-sim && npm run build
node dist/cli.js e2e --tool-type claude_code
```

Optional environment:

| Variable | Purpose |
| --- | --- |
| `ASCENDA_API_BASE_URL` | Backend to send to. Defaults to `https://api.ascenda.one`; use `http://localhost:5002` or the Azure Dev host for development |
| `ASCENDA_EVENT_WRITE_TOKEN` | Only if you have no prior pairing to reuse — normally the token file supplies this |
| `ASCENDA_EVENT_WRITE_TOKEN_FILE` | Override token file path (default `~/.ascenda/tokens/<toolInstallationId>`) |
| `ASCENDA_SESSION_ID` | Stable session id across hooks |
| `ASCENDA_WORKSPACE_HASH` | Opaque workspace hash if you set one |

On first run the CLI seeds `~/.ascenda/tokens/<toolInstallationId>` so
**tool-scoped renew** can persist rotated tokens without you editing anything.

### Register hooks manually

The plugin does this for you — this section is only for the standalone route.
Merge [`examples/settings.local.json`](./examples/settings.local.json) into
`.claude/settings.local.json` in a project, or into Claude Code's user settings
for machine-wide coverage:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks SessionStart" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks UserPromptSubmit" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PreToolUse" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PostToolUse" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PreCompact" }] }],
    "PostCompact": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PostCompact" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks Stop" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks Notification" }] }]
  }
}
```

### Verify

Start Claude Code in a project with hooks configured, submit a prompt or run a
tool, and confirm events reach the backend (or simply that the hook exits `0`).

Exit codes: `3` on auth failure (re-pair), `2` on missing consent (renew in the
Ascenda app). A telemetry failure never blocks your turn.

## Build from source

Not needed to use this — both routes above ship prebuilt. It is here because
"read what runs on your machine" is a fair thing to want from a telemetry tool.

```bash
# from the repo root (workspace install + shared packages first)
npm install
npm run build:shared

cd ascenda-claude-code-hooks
npm run build
npm link                 # or ./scripts/install-local.sh

which ascenda-claude-hook
ascenda-claude-hook      # prints usage when passed no hook name

npm run test:sample      # pipes a sample PostToolUse payload through the CLI
npm run test:compact
```

A local build exposes the binary as `ascenda-claude-hook` — substitute it for
`npx -y @ascenda-one/claude-code-hooks` in the hook config above. If it is not
on Claude Code's PATH, use an absolute path such as
`/Users/<you>/.nvm/versions/node/<ver>/bin/ascenda-claude-hook`.

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
