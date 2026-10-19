# ai-engineer-tools

**Building internal observability for AI coding agents? Start here.**

Open-source collectors for Claude Code, Codex, Cursor, Gemini CLI and
Windsurf, plus an editor extension for VS Code and Cursor. They capture what
your agents do as structured events, without prompts, responses or source
code. Run them locally, send the events to your own tools, or fork the project
and build your own engineering analytics. Skip building and maintaining the
collection layer, and spend the time on what you measure. No Ascenda account
needed.

```text
$ node examples/local-event-reader/read-events.mjs --follow
Watching ~/.ascenda/events.jsonl. Ctrl-C to stop.
07:29:39 AM  Claude Code  session.started
07:29:41 AM  Claude Code  prompt.submitted
07:29:44 AM  Claude Code  tool.started Read
07:29:45 AM  Claude Code  tool.completed Read
07:29:47 AM  Codex        prompt.submitted
07:29:49 AM  Claude Code  tool.started Edit
07:29:50 AM  Claude Code  tool.completed Edit
07:29:52 AM  Codex        tool.started local_shell
07:29:53 AM  Claude Code  tool.started Bash
07:29:56 AM  Codex        tool.failed local_shell (failure)
07:29:58 AM  Claude Code  tool.failed Bash (failure)
07:30:00 AM  Claude Code  agent.waiting
07:30:02 AM  Claude Code  turn.completed
```

A Claude Code session and a Codex session side by side, read by
[a small script](./examples/local-event-reader/) with no dependencies. The
hook payloads were replayed through the real collectors, so you can run the
same thing. Install any agent's hooks with `--no-pair` and you get this file.

## Why these collectors

Every coding agent reports its work differently. Different hooks, different
event formats, different ideas of what a session is, and each changes every
few weeks. Keeping a collection layer working across all of them is a project
of its own, and collecting conversations brings security and governance
problems you don't want.

- **Activity, not conversations.** Structured events. Never prompt or response
  text, file contents or command output.
- **One format across agents.** Every agent's events map to the same small
  schema, [`agent-event/v0`](./packages/agent-events/).
- **Local first.** Installed without pairing, the hooks write events to a file
  on the machine. Nothing leaves it.
- **Yours to build on.** Feed your own dashboards, internal tools or research.
  [Collecting from a team](./docs/TEAM_COLLECTION.md) gets every engineer's
  events into one place.
- **Open source.** Apache-2.0. Fork it, extend it, and send improvements back.

