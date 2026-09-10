# Changelog

What changed for someone running these tools, one section per release tag.
The workflow reads the section that names the tag and puts it at the top of
the GitHub Release, with the merged-PR list generated underneath — so a tag
with no section here fails before anything is built. Write the section first;
see [RELEASING.md](./RELEASING.md).

Rules for what goes in a section: what a user of the CLIs, the extension or
the plugin will notice, in their terms. Nothing about backend state, deploy
targets, error counts or internal resource names — this repository is public.

## v0.1.22

### Codex, Windsurf and Gemini now drive the desktop app's live features

- **Step Away no longer lets the Mac sleep mid-run.** The Ascenda Flow macOS
  app learns that an agent is working *right now* over a local channel, and
  only the Claude Code hooks and the editor extensions were speaking on it.
  If you drive Codex, Windsurf or Gemini CLI, four things looked switched on
  and did nothing: the live gauges stayed flat, arming Step Away read the
  machine as idle and released the keep-awake, the settle bell never rang,
  and the Waterline screen saver fell back to ambient. All four work now.
- **Each agent counts as itself.** The three report under their own names, so
  running two agents side by side reads as two streams rather than one — the
  concurrency gauge was the thing that would have quietly under-counted.
- **Windsurf has no compaction beat, and won't get one.** Cascade ships no
  compaction hook, so the gauge's compaction ripple never fires there. Every
  other beat does.
- **Nothing new leaves your machine.** This channel is a socket on your own
  Mac; nothing is sent anywhere and nothing is stored. What your collectors
  report to Ascenda is unchanged, as is the consent that governs it. If you
  don't run the desktop app there is nothing listening, and your hooks behave
  exactly as they did before — that path is best-effort, given up on after a
  moment, and can't slow down or fail a turn.
- **Nothing to install or configure.** Update the hooks package you already
  use and it starts working.

## v0.1.21

### `ASCENDA_HOME` moves the rest of the tree

- **The history import follows it now.** v0.1.19 moved the tokens, the
  credentials and the send journal under `ASCENDA_HOME`. Three things stayed
  in your real home and have caught up: the handoffs the desktop app reads,
  the staging area, and the archive. Point the variable at a directory and
  everything Ascenda writes is in it.
- **The machine salt moved too, and that one is worth reading twice.** The
  salt is what makes your project and workspace hashes unguessable, and it
  lives in a file. Point `ASCENDA_HOME` somewhere new and there's no salt
  there yet, so a fresh one gets minted and every hash derived afterwards
  differs from the ones before. Deleting the file does the same thing. Want
  the old hashes? Copy `salt` across from `~/.ascenda` before your next run.
- **The stores being read don't move, by design.** `~/.claude`, `~/.codex`
  and the editor histories belong to those tools. An Ascenda variable that
  relocated them would find nobody's history at all, so it leaves them alone
  and a test pins that.
- **Nothing changes if you've never set it.** The default is still
  `~/.ascenda`, and every file sits where it did.

## v0.1.20

### Two agents on one machine: each keeps its own telemetry

- **An exported `ASCENDA_TOOL_INSTALLATION_ID` no longer captures a different
  agent.** The variable is per machine and a pairing is per tool, so an id
  exported for Claude Code was being used by Codex, Cursor, Gemini and Windsurf
  hooks too — their events arrived filed under Claude Code. An id qualified for
  one tool type is now ignored by the others, which fall through to their own
  pairing in `~/.ascenda/credentials.json`. An id that matches, or one with no
  type at all, behaves exactly as before.
- **What you may see once.** If you ran two agents this way, some of the second
  agent's history is recorded against the first. Nothing is lost. Nothing needs
  re-pairing, and new events land correctly from the next session.
- **Codex needs its hooks trusted, not only registered.** Codex records trust
  against each hook definition and skips the ones it has not been shown, so
  `status` can report every hook registered while none of them run. After
  `setup`, restart Codex and run `/hooks` to review and trust the Ascenda
  commands. Changing a hook definition can send it back for review.

## v0.1.19

### `ASCENDA_HOME` moves the whole tree, not half of it

- **One variable, one directory.** `ASCENDA_HOME` has always chosen where
  Ascenda keeps its files. Until now only some of them listened: your write
  tokens and credentials followed it, while the send journal and the
  turn-start files stayed behind in `~/.ascenda/state` in your real home. Set
  it and you got half a tree in each place. Both halves move together now.
- **Who this reaches.** Anyone pointing `ASCENDA_HOME` at a project directory,
  a sandbox, or a throwaway path in CI. If you've never set it, nothing about
  your layout changes: the default is still `~/.ascenda`.
- **`ASCENDA_STATE_DIR` still wins.** It names the state directory outright,
  so it keeps overriding `ASCENDA_HOME` for that one subtree. That precedence
  is now pinned by a test.
- **Worth a look if you have stray files.** A run that wrote state under the
  old split may have left files in `~/.ascenda/state` that belong under your
  `ASCENDA_HOME`. They're inert. Delete them once the new layout looks right.

