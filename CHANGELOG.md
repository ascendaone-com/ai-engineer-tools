# Changelog

What changed for someone running these tools, one section per release tag.
The workflow reads the section that names the tag and puts it at the top of
the GitHub Release, with the merged-PR list generated underneath — so a tag
with no section here fails before anything is built. Write the section first;
see [RELEASING.md](./RELEASING.md).

Rules for what goes in a section: what a user of the CLIs, the extension or
the plugin will notice, in their terms. Nothing about backend state, deploy
targets, error counts or internal resource names — this repository is public.

## v0.1.28

### Install the CLI hooks without an account

- **`setup --no-pair`.** Every CLI agent's `setup` stopped at a pairing code
  you confirm in the Ascenda app, so the hooks could not be installed at all
  without an account. With the flag they install and register as usual, and
  emit only the local live signal — the message a listener on this machine
  reads to know an agent is working right now. Nothing is sent anywhere,
  which was already what an unpaired hook did.
- **A pairing that cannot finish now installs the local half anyway**, and
  says so. Before, you got nothing at all. An unreachable host, an unconfirmed
  code and an expired session all land in the same place.
- **Your installation id is recorded either way**, so pairing later attaches
  the hooks you already installed rather than minting a second id beside
  them. Pair whenever you like by running `setup` again.
- On such an install the hooks stop reporting the absent pairing as a fault:
  no journal entry per event, and `status` says `installed, not paired —
  local features active, telemetry inactive`. A token that is revoked or
  deleted after pairing is still reported, loudly, as before.
- **Claude Code is in this too.** Its adapter takes the same flag, records the
  same installation id and reads the same way in `status` and `doctor`, which
  now name the mode: `installed, not paired`.
- **The session prompts keep working unpaired.** The lines these hooks add to a
  Claude Code session are written on your machine, so they never needed an
  account either. Same for the live signal.
- **`status` stops calling a good install broken when you ask about the wrong
  scope.** Hooks in `~/.claude/settings.json` apply to every project, so a
  check run in a project now finds them and says where they are.
- **`uninstall` leaves your other agents alone.** It used to delete the whole
  credentials file, taking any other agent's pairing with it. It clears its own
  entry now, and on an unpaired install it tells you there is no token to
  revoke.

## v0.1.27

### A leftover socket file can't swallow live signals

- **The hooks skip a dead socket.** Every hook sends a small live signal
  to a local socket so a desktop listener knows an agent is working right
  now. It went to the first socket file it found, and a file stays behind
  when its listener is force-quit, crashes or is removed without cleaning
  up. From then on every signal went into that dead file, a listener
  further down the list heard nothing, and nothing said so.
- **Now a refused connection moves on.** The hooks try each socket file in
  the same order as before and send to the first one that answers. One
  listener gets each signal, never several.
- **Your agent turn still doesn't wait.** The whole attempt, however many
  files it tries, still gives up after 50 ms and never raises an error.
- **`ASCENDA_LIVE_BUS_SOCKET` is unchanged.** Set it and that path is the
  only one tried.
- **Nothing gets deleted.** The hooks leave a stale socket file where it
  is. Cleaning it up is the listener's job.

## v0.1.26

### When the agent stops and waits for you, that now counts

- **Being interrupted is recorded as its own thing.** Claude Code fires a
  notification when it stops and waits for you: asking permission to run
  something, or simply waiting for input. Codex does the same at its approval
  gate. Neither was recorded before: both hooks were unregistered, so the
  number of times an agent stopped and waited on you was always zero, and zero
  looked exactly like never being interrupted.
- **Nothing about what was asked leaves your machine.** The event carries one
  field, `interruptionKind`, which is `permission_request`, `idle_prompt` or
  `other`, and nothing else. Not the notification's wording, not the command awaiting
  approval, not the path it touches, not your answer. A test in each adapter
  fails the build if a future change adds any of them.
