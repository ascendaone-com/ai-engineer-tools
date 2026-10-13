# @ascenda-one/agent-events

**Experimental, v0.** A small, open description of what a coding agent did:
a session started, a prompt went in, a tool ran and failed, the agent stopped
to wait for you. Ascenda's collectors for Claude Code, Codex, Cursor, Gemini
CLI, Windsurf and VS Code write these events to a file on your machine. This
package is the JSON Schema and TypeScript types for them, with a reader for
the file.

You don't need an Ascenda account to use any of it. Nothing here sends data
anywhere.

## Get events

Install a collector without pairing. It writes every event to
`~/.ascenda/events.jsonl`:

```bash
npx @ascenda-one/claude-code-hooks setup --no-pair
npx @ascenda-one/codex-hooks setup --no-pair
```

Cursor, Gemini CLI and Windsurf work the same way (`@ascenda-one/cursor-hooks`,
`@ascenda-one/gemini-hooks`, `@ascenda-one/windsurf-hooks`). A paired install
keeps the file too if you ask:

```bash
npx @ascenda-one/claude-code-hooks setup --event-log            # ~/.ascenda/events.jsonl
npx @ascenda-one/claude-code-hooks setup --event-log ~/x.jsonl  # somewhere else
npx @ascenda-one/claude-code-hooks setup --event-log off        # stop
```

`ASCENDA_EVENT_LOG_FILE` overrides the saved setting for one shell. The file is
owner-only (`0600`) and rotates at 5 MB to `events.jsonl.1`.

## Read events

Each line of the file is one JSON object. The `event` field is the contract.
Everything else on the line is the collector's own and can change in any
release.

```js
import fs from "node:fs";
import { parseEventLogLine } from "@ascenda-one/agent-events";

for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  const event = parseEventLogLine(line);
  if (event?.kind === "tool.failed") console.log(event.time, event.agent, event.tool);
}
```

`parseEventLogLine` skips blank lines, a half-written last line, and lines from
collectors older than v0. There's a complete example, with no dependencies at
all, in [examples/local-event-reader](../../examples/local-event-reader/).

## The event

```json
{
  "schema": "agent-event/v0",
  "id": "0d7b1e2a-5f3c-4a8e-9b1d-2c3e4f5a6b7c",
  "time": "2026-10-10T03:14:07.512Z",
  "utcOffsetMinutes": 600,
  "agent": "claude_code",
  "kind": "tool.completed",
  "sessionId": "7f0c…",
  "tool": "Edit",
  "outcome": "success",
  "durationBucket": "0-1m",
  "projectHash": "b41e…",
  "collectorVersion": "0.1.34",
  "sourceType": "ai_file_edit"
}
```

| Field | |
| --- | --- |
| `schema` | Always `agent-event/v0`. |
| `id` | Unique per event. The same id twice is the same event. |
| `time` | When it happened, UTC. |
| `utcOffsetMinutes` | How far the machine's clock was ahead of UTC. |
| `agent` | `claude_code`, `codex`, `cursor`, `gemini_cli`, `windsurf` or `vscode`. A new agent sends its own name. |
| `kind` | What happened. See below. |
| `sessionId` | The agent's own session id, when it gives one. |
| `subagentId` | Set inside a subagent, and on its start and stop. |
| `tool` | The tool's name as the agent reports it, on `tool.*` kinds. |
| `outcome` | `success`, `failure` or `cancelled`, when the collector could tell. |
| `durationBucket` | `0-1m`, `1-5m`, `5-10m`, `10-30m`, `30-60m` or `60m+`. Never an exact time. |
| `projectHash` | A salted hash of the project. The salt never leaves the machine. |
| `repoKey` | The repository, as a digest of its GitHub `owner/repo`. See [Matching a session to a pull request](#matching-a-session-to-a-pull-request). |
| `branchKey` | The branch, as a digest. Set on each event, off the default branch. Same section. |
| `promptId` | The agent's own id for the prompt a turn answers, when it gives one. Events of one turn share it. |
| `vcsAction` | On `tool.completed`, when the call was a version-control step: `commit`, `push`, `pr_created` or `pr_merged`. |
| `reason` | On `agent.waiting`, why the agent stopped: `permission`, `idle` or `other`. |
| `model` | On `session.started`, the model the agent reported, when it did. |
| `collectorVersion` | The collector that wrote it. |
| `sourceType` | The collector's internal name for the event. For debugging only; not part of the contract. |

Kinds: `session.started`, `session.ended`, `prompt.submitted`, `tool.started`,
`tool.completed`, `tool.failed`, `turn.completed`, `agent.waiting`,
`context.compacted`, `subagent.started`, `subagent.stopped`, `other`.

Not every agent reports every field either. Today the keys, `promptId`, `vcsAction`, `reason` and `model` come from the Claude Code collector, and the others will follow.

Not every agent reports every kind. Each collector's README lists the hooks it
registers, and an agent without a hook for something can't report it.

Events never contain prompt text, file contents, file names, command lines or
command output. That's a rule for v0 and for every version after it.

## Matching a session to a pull request

`projectHash` is salted on each machine, so it can't be matched to anything
outside it. `repoKey` and `branchKey` can. They're the same digests Ascenda's
GitHub collector puts on pull request events, so a session and a PR that name
the same repository and head branch carry the same pair.

- `repoKey` is a 32-bit FNV-1a digest (8 hex characters) of the lowercased
  `owner/repo`. `branchKey` is a 64-bit one (16 characters) of the lowercased
  `owner/repo`, a newline, and the branch name as git spells it.
- A session can move between branches, so `branchKey` is set on each event, not
  once per session. Match on the key and on the session overlapping the PR's
  open window, because a branch called `fix` gets reused.
- On a fork, the checkout's `origin` is the fork. Match against the PR's head
  repository, not the base.
- Only github.com remotes get keys. There's no `branchKey` on the repository's
  default branch, where every session would share one.

**The trade-off.** Neither key is salted. They're digests, not secrets: anyone
who holds one can check a guess like "branch `feat/x` of `acme/api`", and for a
public repository those names are public. It's the trade-off the GitHub
collector's repository digest already makes, with a branch name added. If you
don't want them on your events, turn them off for this machine:

```bash
npx @ascenda-one/claude-code-hooks setup --repo-keys off
```

`ASCENDA_REPO_KEYS=off` does the same for one shell. The names themselves never
leave the machine. The digests do.

## Compatibility

v0 is experimental. We expect to change it once people other than us have
built on it, and we'd rather learn what's missing than promise stability too
early.

While it's v0:

- **New fields and new kinds can appear in any release.** Ignore fields you
  don't know, and read an unknown `kind` as `other` (`normaliseKind` does
  this).
- **Renames and removals are possible.** Each one is listed in the release
  notes of the release that makes it, under the package name.
- **`schema` stays `agent-event/v0`** until v1.
- **`sourceType` and everything outside `event` on a log line** can change
  without notice.

v1 will come out of what v0 users tell us. When it ships, `schema` becomes
`agent-event/v1`, and from then on a field is only removed or renamed under a
new major version.

The JSON Schema is
[`schema/agent-event.v0.schema.json`](./schema/agent-event.v0.schema.json),
also importable as `@ascenda-one/agent-events/schema/agent-event.v0.schema.json`.

## Feedback

If you're building on these events, open an issue on
[ascendaone-com/ai-engineer-tools](https://github.com/ascendaone-com/ai-engineer-tools/issues)
with what you're making and what's missing. That's what shapes v1.

## License

Apache-2.0. Copyright 2026 Ascenda One Pty Ltd.
