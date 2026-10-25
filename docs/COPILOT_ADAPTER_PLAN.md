# Copilot Adapter Plan

GitHub Copilot's agent runs in two places on a developer's machine: the
Copilot CLI, and VS Code's chat. VS Code's chat history is already read by
`ascenda-history-import` (the `chatSessions` fold in
`src/extractors/vscode.ts`). This plan covers the rest: a hooks adapter for
live events, and an extractor for the CLI's own session log.

Status:

- **CLI extractor: built** (#199). A dry run against a real store read eight
  sessions back to March.
- **VS Code chat fields: built** (#200).
- **Hooks adapter: built, not merged** (#198). It waits on the runtime check
  under "Where hooks reach a session from".

Unlike the other plans here, this one is written against a real store. One
CLI session from October 2026 and six older ones were read on a developer
machine. Where they disagree with GitHub's published hook reference, the
observed shape is recorded below.

## Order of work

The extractor comes first, as it does for Pi.

Both stores keep everything. The CLI's session logs go back to March with no
purge observed, so a live event the hooks miss is still on disk the next day.
The live rail's deadline argument doesn't apply. What's left is cost and
value, and both favour the extractor:

- Its input exists today, so fixtures can be written from real files.
- It carries model, token and posture fields the hooks don't (see the table
  under Rail 2).
- It backfills every CLI session already on the machine. Hooks start from the
  day they're installed.

1. CLI extractor, fixtures from the real store.
2. Answer the registration questions under Rail 1 on a clean machine.
3. Hooks package, mapping doc, fixtures.

Nothing lands in the README's coverage tables until the code behind the row
runs.

## Rail 1: hooks

The CLI reads command hooks from `~/.copilot/hooks/*.json` for a user and
`.github/hooks/*.json` for a repository. A file is `version: 1` with a map of
event names to entries:

```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      { "type": "command", "bash": "~/.ascenda/bin/ascenda-copilot-hook postToolUse", "timeoutSec": 5 }
    ]
  }
}
```

Each event has a camelCase name (`postToolUse`) and a PascalCase alias
(`PostToolUse`). The alias switches the payload to snake_case and Claude
Code's tool names. Register the camelCase names: they're the CLI's own, and
`postToolUseFailure`, `subagentStart` and `errorOccurred` exist only there or
carry more there.

Timeouts fail open for every event, `preToolUse` included. That matches how
every adapter here already behaves.

### Where hooks reach a session from

The October session's hooks didn't come from either path above. Its
`workspace.yaml` names `client_name: vscode-agent-host`: VS Code started the
CLI as its agent host, and the host loaded VS Code's agent plugins from
`~/Library/Application Support/Code/agentPlugins/`. One of those plugins, C#
Dev Kit's, registers a `PostToolUse` hook.

That hook is the 14 failures in the session's 23 hook runs. Every
`postToolUse` run exited with code 126, permission denied. The plugin's copy
in `agentPlugins/` has no execute bit on its script, and the plugin's command
`exec`s that script directly. The other nine runs, on six other events,
succeeded in under 10 ms.

Two consequences for this adapter:

- **Never `exec` a file from a directory the host copied.** Our command runs
  the binary under `~/.ascenda/bin`, which setup installs and marks
  executable, so the user-level file is safe. If Ascenda ever ships as a
  Copilot plugin, its hook runs `node <script>`.
- **A user-level file may not reach every session.** Three cases need a
  check on a clean machine before the README claims coverage:
  - the standalone CLI reading `~/.copilot/hooks/`;
  - the CLI under VS Code's agent host reading the same directory;
  - VS Code's Local chat harness, whose own settings (`chat.useHooks`,
    `chat.hookFilesLocations`) are documented as separate from the
    Copilot-side ones.

### Observed payloads

The October session logs every hook's input in `events.jsonl`
(`hook.start`, `hook.end`), so these are what the CLI sent, not what the
reference says:

- **`preToolUse` is batched.** One call per batch of tool requests, with
  `{ sessionId, cwd, toolCalls: [{ id, name, args }] }`. No `timestamp`. The
  reference describes a single `toolName` and `toolArgs`.
- **`postToolUse` is per call.** `{ sessionId, timestamp, cwd, toolName,
  toolArgs, toolResult }`, where `toolResult` has `resultType`,
  `textResultForLlm` and `toolTelemetry`. It has no call id, so a post can't
  be joined to its pre by id.
- **`timestamp` is epoch milliseconds**, an integer. The reference says ISO
  8601 for the snake_case payloads and doesn't say for camelCase.
- **`sessionStart` fired after `userPromptSubmitted`** in a new session. A
  mapper must not assume the session opens before its first prompt.

### What we register

| Copilot hook | Condition | Ascenda event |
| --- | --- | --- |
| `sessionStart` | | `create_focus_session` |
| `sessionEnd` | | `recovery_offline_period` |
| `userPromptSubmitted` | always | `ai_prompt_submitted` |
| `userPromptSubmitted` | prompt looks like a correction | `+ ai_correction_prompt` |
| `preToolUse` | one per element of `toolCalls` | `ai_tool_call_started` |
| `postToolUse` | write tool | `ai_file_write` / `ai_file_edit` |
| `postToolUse` | shell + verification command | `editor_verification_activity` |
| `postToolUse` | otherwise | `ai_tool_call_completed` |
| `postToolUseFailure` | shell + verification command | `compile_error` |
| `postToolUseFailure` | otherwise | `ai_tool_call_failed` |
| `preCompact` | | `context_compression_auto` |
| `subagentStart` / `subagentStop` | | `subagent_started` / `subagent_stopped` |
| `agentStop` | turn ≥ 30m | `agent_loop_long` |
| `agentStop` | every turn, after the above | `ai_turn_completed` |

Left unregistered:

- **`userPromptTransformed`** repeats the prompt hook with the expanded text.
  Registering both would count each prompt twice.
- **`permissionRequest`** has no documented input, and the CLI log shows the
  posture travels elsewhere (Rail 2).
- **`notification`** carries UI text with no work signal.
- **`errorOccurred`** has no catalog event that fits. It's worth a second
  look once a real error has been captured.

The turn-duration check on `agentStop` needs the turn's start. The prompt
hook records it; `agentStop` reads it back.

Observed tool names so far are `view`, `rg` and `glob`. The write and shell
tool names come from the first session that edits a file and runs a command.
Until then the write and verification rows stay unmapped.

### Gaps the hooks can't fill

- **Model.** No payload names one. The extractor has it.
- **Tokens.** None in any hook. The extractor has them.
- **Permission posture.** No `permission_mode` equivalent in a hook, so the
  live rail sends no `autonomyMode`, the same as the VS Code extension and
  for the same reason: nothing true to send.

### Wiring

The settings file is the one new shape. Every adapter so far merges an entry
into a file the host owns. Copilot loads every `*.json` in its hooks
directory, so setup writes `~/.copilot/hooks/ascenda.json` whole and
uninstall deletes it. `CliAgentSetupSpec` needs a flag for an owned file;
`settingsPath`, `entry` and `commandOf` otherwise fit as they are.

New package: `ascenda-copilot-hooks`, published as `@ascenda-one/copilot-hooks`,
binary `ascenda-copilot-hook`, `toolType: cli_agent`, `host: copilot_cli`,
`source: cli_agent`. That keeps the backend unchanged: every event above is
already in the catalog. `copilot_otel` stays reserved for an OpenTelemetry
route, which this isn't.

## Rail 2: the CLI's session log

Each session is a directory under `~/.copilot/session-state/<session-id>/`:

- `events.jsonl`, one typed event per line: `{ type, data, id, timestamp, parentId }`.
- `workspace.yaml`: `cwd`, `git_root`, `branch`, `client_name`, timestamps.

Older sessions also left a flat `<session-id>.jsonl` beside the directories,
in the same event shape. `~/.copilot/session-store.db` is SQLite (`sessions`,
`turns`, a search index), last written in July. Read the directories first;
check whether the database holds anything they don't before reading it.

### Version

`session.start` carries `version: 1`, `producer: "copilot-agent"` and
`copilotVersion`. Sessions before October record `copilotVersion: "unknown"`.
Dispatch on `version` (design rule 3); a session without a `session.start`
becomes `historical_unparsed`.

### What it yields

| Signal | Where it is | Ascenda use |
| --- | --- | --- |
| Tool calls | `tool.execution_start` (`toolCallId`, `toolName`, `model`) | `ai_tool_call_started`, one per call (design rule 5) |
| Tool outcome | `tool.execution_complete.success` | failure counts |
| Prompts | `user.message`, counted | prompt count; content never read |
| Model | `assistant.message.model`, `session.start.selectedModel`, `session.auto_mode_resolved.chosenModel` | model mix; `selectedModel: "auto"` is `router:auto` |
| Tokens | `session.shutdown.tokenDetails` and per-model `modelMetrics` | input, cache read, cache write, output |
| API time | `session.shutdown.totalApiDurationMs` | agent-supervising time, beside gap-split active minutes |
| Lines changed | `session.shutdown.codeChanges` | `linesAdded`, `linesRemoved` |
| Posture | `permission.requested.agentMode`, `.permissionMode` | `autonomyMode`, mirroring the CLI's own words |
| Client | `workspace.yaml` `client_name` | standalone CLI or VS Code's agent host |
| Project | `workspace.yaml` `git_root`, else `cwd` | salted digest |

Token totals only arrive in `session.shutdown`. A session that was killed has
none, and the extractor leaves tokens off; it doesn't estimate them.

Content fields the extractor never reads: `user.message.content` and
`transformedContent`, `assistant.message.content`, `reasoningText` and
`encryptedContent`, `tool.execution_complete.result`, and `workspace.yaml`'s
`name`, which is the session's first prompt.

`hook.start` and `hook.end` stay out of the shipped events. A local `doctor`
can read them: they're how the 126 failures above were found.

## Also: VS Code chat sessions

Built in #200. The existing `chatSessions` fold reads every recent session correctly. It
skips fields the newer requests carry: `promptTokens`, `completionTokens`,
`copilotCredits`, `modelConfiguration`, and the per-request timings
(`elapsedMs`, `result.timings`). Today every tool call takes its request's
timestamp; the timings would place each call at its own time. That's a
small change to
`src/extractors/vscode.ts`, separate from this plan's two packages.