- **It rides the telemetry permission you already gave.** No new consent to
  grant, because producing it needs nothing that the tool-call and file events
  covered by that permission didn't already need: a hook fires when the agent
  reaches a gate, and no content is read to send it.
- **`other` is a real answer, not a leftover.** These notifications get reworded
  between releases, and a wording we don't recognise is reported as `other`
  rather than guessed at. If that share climbs, the labels need updating. It
  is meant to be visible.
- **Codex users merging hooks by hand:** `examples/hooks.json` gains a
  `PermissionRequest` entry. `setup` writes it for you; a hand-merged file needs
  the line added.
- **What this is not.** A count of interruptions, and nothing built on top of
  it. There is no score, no streak, and nothing that fires when a number moves.

### A resumed session's minutes are its own

- **Active time stops at the session boundary.** Resuming or forking a Claude
  Code session writes a transcript that opens with a copy of everything it
  inherited. Those copied lines were counted twice: once in the session they
  were typed in, once in every session resumed from it. v0.1.25 fixed the
  prompt counts and left the minutes alone. They're fixed now.
- **Your session totals drop. Your week doesn't.** On one 983-session store the
  per-session active minutes summed to 70,212 and now sum to 53,600, while the
  union of the same intervals moved by a single minute. Hands-on falls
  furthest, 12,238 minutes to 8,006. Every minute of work is still in there,
  counted once, where it happened.
- **A session starts when you started it.** `startedAt` was the oldest
  timestamp anywhere in the file, which on a resume is whenever the first
  ancestor began. 127 of 978 sessions on that store now show a later start, 13
  of them by more than an hour.
- **Counts of agents running at once get honest.** Exact-duplicate spans were
  30% of every active span in the store and are now 3.5%. A duplicated span
  reads as a second agent, so any concurrency figure was partly reading copies.
- **`minutesBasis: "owned_lines"` on the handoff says which minutes you're
  reading.** `"every_line"`, and a missing stamp, mean the old figures. Gate on
  it before you compare two handoffs. The schema number stays where it is.
- **Resume a session, type nothing, and there's no session to report.** The
  file holds the copy and that's all, so the import counts it in
  `sessionsWithOnlyInheritedLines` and moves on.
- **Both importers agree.** The desktop app reads by the same rule.

### The runs you cut short are the ones you cut short

- **A resume no longer reports its ancestors' interruptions.** Pressing Escape
  writes a marker into the transcript, and a resumed session copies that marker
  along with the rest of the history it inherited — so the same interruption
  was reported again by every session resumed from it. Only the session you
  pressed Escape in counts it now.
- **Expect a lower count, on the same store.** 191 counted runs became 151 on
  one store of 990 transcripts: a fifth of them were replays. 26 sessions
  changed and 19 now report none at all. Nothing real was dropped: every
  marker is still counted somewhere, and the per-day figures move with the
  totals.
- **The rule is the one the minutes already use.** Same ownership, asked of a
  third thing, so a session's cut-short count and its minutes now answer the
  same question about the same lines. A cut whose own session has been purged
  still counts, in the first transcript that holds it.

### Minutes a second file also claimed

- **Some copies rewrite the session id, and both files claimed the line.** The
  rule that stopped a resumed session counting its ancestors' minutes trusts
  the id each line carries. Most copies keep it; some rewrite it to the
  copying file's own name while keeping everything else, down to the original
  timestamp — so both files said the line was theirs and both counted it. It
  isn't a version quirk: the transcripts carrying it span fourteen Claude Code
  releases.
- **Another 3.9% comes off your session totals, and your week still doesn't
  move.** On one store of 991 transcripts, 3.7% of the lines claiming their own
  file were claimed by two. Summed active minutes fall 53,945 to 51,865 and
  hands-on 8,052 to 7,599, while the union of the same intervals holds to a
  minute, 25,248 to 25,247, which is what says a line was dropped and not a
  minute of work. 42 sessions change and 34 now start later.
