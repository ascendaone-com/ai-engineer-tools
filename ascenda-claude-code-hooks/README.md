# Ascenda Claude Code Hooks

Claude Code hooks adapter for Ascenda AI workload telemetry.

Part of [ai-engineer-tools](../). For what these measurements do and do not
establish, see [What this measures](../#what-this-measures-and-what-that-does-not-yet-prove).
Event mapping: [docs/CLAUDE_MAPPING.md](./docs/CLAUDE_MAPPING.md).

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

Neither route sends anything until this machine is paired:

```bash
npx -y @ascenda-one/claude-code-hooks pair
```

It prints a 6-digit code — confirm it in the Ascenda app under
**Connections → Ingest telemetry** — then saves the write token to
`~/.ascenda/tokens/` and prints the one line left to do by hand:

```bash
export ASCENDA_TOOL_INSTALLATION_ID="claude_code:<uuid>"   # printed by `pair`
```

Add that to your shell profile (`~/.zshrc`, `~/.bashrc`) and restart Claude
Code. The token itself is never copied around — every CLI tool reads it from
the file `pair` wrote. (The editor extension's pairing cannot be reused here:
its token lives in the editor's private secret storage.)

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
| `ASCENDA_WORKSPACE_HASH` | Override only. By default the hook derives this from the payload's own `cwd`: a machine-salted hash of the checkout folder's basename (never the path itself) |
| `ASCENDA_PROJECT_HASH` | Override only. Defaults to the salted hash of the canonical repository's basename — a git worktree folds into the repo it was created from |
| `ASCENDA_STATE_FILE` | Override the send journal path (default `~/.ascenda/state/<toolInstallationId>.json`) |
| `ASCENDA_DISABLE_FAILURE_NOTICE` | `true` silences the one-time in-session notice about a collector that has stopped delivering |

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
    "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PostToolUseFailure" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PreCompact" }] }],
    "PostCompact": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PostCompact" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks Stop" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks Notification" }] }]
  }
}
```

### Verify

```bash
npx -y @ascenda-one/claude-code-hooks doctor
```

`doctor` prints the installation id, the token's presence and age, the last
recorded send outcome, and the result of a live round trip against the real
ingest endpoint. It is the first thing to run when the Ascenda app shows a
connected tool that is not producing data.

A telemetry failure never blocks your turn: **every hook invocation exits `0`**,
including one that failed to send. Do not read the exit code — or stderr, which
Claude Code discards for a hook that exits `0` — as evidence of anything. Read
the journal instead.

### When the collector stops sending

Every send attempt — success included — is recorded to
`~/.ascenda/state/<toolInstallationId>.json`:

```json
{
  "lastAttemptAt": "2026-08-17T08:05:17.436Z",
  "lastSuccessAt": "2026-08-17T08:05:04.782Z",
  "lastOutcome": "auth_failed",
  "consecutiveFailures": 1,
  "httpStatus": 401,
  "errorCode": "invalid_token",
  "failingSince": "2026-08-17T08:05:17.436Z"
}
```

Successes are recorded deliberately. If only failures were written, an absent
journal would mean both "healthy" and "never ran" — and telling those apart is
the entire problem. A `lastAttemptAt` that is minutes old with
`"lastOutcome": "accepted"` is positive evidence of health; one that is hours
stale means the collector is not running at all, which is a different fault with
a different fix.

When an installation transitions into a failing state, the next `SessionStart`
or `PostToolUse` adds **one** line of context to the session naming the cause
and offering `doctor` and `pair`. It appears once per outage, not once per tool
call, and never repeats until the collector has recovered and failed again.

`lastSeenAt` in the Ascenda app cannot substitute for any of this: it cannot
distinguish a dead token from a night's sleep, because both are "no events".
Only the collector knows it tried and was refused.

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
PostToolUseFailure
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
PostToolUse Bash   -> editor_verification_activity / ai_tool_call_completed (success only)
PostToolUseFailure -> compile_error / ai_tool_call_failed
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

`consentScope: ide_telemetry` and `provenance: ai_work_telemetry` on every
event. Australian-hosted backend. Not a medical device — workload
self-awareness only, no diagnosis, no clinical claim. Consent is revocable from
the app at any time; after revocation ingest returns `401`.
