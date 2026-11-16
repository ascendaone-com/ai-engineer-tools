# Claude Code edge cases

A single `.jsonl` is placed at `projects/<slug>/<sessionId>.jsonl` by the
test. A directory is already shaped like a snapshot root.

Figures are what a correct reader reports.

| Case | What it pins | Expected |
|---|---|---|
| `resume-replay.jsonl` | A resume writes the first five lines again, same `uuid`s, then carries on with one new tool call. Repeats add nothing. | `promptCount` 1, `mainThreadToolCallCount` 3, `toolResultErrorCount` 1, `toolFailureCount` 1, `assistantTurns` 3, `inputTokens` 30, `outputTokens` 300 |
| `fork-subagent/` | A forked subagent's transcript opens with three of its parent's lines. Only its own two lines are the subagent's work. | `subagentTranscripts` 1, `subagentToolCallCount` 1, `subagentAssistantTurns` 1, `mainThreadToolCallCount` 1, `toolFailureCount` 0 |
| `incomplete-final-record.jsonl` | The last line is cut mid-JSON. It's counted as unparsed and nothing else. | `unparsedLines` 1, `promptCount` 1, `mainThreadToolCallCount` 1, `assistantTurns` 2 |
| `malformed-between-valid.jsonl` | One invalid line sits between two valid ones. The lines around it still count. | `unparsedLines` 1, `promptCount` 1, `mainThreadToolCallCount` 1, `assistantTurns` 2 |
| `compaction-continues-session.jsonl` | A `compact_boundary` doesn't end the session. The summary line after it isn't a prompt. | `compactionCount` 1, `compactionAutoCount` 1, `compactionManualCount` 0, `syntheticPromptLines` 1, `promptCount` 2, `assistantTurns` 2 |

## Known to fail today

- `resume-replay.jsonl` reports 5 tool calls and 2 failures. Fix: [#220](https://github.com/ascendaone-com/ai-engineer-tools/pull/220).
- `fork-subagent/` reports 2 subagent tool calls. Fix: [#220](https://github.com/ascendaone-com/ai-engineer-tools/pull/220).