- **The minutes land on the session that did the work.** The file that wrote a
  line is the one still holding a line nobody else claims — its own history has
  started there. Where that file has been purged, the first in walk order keeps
  it, as with any orphan. Picking by walk order alone would have moved a third
  of these lines onto the copy instead.
- **A prompt and the minute it happened in now agree about whose they are.**
  The prompt count never double-counted these, but it could put the prompt in
  one session and its instant in another.
- **Imports take a little longer.** The pre-read now reads every line's id
  rather than only the lines a prompt could hide in, and the files holding a
  contested id are read once more — 76 of 991 on that store. Measured end to
  end: 24s to 30s.
### Days you worked show up even when you typed nothing that session

- **A session with no prompt of its own still gets its day breakdown.** Sessions
  opened from a chip have no typed prompt, and neither does a resume whose
  prompts all belong to an ancestor, which v0.1.25 made common by counting
  each typed prompt once. The per-day
  slices stopped at the prompt list, so those sessions came back with no days
  at all. Their session totals were right the whole time. Only the placement
  went missing, which is why nothing looked wrong.
- **What comes back.** On one 987-session store, 103 sessions had no prompt of
  their own and every one of them reported an empty breakdown. Day-placed
  active minutes go from 50,173 to 51,662, and five cut-short runs land on the
  day they happened.
- **Codex imports gain the same days.** Both extractors that measure active
  time were affected. A store whose only timestamps are its prompts, Cursor
  and VS Code, behaves as before.
- **Anything summing the day breakdown will read higher.** The session figures
  don't move, so a total built from `days[]` gets closer to the one built from
  sessions.

## v0.1.25

### Each prompt counts once, and a chip's prompt isn't one

- **A resumed session's history counts in the session it came from.** Resuming
  or forking a Claude Code session writes a new transcript that copies the
  history it inherited. The import counted every copied prompt again, once per
  resume, so a long-running piece of work could show several times the
  prompts you typed. Each typed line now counts in one session: the one it was
  typed in, or the first transcript read where that one's gone.
- **Sessions opened from a chip start on a prompt nobody typed.** Clicking a
  suggested-task chip opens a session whose first line is the chip's prompt.
  The import used to count it as yours. It's now counted per session as
  `dispatchedPromptLines`, next to `syntheticPromptLines`. The agent still
  runs on that line, so stopping its first turn early is still counted.
- **Expect lower prompt counts after your next import.** Days you resumed a lot
  of sessions drop the most. After-hours prompts, quick re-prompts and the
  per-day prompt counts follow. Minutes don't move. A resumed session still
  carries its inherited active and hands-on minutes.
- **`promptBasis: "typed_once"` on the handoff says which count you're
  reading.** `"typed"` is the previous rule. The schema number doesn't move,
  and your existing handoffs still read.
- **The import reads your transcripts twice now.** The first pass keeps only
  line ids and hashes of chip prompts, never text, and nothing is kept after
  the run. A chip offered by a session the store has since cleaned up can't be
  matched, so that session's opener still counts as typed.
- **Both importers agree.** The desktop app counts by the same rules.

## v0.1.24

### Failed tool calls get recorded

- **`setup` now registers `PostToolUseFailure`.** Claude Code reports a
  failed tool call on that hook, never on `PostToolUse`. `setup` left it out,
  so failed commands, failed edits and failed test runs were never sent,
  although the collector knew how to map them.
- **Re-run `setup` to pick it up.** Existing installs keep their old hook list
  until you do. `status` now counts 8 hooks, so an install from before this
  release shows `7/8 registered`.

### Queued events now get delivered

- **The outbox sends what it holds.** When a send can't reach the ingest
  endpoint, the collector keeps the event on disk and offers it again on a
  later hook. That replay used to be switched off, so a queue only grew, hit
  its cap and aged out. `doctor` would then report thousands of events
  "discarded" for anyone who'd been offline for a while.