What these events do and don't tell you is set out in
[What this measures](#what-this-measures).

## Three ways to use it

| You want to | Start with |
| --- | --- |
| Build your own analytics across the team | The collectors, then [Collecting from a team](./docs/TEAM_COLLECTION.md) |
| See how you work with your agents | [Ascenda Flow](https://www.ascendaflow.com/?source=github), free for individual engineers |
| Compare your team with other AI-native teams | The [Founding Benchmark](https://www.ascendaflow.com/benchmark?source=github) |

Counts tell you what happened. Whether a busy week was a good one, whether a
change helped, and how you compare with other teams takes each person's own
read of their days, and other teams to compare with. That's what Flow and the
benchmark add.

**Waterline** is the quickest way to see the collectors working: a free macOS
screen saver that turns Claude Code, Codex and Cursor activity into a water
level. It runs on your Mac, with no account.
[See Waterline](https://www.ascendaflow.com/waterline?source=github)

<img src="https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/waterline-paired.gif" width="640" alt="The Waterline screen saver: a clock over dark water whose level moves with agent activity">

<sub>Waterline with Ascenda Flow paired, at double speed. Flow gives the water its colour.</sub>

**Ascenda Flow** is a macOS app that shows how you work with your agents: how
many you run at once, when your best work happens, and what gets in the way.
It starts from the history Claude Code, Cursor and Codex already keep on your
Mac. Free for individual engineers, with invitations going out by email.
[Get early access](https://www.ascendaflow.com/?source=github)

<img src="https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/flow-hud.gif" width="207" alt="The Flow HUD: a colour field labelled Activated, Clear, Strained and Drained, with a frame that fills as agents work">

<sub>Flow's HUD while agents work, about 8× speed.</sub>

**The Founding Benchmark** studies how small AI-native teams work with agents:
concurrency, who carries the review load, steering and rework. We're inviting
200 teams of roughly 2 to 15 engineers, selected in waves of 20. Selected
teams get early access to Flow, and a comparison with similar teams once the
cohort has enough of them. It's free, and each engineer decides whether to
take part. [Apply with your team](https://www.ascendaflow.com/benchmark?source=github)

## Install

Pick the tools you use. Each works alone, and each has its own pairing.

| Agent | Command | Hooks registered in |
| --- | --- | --- |
| Claude Code | `npx -y @ascenda-one/claude-code-hooks setup` | `~/.claude/settings.json` |
| Codex CLI | `npx -y @ascenda-one/codex-hooks setup` | `~/.codex/hooks.json` |
| Cursor (agent) | `npx -y @ascenda-one/cursor-hooks setup` | `~/.cursor/hooks.json` |
| Windsurf | `npx -y @ascenda-one/windsurf-hooks setup` | `~/.codeium/windsurf/hooks.json` |
| Gemini CLI | `npx -y @ascenda-one/gemini-hooks setup` | `~/.gemini/settings.json` |

If you've set `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, setup writes there.

Add `--no-pair` to install without an account. `setup` then installs the hooks
and stops. The live signal and the local event log work, and nothing is sent.

![setup --no-pair finishing with "Ready. The screen saver and the Ascenda app's live view work now."](https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/cli-setup-no-pair.png)

What `setup` does, for every agent:

- **Registers the hooks for every project.** `--scope project` limits them to
  the current folder instead. Re-running `setup` moves an older install from
  the other place, so each event runs once.
- **Installs a launcher that finds Node.** Each hook runs
  `~/.ascenda/bin/ascenda-<agent>-hook`, a small shell script that uses the
  Node 20+ that ran `setup` and finds another if that one goes (Homebrew, nvm,
  fnm, volta, asdf, mise). Hooks keep working when the agent starts from the
  Dock or an IDE without your shell's PATH. On Windows the hook runs the Node
  that ran `setup` directly.
- **Pairs,** unless you passed `--no-pair`: it prints a 6-digit code to confirm
  in the Flow app under **Connections → Ingest telemetry**.

Nothing goes in your shell profile. Then restart the agent:

- **Claude Code:** type `/hooks`. The Ascenda hooks are listed under **User**.
- **Codex:** open `/hooks` and trust the Ascenda hooks. Codex doesn't run a
  hook until you do.

### Check it works

```bash
~/.ascenda/bin/ascenda-claude-hook doctor     # or ascenda-codex-hook, -cursor-, -gemini-, -windsurf-
```

`doctor` checks the local half first, which needs no pairing. Can the hooks
start, are they registered where the agent loads them, has the agent run one
yet, and is anything listening for the live signal. When the screen saver is
running it pings it and waits for the answer. Every line says how to fix
what it finds.

![doctor on a fresh install: Node found, 13 of 13 hooks registered, Ready](https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/cli-doctor-ready.png)

![doctor naming a problem: hooks not registered, with the command that fixes it](https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/cli-doctor-problem.png)

`status` is the short version, and exits non-zero when something is missing,
so it can gate a CI step. `uninstall` removes the hooks, the launcher and the
pairing.

### Claude Code: the plugin, or `setup`

The Claude Code plugin installs the hooks together with the work-signals
skill and the MCP server:

```bash
claude plugin marketplace add ascendaone-com/ai-engineer-tools
claude plugin install ascenda@ascenda-one
```

Its hooks run through `npx`, so they need Node on the PATH Claude Code was
started with, and they don't get the launcher. Use the plugin or `setup` for
the hooks, not both: with both, every event runs twice.

### VS Code and the Cursor editor

The editor extension records editor and terminal activity. It is one
extension for both editors.

1. Open the Extensions pane (**⇧⌘X**, or **Ctrl+Shift+X** on Windows and Linux).
2. Search **Ascenda** and click **Install**. The publisher is `ascenda-one`.

   ![Searching for Ascenda in the VS Code Extensions pane](https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/vscode-marketplace-search.png)

3. Open the Command Palette (**⇧⌘P** / **Ctrl+Shift+P**) and run
   **Ascenda: Connect App**.

   ![The Ascenda commands in the VS Code Command Palette](https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/vscode-command-palette.png)

From the command line instead:

```bash
code   --install-extension ascenda-one.ascenda   # VS Code
cursor --install-extension ascenda-one.ascenda   # Cursor
```

On macOS those commands aren't on PATH until you run **Shell Command: Install
'code' command in PATH** from the Command Palette.

## The event format

Install any agent's hooks with `--no-pair` and every event lands in
`~/.ascenda/events.jsonl`. Each line's `event` field follows an open, versioned
format: which agent, what happened, which tool, how it ended. It's documented
in [packages/agent-events](./packages/agent-events/), and
[examples/local-event-reader](./examples/local-event-reader/) is a
dependency-free script that reads it. Build a dashboard, feed your own tool,
or check what the collectors record. None of it needs an Ascenda account.

The format is v0 and experimental. If you build on it, tell us what's missing
in an issue: that's what decides v1.

### What each agent can report

The agents expose different hooks, so they can't all say the same things. A
gap here is the agent's hook set, not something we infer around.

| | Claude Code | Codex | Cursor | Gemini CLI | Windsurf |
| --- | --- | --- | --- | --- | --- |
| Working (prompts, tool calls) | yes | yes | yes | yes | yes |
| Waiting on you (an approval) | yes | yes | no hook | yes | no hook |
| Context compaction | yes | yes | yes | yes | no hook |
| Quit mid-turn ends the session | yes | no hook | yes | yes | no hook |

Each package's README lists its events in full.

## Privacy and the local-first design

The collectors work in two ways, and the first needs no account:

- **On your machine only.** The hooks write every event to
  `~/.ascenda/events.jsonl` and send a live signal to a socket on your Mac,
  which Waterline and the Flow app read. Nothing leaves the machine.
- **With your Ascenda account.** [Pair](#pairing) a tool once and its events
  go to Ascenda, so your sessions appear in Flow over time. The live signal
  keeps working, and `setup --event-log` keeps the local file as well.

Workspace and project identifiers are hashed with a random salt generated on
first run and stored only at `~/.ascenda/salt`. It is never sent, so those
hashes can't be turned back into folder or repository names by anyone holding
the telemetry. Deleting the file resets them.

The repository and branch keys aren't salted. For a GitHub repository, each
event carries `repoKey`, a digest of `owner/repo`, and off the default branch a
`branchKey`. The [GitHub collector](./ascenda-github-collector/) runs in a
workflow step, where no salt exists, and puts the same keys on pull request
events, so a session can be
[matched to its pull request](./packages/agent-events/README.md#matching-a-session-to-a-pull-request).
Its 8-character project digest is unsalted for the same reason. Anyone holding
your events can check a guess at a repository or branch name, and for a public
repository the name is public anyway. The keys are on by default, set only for
github.com remotes, and off with `setup --no-repo-keys` or
`ASCENDA_REPO_KEYS=off`.

Metadata only, by default. **Not a medical device:** it measures workload
patterns for self-awareness, not diagnosis or treatment, and makes no clinical
claim. Consent is scoped and separately revocable: `ide_telemetry` for editor
and agent signals, `workflow_telemetry` for collaboration signals, and
`semantic_work_signals` for the patterns an agent reports. Granting one does
not grant the others.

What the metadata-only guarantee covers on each surface is listed in each
package's README under **Privacy defaults**, including where it is enforced
by schema rather than convention: the semantic signal tool rejects free text
outright.

## Building something with these collectors?

We'd like to hear what you're measuring. Tell us in an
[issue](https://github.com/ascendaone-com/ai-engineer-tools/issues/new/choose)
if you're building internal analytics on these events, extending the
collectors, or working out how your team uses agents.

- **Read the events.** [packages/agent-events](./packages/agent-events/) has
  the schema, the types and a reader.
  [examples/local-event-reader](./examples/local-event-reader/) is a working
  starting point, and [Collecting from a team](./docs/TEAM_COLLECTION.md)
  covers getting everyone's events into one place.
- **Add an agent.** Each collector is a thin adapter over a shared runtime.
  [CONTRIBUTING.md](./CONTRIBUTING.md) walks through adding one, and how to test
  it with no backend.
- **Report what breaks.** Agents change their hooks often. The issue forms take
  a compatibility report or a proposal for a new integration.

If you'd rather compare notes with other teams, the
[Founding Benchmark](https://www.ascendaflow.com/benchmark?source=github) is
bringing 200 AI-native teams together to do that.

Forks and commercial products built on these collectors are welcome under
[Apache-2.0](./LICENSE).

## Pairing

Pairing links one tool installation to your Ascenda account. Each tool pairs
on its own, and each pairing can be revoked on its own in the Flow app.

**The editor extension** pairs with **Ascenda: Connect App**, which shows a QR
code and a six-digit code, good for a few minutes:

![The Ascenda pairing panel in VS Code, showing a QR code and a six-digit pairing code](https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/vscode-pairing-code.png)

Confirm it in the Flow app under **Connections → Ingest telemetry**: scan the
QR, or paste the code. The code carries no personal data.

The pairing request carries the tool's name (`Claude Code`, `VS Code`) and a
random installation id, nothing about the machine or the person. No hostname,
no username. The installation id is what tells two installs apart.

**The CLI agents** pair during `setup`, which prints the same kind of code. To
pair an install made with `--no-pair`, run `setup` again (or, for Claude Code,
`~/.ascenda/bin/ascenda-claude-hook pair`). It attaches to the installation
already on file, so the hooks you have keep their identity.

The editor's pairing can't be shared with the CLI agents: its token lives in
the editor's own secret storage, by design. Each CLI agent keeps its pairing
under its own key in `~/.ascenda/credentials.json`, so several agents on one
machine never borrow each other's identity. `ASCENDA_TOOL_INSTALLATION_ID`
overrides that for every agent at once; set it only if you mean that.

A `setup` whose pairing can't finish (the server unreachable, the code not
confirmed in time) still installs the hooks, and says plainly that it isn't
paired.

## Upgrading

An install keeps the hooks it registered until `setup` runs again, so a
release that adds a hook reaches you on the next `setup`. The Flow app says so
in **Connections → Ingest telemetry** and names the command.

```bash
npx -y @ascenda-one/claude-code-hooks setup     # or codex-, cursor-, gemini-, windsurf-hooks
```

`setup` is safe to re-run. It keeps your pairing, replaces its own entries,
and prints what it added. Restart the agent afterwards. A plugin install
upgrades with `claude plugin update ascenda@ascenda-one` instead.

## Packages

| Package | Published as | What it does |
| --- | --- | --- |
| [ascenda-claude-code-hooks](./ascenda-claude-code-hooks/) | `@ascenda-one/claude-code-hooks` (npm) | Claude Code hooks: prompts, tool calls, compaction, waits, subagents |
| [ascenda-codex-hooks](./ascenda-codex-hooks/) | `@ascenda-one/codex-hooks` (npm) | Codex CLI hooks, through Codex's `hooks.json` |
| [ascenda-cursor-hooks](./ascenda-cursor-hooks/) | `@ascenda-one/cursor-hooks` (npm) | Cursor agent hooks |
| [ascenda-windsurf-hooks](./ascenda-windsurf-hooks/) | `@ascenda-one/windsurf-hooks` (npm) | Windsurf Cascade hooks; the gaps in Windsurf's hook set are documented, not filled in |
| [ascenda-gemini-hooks](./ascenda-gemini-hooks/) | `@ascenda-one/gemini-hooks` (npm) | Gemini CLI hooks; the per-inference hooks are deliberately left unregistered |
| [ascenda-vscode-extension-telemetry](./ascenda-vscode-extension-telemetry/) | `ascenda-one.ascenda` (VS Code Marketplace and Open VSX) | The editor extension for VS Code and Cursor: editor activity, terminal classification, sessions |
| [ascenda-agent-skills](./ascenda-agent-skills/) | `ascenda@ascenda-one` (Claude Code plugin) | The plugin: the work-signals skill, the hooks and the MCP server in one install, plus the Cursor rule |
| [ascenda-agent-mcp](./ascenda-agent-mcp/) | `@ascenda-one/agent-mcp` (npm) | MCP server exposing `ascenda_emit_work_signal`, for patterns only the agent can see |
| [ascenda-history-import](./ascenda-history-import/) | `@ascenda-one/history-import` (npm) | Reads the AI-tool history already on your machine (Claude Code, Codex, Cursor, VS Code, git) into a baseline |
| [ascenda-github-collector](./ascenda-github-collector/) | `@ascenda-one/github-collector` (npm) | Your own review load and pull request activity from a code forge, never anyone else's |
| [ascenda-pairing-sim](./ascenda-pairing-sim/) | not published | Stands in for the app in pairing tests: confirm, list, revoke, end to end |
| [ascenda-dev-server](./ascenda-dev-server/) | not published | A local mock of the `/v1` pairing and ingest API, so any tool runs with no backend. Binds to `127.0.0.1` |

### Shared packages

The repo is an npm workspace. The tools above are thin shells over these:

| Package | Role |
| --- | --- |
| [packages/tool-contract](./packages/tool-contract/) | The event catalog, DTOs and constants, declared once. Mirrors the [Tool Pairing API Reference](./api-docs/TOOL_PAIRING_API_REFERENCE.md) |
| [packages/tool-kit](./packages/tool-kit/) | The shared runtime: `setup`, `status` and `doctor` for the CLI agents, the hook launcher, the live signal, the command classifier, the token store and the `/v1` client |
| [packages/ide-extension-core](./packages/ide-extension-core/) | The single extension implementation; whether it runs in VS Code or Cursor is detected at runtime |
| [packages/agent-events](./packages/agent-events/) | `@ascenda-one/agent-events` on npm. The public event format, v0 and experimental: a JSON Schema, types and a log reader |

## Build from source

You don't need this to use the tools. It's here because "verify what you're
running" is a reasonable thing to want from a telemetry tool, and the repo is
Apache-2.0 so you can.

```bash
npm install
npm run build     # shared packages first, then the tools
npm run verify    # the DRY guard rail (scripts/check-dry.sh), a full build, and every test
```

The extension is bundled with esbuild at package time (`npm run package`), so
the shared packages are inlined. Each package's README has its own
development notes.

## Install from a release (no registry)

For machines that can't reach the Marketplace or npm, or for anyone who wants
to check a checksum first. Every tagged release attaches each artifact and a
`manifest.json`; resolve downloads through the manifest rather than from
`main`. Requires **Node 20+**.

```bash
BASE=https://github.com/ascendaone-com/ai-engineer-tools/releases/latest/download
curl -fsSLO "$BASE/manifest.json"
cat manifest.json    # { version, minNode, artifacts: [{ name, url, sha256 }] }
```

**The editor extension.** One VSIX for both editors:

```bash
curl -fsSLO "$BASE/ascenda-<version>.vsix"
code   --install-extension ./ascenda-<version>.vsix   # VS Code
cursor --install-extension ./ascenda-<version>.vsix   # Cursor
```

Prefer the Marketplace or Open VSX when you can reach them; you get updates.

**The hooks.** Each is a self-contained ESM file with no dependencies.
Download it anywhere and run its `setup`, which installs the launcher and the
bundle in `~/.ascenda/bin`. No sudo, no `npm -g`, nothing to add to PATH:

```bash
curl -fsSLO "$BASE/ascenda-codex-hooks.mjs"
node ascenda-codex-hooks.mjs setup --no-pair
```

**Verify before you run.** Check the checksum against the manifest, and
optionally the build provenance:

```bash
shasum -a 256 ascenda-codex-hooks.mjs        # must match sha256 in manifest.json
gh attestation verify ascenda-codex-hooks.mjs --repo ascendaone-com/ai-engineer-tools
```

Releases are built only by [`.github/workflows/release.yml`](./.github/workflows/release.yml),
gated on `npm run verify`, and signed with keyless Sigstore build provenance.

## Developing on this repo

[TESTING.md](./TESTING.md) runs everything with no backend, phone or
sign-in: `./scripts/dev-quickstart.sh` gets events flowing against
[ascenda-dev-server](./ascenda-dev-server/) in about two minutes.

To pair against a dev backend without a phone:

```bash
ascenda-pairing-sim e2e --tool-type cursor_mcp
```

Point a CLI at another backend with `ASCENDA_API_BASE_URL`, or the extension
with the `ascenda.apiBaseUrl` setting. Never commit tokens.

The terminal screenshots above are rendered from the real CLI by
`node scripts/render-cli-shots.mjs`; re-run it when the output changes. See
[docs/images](./docs/images/README.md).

## What this measures

**What it records.** Events you can name: prompts and corrections, tool
calls and how they ended, test and build runs, context compaction, how long
agent loops run, how many agents are going at once, and work outside your
usual hours. Counts and classifications, set against your own history.

**What we're testing.** Whether patterns like these shift before you notice
the work getting heavier, and whether your own baseline shows that sooner than
you'd see it yourself. That's the question the collectors were built to
answer. We don't have the answer yet.

**What's still open.** No published study yet links agent activity like this
to a validated measure of workload, and our own calibration study hasn't run.
Today the collectors count what happened and show it against your history.
The source is here, so you can check exactly what that means.

Wire contract: [Tool Pairing API Reference](./api-docs/TOOL_PAIRING_API_REFERENCE.md).
