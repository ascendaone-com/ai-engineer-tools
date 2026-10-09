# ai-engineer-tools

The collectors behind Ascenda: small, open-source hooks and an editor
extension that notice how AI-assisted engineering work is going. They record
metadata only, never source code, prompts or file names. What the
measurements do and do not establish is set out in
[What this measures](#what-this-measures-and-what-that-does-not-yet-prove).

There are two ways to use them, and the first needs no account:

- **On this Mac only.** The hooks send a live signal to a socket on your own
  machine. The Ascenda Flow app's live view and the Waterline screen saver
  read it to show that an agent is working, or waiting on you. Nothing leaves
  the machine.
- **With your Ascenda account.** Pair a tool once and its events also go to
  Ascenda, so your sessions appear in the Flow app over time.

## Install

Pick the tools you use. Each works alone, and each has its own pairing.

| Agent | Command | Hooks registered in |
| --- | --- | --- |
| Claude Code | `npx -y @ascenda-one/claude-code-hooks setup` | `~/.claude/settings.json` |
| Codex CLI | `npx -y @ascenda-one/codex-hooks setup` | `~/.codex/hooks.json` |
| Cursor (agent) | `npx -y @ascenda-one/cursor-hooks setup` | `~/.cursor/hooks.json` |
| Windsurf | `npx -y @ascenda-one/windsurf-hooks setup` | `~/.codeium/windsurf/hooks.json` |
| Gemini CLI | `npx -y @ascenda-one/gemini-hooks setup` | `~/.gemini/settings.json` |

Add `--no-pair` to install without an account. `setup` then installs the hooks
and stops; the live signal works, and nothing is sent.

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

## Pairing

Pairing links one tool installation to your Ascenda account. Each tool pairs
on its own, and each pairing can be revoked on its own in the Flow app.

**The editor extension** pairs with **Ascenda: Connect App**, which shows a QR
code and a six-digit code, good for a few minutes:

![The Ascenda pairing panel in VS Code, showing a QR code and a six-digit pairing code](https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/vscode-pairing-code.png)

Confirm it in the Flow app under **Connections → Ingest telemetry**: scan the
QR, or paste the code. The code carries no personal data.

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

## Privacy and compliance

Workspace identifiers are hashed with a random salt generated on first run and
stored only at `~/.ascenda/salt`. It is never sent, so the hashes can't be
turned back into folder or repository names by anyone holding the telemetry.
Deleting the file resets the hashes.

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

## What this measures, and what that does not yet prove

**What it captures.** Named, observable events: context switches, prompt and
correction loops, verification runs, tool-call density, context compaction,
agent loop depth, after-hours activity. Counts and classifications, compared
against your own history.

**The hypothesis under test.** That friction of this kind rises measurably
before a person notices being overloaded, and that a personal baseline shows
the rise earlier than self-report alone. That is why the collectors exist. It
is not a result they demonstrate.

**What is not established.** There is no peer-reviewed link between AI-tool
operational metrics and any validated cognitive-load instrument, and our own
calibration study has not been run. So nothing here detects burnout,
diagnoses a state, or predicts one. It counts things that happened and shows
them against your own history.

We say that plainly on purpose. Implying the inference already works is the
failure this design exists to avoid, and a strange thing to fake in a
repository whose whole argument is that you can read the source.

Wire contract: [Tool Pairing API Reference](./api-docs/TOOL_PAIRING_API_REFERENCE.md).