- **A replay is free, which is what makes this safe.** Every event carries a
  client-minted `idempotencyKey`. The ingest endpoint matches a replay on that
  key, answers `duplicate` and writes nothing. We confirmed that against the
  deployed endpoint before changing the default.
- **The switch changed sides.** Set `ASCENDA_OUTBOX_DRAIN=0` (or
  `false`/`no`/`off`) to hold the queue. Unset now means send.
- **What you'll see:** a backlog drains 100 events per hook invocation, oldest
  first, and `doctor` shows the depth falling. Events the server already holds
  come back as duplicates and get deleted.

### `status` stops saying nothing is installed

- **It checks one scope, and the default is `project`.** On a machine set up
  with `--scope user` it reported a flat `0/7 registered`, which reads as a
  failed install. It now looks in the other scope too, and names the file
  where your hooks actually are.
- **`doctor` and `pair` are in `--help`.** Both always worked. Neither was
  listed. `pair` prints a code and waits for you to paste it into the app, so
  piping its output somewhere buffered looks like a hang.

## v0.1.23

### The hooks mark the end of every agent turn

- **Each turn now ends with `ai_turn_completed`.** Claude Code's `Stop`,
  Codex's `Stop`, Cursor's `stop`, Windsurf's `post_cascade_response` and
  Gemini CLI's `AfterAgent` send it every time the agent hands back to you.
  Until now those hooks sent something only when a turn ran past 30 minutes.
- **It's where your turn starts.** The agent writes its closing message after
  its last tool call, so the last tool event isn't the moment it stopped. This
  one is. Paired with your next `ai_prompt_submitted`, it gives live telemetry
  the same hands-on boundary the history import uses.
- **Nothing about content travels.** The event carries the session, time, UTC
  offset and project hashes every event already has, plus the turn's duration
  bucket where the adapter measured one and the permission mode where the agent
  reports it. The agent's reply and the transcript path are never read.
- **`agent_loop_long` is unchanged.** A long turn still sends it, first.
- **Expect one more event per turn** in the local event log. It's classed as
  neutral workload.

### The history import counts the runs you cut short

- **Every Claude Code session now carries `interruptedRuns`.** It's the number
  of times you pressed Escape while the agent was still working: mid-reply,
  waiting on a tool, or before it had answered at all. Each day slice carries
  its share, placed on the day you pressed it, the way prompts are.
- **A keypress after the agent finished doesn't count.** Nothing was running,
  so nothing was cut. The marker Claude Code writes when the app closes on a
  running turn doesn't count either. You didn't do that.
- **It's a count.** Not a rate, and not placed any finer than the day.
- **`interruptedRunsCounted: true` on the handoff says it was counted.** With
  the label, `0` means you cut nothing short. Without it, the file wasn't
  counted: every handoff written before this release, and every store other
  than Claude Code. Your existing handoffs still read fine. The schema number
  doesn't move, because the label is additive.
- **The desktop app counts by the same rule.** Until its importer ships the
  same field, a handoff it writes won't carry the label, and the app reads that
  as not counted.

### Prompt counts count what you typed

- **A Claude Code session's `promptCount` is the prompts you typed.** Claude
  Code writes some `user` lines itself: background task notifications, messages
  from another session, its own bookkeeping, slash commands and their output,
  and the marker it leaves when you press Escape. The import used to count
  those as prompts. It skips them now.
- **Expect lower prompt counts after your next import.** Sessions that ran
  background tasks or lots of slash commands drop the most. After-hours prompts
  and quick re-prompts move with them.
- **Hands-on time can move too.** A skipped line isn't you and isn't the agent,
  so it doesn't start or end a hands-on span.
- **Every session carries `syntheticPromptLines`**, the number of lines it
  skipped, so you can see the difference session by session.
- **`promptBasis: "typed"` on the handoff says which count you're reading.** A
  handoff without it counted every line. Your existing handoffs still read
  fine, and the schema number doesn't move.
