# Changelog

What changed for someone running these tools, one section per release tag.
The workflow reads the section that names the tag and puts it at the top of
the GitHub Release, with the merged-PR list generated underneath — so a tag
with no section here fails before anything is built. Write the section first;
see [RELEASING.md](./RELEASING.md).

Rules for what goes in a section: what a user of the CLIs, the extension or
the plugin will notice, in their terms. Nothing about backend state, deploy
targets, error counts or internal resource names — this repository is public.

## v0.1.16

First publish of three hook adapters: `@ascenda-one/cursor-hooks`,
`@ascenda-one/windsurf-hooks` and `@ascenda-one/gemini-hooks`. Each gains the
same `setup` command Claude Code and Codex already had, so hooks install
without a hand-edited environment.

### Delivery: nothing is dropped on the floor any more

- **Durable outbox.** A hook event the ingest endpoint refuses is kept in an
  owner-only, append-only outbox beside the send journal, bounded, and
  reported by `doctor`. Draining it on the next hook is behind
  `ASCENDA_OUTBOX_DRAIN` and is **off by default**; queued events are kept,
  not re-sent, until it is switched on.
- **Persisted IDE queue.** The VS Code / Cursor extension's undelivered
  telemetry backlog now lives on disk under the extension's global storage,
  so a reload, a crash, a failed final flush or a dispose that skipped
  `stop()` no longer loses it. Re-sending a restored backlog is behind the
  `ascenda.telemetry.drainPersistedQueue` setting, default `false`.
- **`idempotencyKey` on every payload,** minted when the payload is built.
  A `duplicate` answer is treated as delivered, which is what makes any
  replay — outbox, restored queue, or a plain retry — safe to attempt.
- **Installation id from disk.** The Claude Code hooks fall back to the
  token store on disk when `ASCENDA_TOOL_INSTALLATION_ID` is not in the
  environment (the normal case for a Dock-launched editor on macOS). When
  nothing resolves, the send is journalled as `skipped_no_installation_id`
  instead of the hook exiting silently with every health signal green.

### Work context: group by project, branch and forge, without a name leaving the machine

- A **forge repository identity** the machine computes for itself. The
  GitHub collector now takes its project digest from the shared derivation,
  so the same repository no longer arrives under two keys that can never
  meet, and the local side registers the forge identity beside its own.
- **`branchHash`** from the live Claude Code and Codex hooks: a salted digest
  under the same rule as the project digest. The branch name itself stays on
  the machine.
- **Hands-on versus supervising minutes.** The retrospective importer splits
  active time into hands-on and agent-supervising, gap-split over every
  event timestamp rather than prompts alone — one prompt can drive an hour
  of agent work, and the old reading under-counted exactly those sessions.
- **A deleted worktree folds into the repository it came from,** in both the
  live hooks and the importer, instead of freezing into a project of its own.
- The Claude Code plugin gains a **work-checkpoints skill** that reads the
  day's project slice from the Flow app's local MCP server, with a language
  guard on what it may say. Plugin version `0.2.0`.

### Signals the payload already carried

- The Claude Code hooks now capture **`autonomyMode`** (from the session's
  permission mode), **`modelClass`** (a `vendor:tier` reading of the session
  model where the host reports one) and whether a tool result was
  **user-modified**. None of the three can be recovered after the fact.
- The Codex hooks map the autonomy posture Codex was already sending onto the
  same vocabulary. The VS Code extension has no equivalent field to read, and
  its README now says so.
- The importer classifies each session's primary model into the same
  `modelClass` the live hooks write, through one shared classifier. Partial
  recognition degrades to `<vendor>:unknown`, never bare `unknown`.
- Classifier fixes: xAI is read as a vendor (`xai:grok`) instead of falling
  to `unknown`; a delegated model choice (`copilot/auto`, `default`) is
  `router:auto` rather than `unknown`; Claude Code's own `<synthetic>`
  notices no longer count as a model the session ran on.

### Contract

`@ascenda-one/tool-contract` declares `idempotencyKey`, the `autonomyMode` and
`modelClass` vocabularies (captured granular, read coarse — the wire stops
collapsing values at the edge), `branchHash`, the hands-on/supervising
metrics, and `EVENT_METADATA_FIELDS`, a runtime mirror of the metadata type
so a field the type knows cannot be silently dropped by a mapper.

### Housekeeping

- `@ascenda-one/agent-skills` is marked private: it ships as the Claude Code
  plugin from `main`, never as an npm tarball.
- Release notes come from this file. The workflow fails before building if
  the tag has no section here.
