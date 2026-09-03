# Ascenda Agent Skills

The skill/rule content that teaches an agent host **when and how** to report semantic (agent-observed) work-friction patterns through [`ascenda-agent-mcp`](../ascenda-agent-mcp/)'s `ascenda_emit_work_signal` tool. That package is the transport; this package is the judgement.

The backend cites this package's `copy/banned-vocabulary.txt` as the canonical list — this is that file.

## What's here

This package is both the skill/rule content *and* — since `.claude-plugin/plugin.json` was added — the Claude Code plugin itself, bundling the skill, hooks, and MCP server config into one installable unit.

| Path | Purpose |
|---|---|
| [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json) | Claude Code plugin manifest — makes this directory installable as `ascenda` |
| [`skills/ascenda-work-signals/SKILL.md`](./skills/ascenda-work-signals/SKILL.md) | The Claude Code skill that reports work-friction patterns |
| [`skills/ascenda-work-checkpoints/SKILL.md`](./skills/ascenda-work-checkpoints/SKILL.md) | The Claude Code skill that *reads* the Flow app's local `get_work_demand_context` and offers a checkpoint at a work boundary |
| [`hooks/hooks.json`](./hooks/hooks.json) | Wires [`ascenda-claude-code-hooks`](../ascenda-claude-code-hooks/)'s CLI into all eight lifecycle events, via `npx` |
| [`.mcp.json`](./.mcp.json) | Wires [`ascenda-agent-mcp`](../ascenda-agent-mcp/)'s CLI in as an MCP server, via `npx` |
| [`cursor/ascenda-work-signals.mdc`](./cursor/ascenda-work-signals.mdc) | The equivalent Cursor project rule (Cursor doesn't use this plugin system, so it's still installed separately — see below) |
| [`docs/EMISSION_CRITERIA.md`](./docs/EMISSION_CRITERIA.md) | Versioned, per-event trigger thresholds and required evidence — the actual judgement logic both files above summarise |
| [`copy/banned-vocabulary.txt`](./copy/banned-vocabulary.txt) | Phrases that must never appear in Flow-facing copy or reasoning — the canonical list the backend's own test mirrors |
| [`copy/language-guard-exceptions.txt`](./copy/language-guard-exceptions.txt) | The occurrences of a banned phrase that are the rule naming what it forbids, one reviewable line each |
| [`scripts/check-language.mjs`](./scripts/check-language.mjs) | Runs that list over every file above, on `npm test` |

`tests/skillContent.test.mjs` keeps these in sync mechanically: every event type in `SEMANTIC_WORK_SIGNAL_EVENT_TYPES` (`@ascenda-one/tool-contract`) must be documented in `EMISSION_CRITERIA.md` and mentioned in both the skill and the rule, and neither may go stale silently.

The vocabulary list used to govern only the model's reasoning — the skill told it to check itself, and nothing checked the shipped copy. `scripts/check-language.mjs` closes that: it runs the list over every skill, rule, doc and this README on `npm test`. Because the ban is on assertion rather than on the word existing, an occurrence that is a rule naming what it forbids is written down in `copy/language-guard-exceptions.txt` with its reason; an exception that stops matching anything fails too, so the list cannot rot into a blanket permit.

### The two skills

`ascenda-work-signals` **writes**: it reports observable patterns through `ascenda_emit_work_signal`, and nothing comes back. `ascenda-work-checkpoints` **reads**: it asks the Flow app's own local MCP server for today's work-demand context, keyed to the project the agent is sitting in, and offers a green run and a commit when that project has run a long stretch with nothing standing as a return point. They share the vocabulary line and nothing else — different tools, different directions, installable apart.

The read skill needs the Flow macOS app running and an agent paired in **Flow › Connections** with the *Demand & workload* scope ticked. It never learns a repository name: it passes its own working directory in and gets back an opaque digest for the project it is already sitting in, and the other projects in the payload are digests it holds no key to.

## Installing the Claude Code plugin (recommended)

One command replaces the skill copy, the `hooks.json` wiring, and the `.mcp.json` wiring below — it installs all three together:

```bash
claude plugin marketplace add ascendaone-com/ai-engineer-tools
claude plugin install ascenda@ascenda-one
```

(Or `/plugin marketplace add ascendaone-com/ai-engineer-tools` then `/plugin install ascenda@ascenda-one` from inside a running session.) The skill still only does anything once you've paired via the [Ascenda extension](../ascenda-vscode-extension-telemetry/) or [pairing-sim](../ascenda-pairing-sim/) — the bundled hooks and MCP server both read `ASCENDA_TOOL_INSTALLATION_ID` (and the on-disk token it points at) from your environment, same as a manual install. Installing without pairing first is inert, not broken.

To test a local checkout before it's in a marketplace: `claude --plugin-dir ./ascenda-agent-skills`. Validate before submitting anywhere: `claude plugin validate ./ascenda-agent-skills --strict`.

## Installing the Claude Code skill manually

If you'd rather not use the plugin system — e.g. to hand-pick just the skill without the bundled hooks/MCP wiring — copy the skill directory directly:

```bash
mkdir -p ~/.claude/skills/ascenda-work-signals
cp ascenda-agent-skills/skills/ascenda-work-signals/SKILL.md ~/.claude/skills/ascenda-work-signals/
```

For a project-scoped install instead of a user-level one, use `.claude/skills/ascenda-work-signals/` inside the project. The skill references `../../docs/EMISSION_CRITERIA.md` and `../../copy/banned-vocabulary.txt` by relative path, so either keep the whole `ascenda-agent-skills` checkout alongside the installed skill, or copy `docs/` and `copy/` next to wherever you place `SKILL.md`.

The skill only does anything once [`ascenda-agent-mcp`](../ascenda-agent-mcp/) is configured as an MCP server for the same host — see that package's README for pairing and `.mcp.json` setup. Installing the skill without the MCP server configured is inert, not broken: the skill checks for the tool and says nothing if it's absent.

## Installing the Cursor rule

```bash
mkdir -p .cursor/rules
cp ascenda-agent-skills/cursor/ascenda-work-signals.mdc .cursor/rules/
```

Same relative-path note as above applies — keep `docs/` and `copy/` reachable from wherever the `.mdc` file ends up, or copy them alongside it.

## Why this is a separate package from `ascenda-agent-mcp`

The MCP server enforces *shape* (schema, consent scope, no free text) — it will reject a malformed call, but it cannot tell a legitimate three-attempt debugging session from three genuinely different approaches to the same bug, or know whether a user's "let's also fix X" was a deliberate scope change. That judgement has to live where the interaction is actually visible: in the model reading it. Splitting judgement (this package) from transport (`ascenda-agent-mcp`) means the transport's guarantees hold regardless of which skill, or which model, is doing the judging.