- **Both importers agree.** The desktop app already skips these lines, so a
  week imported by either shows the same prompts.

## v0.1.22

### Hands-on time now runs from the agent's last output to your next prompt

- **What "hands-on" measures changed, and the number will move.** The history
  import splits your active time into hands-on and agent-working. Hands-on used
  to be the single stretch ending at your prompt, whatever line started it — and
  on Claude Code that line was usually the runtime's own bookkeeping (the queue
  entry as your prompt was dequeued, a hook running), written milliseconds
  before the prompt itself. So hands-on was counting the runtime's write
  latency once per prompt, not the time you spent reading and typing. It now
  runs from the agent's last output — its reply, a tool result, the stop-hook
  line that closes a turn — to the prompt that follows. Expect a larger figure
  after your next import; the old one was not smaller because you were less
  present.
- **The five-minute rule is unchanged.** A stretch longer than five minutes
  between the agent's last line and your prompt still counts as stepping away,
  and a prompt still vouches only for the stretch it closes.
- **Every handoff says which rule cut it.** `handsOnBoundary` on the file reads
  `human_turn` for Claude Code and `nearest_line` for Codex, whose transcript
  bookkeeping has not been classified yet, so its figure means what it always
  meant. A handoff without the field was cut by the old rule. The schema
  number does not move: the shape is the same, the label is additive, and the
  desktop app reads the file it already knows.
- **The desktop app's own importer has not made this change yet.** Until it
  does, a handoff it writes and one this CLI writes will disagree on hands-on
  for the same week, and the label is how a reader tells them apart.

### Your longest unbroken stretch

- **The history import records how long your best single run of work was.**
  Every project on the handoff now carries it, along with the day it started.
  The desktop app has been asking you to run the import again to pick it up;
  that ask goes away.
- **It's measured once, before anything cuts it up.** A stretch worked from
  23:40 to 00:30 is fifty minutes. The per-day figures split it at midnight
  into twenty and thirty, and no arithmetic over those gets you back to fifty,
  so the figure is taken over your whole timeline before the split happens.
  Two agents working the same hour count as one hour, the same way the rest of
  your elapsed time does.
- **It doesn't add up with anything.** Every other figure in the import is a
  total; this one is a maximum. You can't sum it across projects, and a card
  showing your last thirty days can't derive its own longest run from it. The
  start date is there so a surface can at least tell whether the stretch falls
  inside the window it's drawing.
- **Nothing to install.** Run the import again and the app has it. Handoffs
  already on disk still read fine. They just don't carry the stretch, and the
  app says so. It won't guess a number from the day figures.

### Codex, Cursor, Windsurf and Gemini now drive the desktop app's live features

- **Step Away no longer lets the Mac sleep mid-run.** The Ascenda Flow macOS
  app learns that an agent is working *right now* over a local channel, and
  only the Claude Code hooks and the editor extensions were speaking on it.
  If you drive Codex, Cursor, Windsurf or Gemini CLI through their hooks,
  four things looked switched on and did nothing: the live gauges stayed
  flat, arming Step Away read the machine as idle and released the
  keep-awake, the settle bell never rang, and the Waterline screen saver fell
  back to ambient. All four work now.
- **Each agent counts as itself.** The three report under their own names, so
  running two agents side by side reads as two streams rather than one: the
  concurrency gauge was the thing that would have quietly under-counted.
- **Windsurf has no compaction beat, and won't get one.** Cascade ships no
  compaction hook, so the gauge's compaction ripple never fires there. Every
  other beat does.
- **Cursor, if you run both the extension and the hooks.** They're separate
  installs and neither can see the other, so the same work reaches the gauges
  twice and the concurrency reading sits higher than the number of agents you
  are actually running. The hooks were included anyway, because anyone using
  them without the extension had nothing at all. One of the two is enough.
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