### `pair` writes your pairing to a file, instead of asking for a shell export

- **No more `export ASCENDA_TOOL_INSTALLATION_ID=…`.** `pair` now writes the
  pairing to `~/.ascenda/credentials.json`, the same file `setup` writes, and
  says so. Restart Claude Code and events flow.
- **Why it was worth changing.** That variable is per machine, but a pairing is
  per tool — so the line the old output told you to add to `~/.zshrc` was also
  the line that made the next agent you paired inherit this one's identity. The
  credentials file has a key per tool and cannot do that. An export still wins
  where you set one, so nothing you already have breaks.
- **It also fixes a hook launched from the Dock**, which never sees a shell
  profile: `pair` alone used to leave those unconfigured until you ran `setup`.
- **`pair --tool-type <type>` now mints its own id** instead of reusing an
  exported one. Naming a different tool is pairing a second tool, not
  re-pairing this one. Re-running `pair` for the same tool still heals the
  identity you have; it will not fork your history in two.

### Codex sets itself up, and stops borrowing Claude Code's identity

- **One command now does all of it:**
  `npx @ascenda-one/codex-hooks setup --scope user`. It pairs Codex, installs
  the hook binary, and writes the hook entries into `~/.codex/hooks.json`.
  `status` and `uninstall` came with it, the same pair every other CLI agent
  has had.
- **There is no longer a shell profile line to add.** Codex reads its identity
  from `tools.codex` in `~/.ascenda/credentials.json`, written by `setup`.
- **Why that matters if you run more than one agent.** The old instructions
  told you to pair with `claude-code-hooks pair --tool-type cli_agent` and
  export `ASCENDA_TOOL_INSTALLATION_ID`. On a machine where Claude Code was
  already paired, that variable was already set — so the pairing reused the
  Claude Code identity, minted no Codex one, and filed every Codex event
  afterwards under Claude Code. Nothing was lost, but the split
  between the two agents was not there to read.
- **If you set Codex up the old way:** run the new `setup`, then remove the
  `ASCENDA_TOOL_INSTALLATION_ID` line from your shell profile if you added it
  for Codex. Disconnect the tool that appeared as `cli_agent` in the app first,
  so the pairing it displaced goes back to being Claude Code's.
- **Merging `examples/hooks.json` by hand still works** and is documented, for
  anyone who prefers it or needs the inline `config.toml` form. It registers
  the same seven events with the same timeout — there is a test that fails if
  the two ever disagree.

### History import: your time across two agents is counted once

- **A new file: `elapsed/cross-store.json`, beside your handoffs.** The
  importer now takes one union across both stores while it still has the
  underlying stretches in hand, and writes it here. Re-run
  `history-import import` to get it.
- **What it fixes.** Each store's handoff already removes the overlap between
  *its own* sessions. Nothing removed the overlap between the two. If you use
  both Claude Code and Codex, an hour with an agent running in each counted as
  two hours, and the only way to read "how long did I spend on this project"
  was to add the two figures together, which is exactly the addition that
  double-counts.
- **Why it's in a subdirectory.** The app treats every `.json` file sitting
  directly in the handoff directory as a store, so a file next to them would
  show up as a store called "cross-store": in this version, and in every
  version already installed. Inside `elapsed/` it's invisible to builds that
  don't know to look for it, and nothing you already have changes.
- **It's only used where it still describes what's on disk.** The file names
  the run that wrote it and the stores it covers, and the app reads it only
  when every handoff beside it is from that same run. Re-import one store on
  its own afterwards and the file is ignored, not left to speak quietly for a
  window it no longer describes. You get the old added-up reading back, still
  labelled as an addition.
- **Not written when there's nothing to union.** With one store handing over
  time, that store's own figures already are the answer, and a second copy of
  them would only be something to disagree with. Cursor and VS Code hand over
  no timeline at all, so they never take part.
- **And cleared away when it stops applying.** If a later import has no union
  to write, because you stopped using one of the two agents, say, it removes
  the one it finds instead of leaving an old file to be judged on its stamp.
  An import that writes no handoffs at all (the desktop app isn't installed,
  or no store was found) leaves it alone, because nothing it describes has
  changed.
- **A file it can't write costs you nothing else.** If the union can't be
  saved, the import says so and finishes. Your per-store handoffs, the
  extracted record and the closing summary all land as usual, and your figures
  fall back to being added across stores, labelled as ever as an addition.
- **Nothing else moved.** The per-store handoffs are unchanged, every existing
  key means what it meant, and the new file carries the same
  `activeTimeQuantities` map naming what each figure measures.

### History import: your figures say what they measure

- **The handoff records what each active-time figure counts.**
  `activeGapMinutes` (added last release) says *how* your minutes were cut. It
  has never said *what* was cut, and that's the part that decides whether two
  numbers can be compared at all. The handoff now carries an
  `activeTimeQuantities` map alongside it, keyed by the path you walk to reach
  a figure (`sessions[].handsOnMinutes`,
  `projects[].elapsed.days[].summedHandsOnMinutes`), naming the quantity each
  one reports.
