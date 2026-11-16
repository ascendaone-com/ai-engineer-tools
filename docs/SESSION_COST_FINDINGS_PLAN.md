# Session Cost Findings Plan

Some sessions spend far more than their work needs, for reasons a person can
change in a minute: a premium model on every subagent, effort left at the top
setting, skills and MCP servers loaded into every session and never used,
fast mode on delegated work, context run deep instead of compacted. We
already read most of the evidence for these. This plan says what to ship from
the collector so the backend can name them, and the rules that keep a finding
honest. Line numbers are against `main` at `badbcf6`.

Status: not started. The collector part touches `claudeCode.ts`, so it lands
after `docs/CLAUDE_TRANSCRIPT_REPLAY_PLAN.md`.

## What a finding needs, and what we have

| Finding | Evidence needed | On the wire today | Missing |
|---|---|---|---|
| Premium subagents | each subagent's model class, the parent's | `primaryModel`, `modelTurns` (parent mix) | model per subagent |
| Effort set high | recorded effort per session | `primaryEffort`, `reasoningEffort` (#213) | nothing |
| Old model pinned | model slug and date | `primaryModel`, `modelTurns` | a reviewed table of replacements (backend) |
| Unused skills | skills listed into context, skills invoked | nothing | both counts |
| Unused MCP servers | servers loaded, servers whose tools were called | per-call `toolName` (truncated at 40 chars) | loaded count, used count |
| Fast mode on delegated work | per-turn speed, main vs subagent | nothing | fast-turn counts |
| Context run deep | per-request context size | `contextWindowPeakTokens`, `compactionCount` | turns above a depth |
| Cache rewrites | cache writes vs reads | `cacheCreationTokens`, `cacheReadTokens` | nothing (Claude); Codex writes arrive with the Codex plan |

What Claude Code transcripts record, checked on a developer machine in
November 2026 across 95 transcripts from three days:

- Speed: `message.usage.speed` on every assistant line, `"standard"` or
  `"fast"`.
- Skills listed: a `skill_listing` attachment carries `skillCount`, `names`
  and `isInitial`.
- Skills used: an `invoked_skills` attachment names the skills the Skill
  tool loaded.
- MCP servers: `mcp_instructions_delta` gives `addedNames` and
  `removedNames`.
- Deferred tools: `deferred_tools_delta` gives `addedNames`, `removedNames`,
  `failedMcpServers`, `pendingMcpServers` and `needsAuthMcpServers`.
- Agent types: `agent_listing_delta` gives `addedTypes` and `builtInTypes`.
- Subagent models: each subagent transcript's assistant lines carry their
  own `message.model`.

## Privacy line

Ship counts and class tokens. Never names. A skill, MCP server or agent name
can carry project or client vocabulary ("acme-billing-mcp"), so names stay on
the machine, the same rule `subagentReceipts.ts` follows for agent names
(lines 12-16). Model slugs already ship, through `modelTurns`.

## Collector changes (Claude Code extractor)

All in `ascenda-history-import/src/extractors/claudeCode.ts`, folded per
session, main thread unless stated. Register every key in
`packages/tool-contract/src/metricKeys.ts`, `readBy: ["backend"]`.

1. **Skills.** Track the latest `skill_listing` `skillCount` and the set of
   listed names (in memory only). Track invoked names from `invoked_skills`
   and from `Skill` tool calls' `input.skill`. Ship `skillsListed` (latest
   count), `skillsInvoked` (distinct invoked names that were listed), and
   `skillListingSeen: true`. A session with no `skill_listing` ships none of
   the three: we can't say a skill went unused if we never saw the list.
2. **MCP servers.** Apply `mcp_instructions_delta` adds and removes to a set
   of loaded server names. Derive the used set from tool calls named
   `mcp__<server>__<tool>`; read the raw name before `sanitizeToolName`
   truncates it. Ship `mcpServersLoaded`, `mcpServersUsed`,
   `mcpServersFailed` (from `failedMcpServers`), and `mcpListingSeen: true`.
   Same absent rule.
3. **Fast turns.** Count API messages (by the existing `messageKeyOf` key,
   so a message split over lines counts once) whose `usage.speed` is
   `"fast"`. Ship `fastTurns` and `subagentFastTurns`. Ship `speedSeen: true`
   once any line had the field, so 0 means "measured, none" and absence means
   "this build didn't record it".
4. **Subagent model class.** In `subagentReceipts.ts`, add `modelClass` to
   `SubagentReceipt`: the `classifyModelClass` result (from tool-kit, already
   imported by `ship.ts`) of the subagent's most frequent `message.model`.
   `ModelClass` has no tier, so add `PREMIUM_MODEL_CLASSES` beside
   `classifyModelClass` in `packages/tool-kit/src/modelClassifier.ts`
   (start with `anthropic:opus` and `anthropic:fable`; OpenAI and Google
   classes don't split by tier yet, so they're never premium). Add
   `premiumSubagents` to session metrics: subagents whose class is in that set. The app's Dart writer makes the same receipts
   (`claude_code_extractor.dart`); open the matching change there.
5. **Deep turns.** Count main-thread API messages whose context
   (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`)
   is above 200k and above 400k: `deepTurns200k`, `deepTurns400k`. Fixed
   cut points, so the backend can compare sessions without the raw series.

Codex: ship `fastTurns` only if rollouts record a speed tier; check
`turn_context` and `token_count` for one and note the finding here. Effort
already ships for Codex.

## Backend rules (asc-core-be, separate PR)

A finding is a claim about a person's setup, so it must hold up:

- **Fail closed.** Missing evidence can't produce a finding *or* a clean
  bill. A session without `skillListingSeen` says nothing about skills. A
  week is "clean" on a finding only when every session in it was measured
  for it.
- **Never inferred.** "Effort set high" fires on a recorded effort, never on
  a guess from token counts.
- **Repeat before naming.** A finding needs the pattern in at least 3
  sessions over at least 2 days. One odd session is noise.
- **Thresholds from our own data.** Before shipping, compute each signal's
  distribution across consenting users and set cut points from it (for
  example, "skills listed but none invoked in 90% of sessions"). Record the
  chosen numbers and the date in the backend PR.
- **Old model table is reviewed by hand.** A model counts as replaced only
  when a person adds the replacement and its date to a table. No automatic
  "newer slug wins".

## Tests

- Claude fixture with a `skill_listing` of 5, one `invoked_skills` entry and
  one `Skill` call for a second skill: `skillsListed: 5`, `skillsInvoked: 2`.
- Fixture with two MCP servers added, one removed, and calls to the
  remaining one: `mcpServersLoaded: 1`, `mcpServersUsed: 1`. A tool name
  longer than 40 characters still maps to its server.
- A message split over three assistant lines with `speed: "fast"` counts one
  fast turn.
- A session with no listing attachments ships no skill or MCP keys.
- Receipts: a subagent on an Opus model has `modelClass: "anthropic:opus"`,
  and `premiumSubagents` counts it; a Haiku subagent doesn't.
- `tests/metricVocabulary.test.mjs` passes with every new key registered.

## Done when

- `npm run verify` passes.
- The backend PR is linked, with its thresholds and the date they were set.
- The app's receipt change is linked.
- `CHANGELOG.md` has a line under the unreleased heading.
