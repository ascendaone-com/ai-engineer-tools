# The event format

Install any agent's hooks with `--no-pair` and every event lands in
`~/.ascenda/events.jsonl`. Each line's `event` field follows an open, versioned
format: which agent, what happened, which tool, how it ended. It's documented
in [packages/agent-events](../packages/agent-events/), and
[examples/local-event-reader](../examples/local-event-reader/) is a
dependency-free script that reads it. Build a dashboard, feed your own tool,
or check what the collectors record. None of it needs an Ascenda account.

The format is v0 and experimental. If you build on it, tell us what's missing
in an issue: that's what decides v1.

## What each agent can report

The agents expose different hooks, so they can't all say the same things. A
gap here is the agent's hook set, not something we infer around.

| | Claude Code | Codex | Cursor | Gemini CLI | Windsurf |
| --- | --- | --- | --- | --- | --- |
| Working (prompts, tool calls) | yes | yes | yes | yes | yes |
| Waiting on you (an approval) | yes | yes | no hook | yes | no hook |
| Context compaction | yes | yes | yes | yes | no hook |
| Quit mid-turn ends the session | yes | no hook | yes | yes | no hook |

Each package's README lists its events in full.