- **The pair it exists for.** `projects[].handsOnMinutes` is your hands-on
  time added up across that project's sessions, and
  `projects[].elapsed.handsOnMinutes` is the same time with the overlap
  removed. Same spelling, one nesting level apart, and on the machine this was
  measured on they were 4.2x apart, because sessions run at the same time as
  each other. The first is agent-hours; only the second is where your week
  went. Both were already in the file and nothing in it told them apart.
- **Absent means no claim.** Cursor and VS Code handoffs carry no map, exactly
  as they carry no gap rule: those stores hand over no timeline, so there's no
  active figure for a label to name. A handoff written before this release has
  no map either, which reads the same way. Unstated, never "assume they are
  all the same thing".
- **The schema is otherwise unchanged.** Every existing key means what it
  meant, so a reader that doesn't know the new key ignores it. Re-run
  `history-import import` to get the map.

## v0.1.18

### History import: your figures say how they were cut

- **The handoff records its active-time gap rule.** Active minutes are
  gap-split — a pause longer than the threshold is you stepping away, not
  working — and this tool uses five minutes. Other surfaces you may see
  your time on do not all use the same rule, and deliberately so: a figure
  measuring how long a block of work ran wants to bridge a longer pause
  than a figure measuring how long you were personally typing. Neither is
  wrong, and until now neither said which it was. `activeGapMinutes` on the
  handoff answers that, so two figures cut differently are never quietly
  compared.
- **Why five, if you are wondering.** The hands-on half is the stretch
  immediately before one of your prompts, and that prompt is the whole
  evidence you were there. Five minutes reads as having read the output and
  typed. Thirty would also count leaving for half an hour, coming back, and
  typing — as half an hour at the keyboard.

## v0.1.17

### History import: where a week actually went

- **Per-project active time is unioned, not added.** Sessions overlap — two
  agents running in one repo from 14:00 to 16:00 are two hours of your week
  and four hours of session time — and adding them up reported the second as
  the first. Each project digest now carries an `elapsed` block with the
  same time unioned: hands-on and agent-supervising minutes, the same per
  local day, and the concurrency the sum was accidentally reporting (mean
  and peak). The summed figures stay exactly where they were and still mean
  what they meant: agent-hours worked, which is a real quantity and is not
  elapsed time.
- **The handoff is schema 5.** `elapsed` absent means the handoff predates
  the union, which a reader has to be able to tell from a project whose
  sessions never overlapped. Re-run `history-import import` to get it.
- **Concurrency is per day, so a week can state its own.** `elapsed.days`
  carries each day's summed minutes beside its unioned ones, and that day's
  peak. A figure computed over your whole history cannot be quoted on a
  seven-day card: one project here runs 1.7x mean and 6x peak over a week
  against 2.2x and 10x across the corpus. Add up whichever days your window
  covers and divide; take the greatest of their peaks.

### Claude Code hooks: your session reaches the wire

- **Live events now carry the session they came from.** The hook read its
  session id from `ASCENDA_SESSION_ID` and nowhere else — a variable nothing
  sets — while the payload's own `session_id` sat unread in the same
  function. Every Claude Code event therefore shipped without a session.
  Claude Code was the only adapter affected; Codex, Cursor, Windsurf and
  Gemini already passed theirs through.
- **Why it mattered.** Anything that measures your time has to group events
  before it can tell concurrent work from consecutive work. Without a
  session id there is nothing to group by, so overlapping stretches could
  not be reconciled and time spent was over-reported.
- **An empty `ASCENDA_SESSION_ID` now means "unset", not "no session".** It
  previously shipped an empty string, which grouped unrelated events under a
  value naming no session. A payload with no session leaves the field absent
  rather than substituting anything.

### History import: Codex rollouts

- **`history-import` reads Codex.** `~/.codex/sessions` (and
  `archived_sessions`) rollouts join Claude Code, Cursor and VS Code in
  `scan`, `import` and `archive`. Per session: prompts, per-turn model mix,
  issued tool calls, tool and runtime failures, cumulative token totals,
  peak context against the window the rollout itself records, compaction
  items, turns long enough to match the live hooks' `agent_loop_long`, and
  gap-split active minutes split into hands-on and agent-supervising.
- **Same identity as the live Codex hooks.** Rows ship as `cli_agent` with
  `host: "codex"`, so a historical Codex session and a live one are one
  population, and the local handoff gains a `codex.json` beside the others.
- **What it does not claim.** The rollout records no permission mode, so
  every agent-supervising minute on this store is reported under the
  `unknown` band rather than a guessed posture, and compaction is counted
  without a manual/auto split because the store does not say which.

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
- **Handoffs land where the app reads them.** `history-import` writes its
  local handoff into `~/.ascenda/history-import` in your real home, a flat
  sibling of the CLI's own `staging/`, rather than inside the desktop app's
  old sandbox container. The app stopped running sandboxed, so the previous
  location produced handoffs nothing ever read.
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
