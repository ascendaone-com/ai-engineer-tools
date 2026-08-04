# ai-engineer-tools

Privacy-first developer telemetry and pairing tooling for Ascenda's AI engineer workload detection platform.

## Install

Three surfaces, each one command. Pick the tools you actually use — they all
report into the same paired installation, and any one of them works alone.

### VS Code or Cursor

1. Open the Extensions pane — **⇧⌘X** (macOS) or **Ctrl+Shift+X** (Windows/Linux).
2. Search **Ascenda** and click **Install**. (Publisher: `ascenda-one`.)

   ![Searching for Ascenda in the VS Code Extensions pane](https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/vscode-marketplace-search.png)

3. Open the Command Palette — **⇧⌘P** / **Ctrl+Shift+P** — and run **Ascenda: Connect App**.

   ![The Ascenda commands in the VS Code Command Palette](https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/vscode-command-palette.png)

Same extension serves both editors; the host is detected at runtime. If you
prefer the command line:

```bash
code   --install-extension ascenda-one.ascenda   # VS Code
cursor --install-extension ascenda-one.ascenda   # Cursor
```

On macOS those CLIs are not on `PATH` by default — run **Shell Command: Install
'code' command in PATH** from the Command Palette first, or just use the
Extensions pane above.

### Claude Code

```bash
claude plugin marketplace add ascendaone-com/ai-engineer-tools
claude plugin install ascenda@ascenda-one
```

Installs the work-signals skill, the lifecycle hooks, and the MCP server
together. From inside a session, use `/plugin marketplace add …` and
`/plugin install …` instead.

### Codex

```bash
npx @ascenda-one/codex-hooks --help
```

Then register the hooks per
[ascenda-codex-hooks](./ascenda-codex-hooks/#3-register-hooks-in-codex).

> **Pairing.** Every tool needs one pairing with the Ascenda app before it
> sends anything. Pair once in VS Code/Cursor (**Ascenda: Connect App**), and
> the CLI tools reuse that installation — see
> [Pairing](#pairing) for what to carry across.

Confirm the pairing in the Ascenda app under **Connections → Ingest telemetry**,
which also shows the per-tool setup steps and everything currently paired:

![The Connections pane in the Ascenda macOS app](https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/macos-connections-pane.png)

## Research direction

All packages align to the backend-agreed research foundation:

- Workload Telemetry Research Direction: NASA-TLX / human factors thesis, workload scoring, baselines, compliance, phased rollout
- [Tool Pairing API Reference](./api-docs/TOOL_PAIRING_API_REFERENCE.md) — pairing and event ingest contract

**Core thesis:** burnout is a lagging indicator. Ascenda measures workflow friction — context switching, AI prompt loops, verification burden, after-hours pressure — *before* overload is consciously recognised. Signals combine objective telemetry, subjective check-ins (app), and individual baselines (backend).

## Packages

| Package | Published as | Phase 1 role |
| --- | --- | --- |
| [ascenda-vscode-extension-telemetry](./ascenda-vscode-extension-telemetry/) | `ascenda-one.ascenda` (VS Code Marketplace + Open VSX) | IDE telemetry for VS Code and Cursor — one extension, runtime host detection; editor activity, terminal classification, sessions |
| [ascenda-agent-skills](./ascenda-agent-skills/) | `ascenda@ascenda-one` (Claude Code plugin) | The Claude Code plugin — bundles the work-signals skill, hooks, and MCP server into one install. Also holds the Cursor rule and the emission criteria both share |
| [ascenda-claude-code-hooks](./ascenda-claude-code-hooks/) | `@ascenda-one/claude-code-hooks` (npm) | Claude Code agent hooks — prompts, tool calls, compaction, agent loops |
| [ascenda-codex-hooks](./ascenda-codex-hooks/) | `@ascenda-one/codex-hooks` (npm) | OpenAI Codex lifecycle hooks — same agent signals as Claude hooks, via Codex's hooks.json |
| [ascenda-agent-mcp](./ascenda-agent-mcp/) | `@ascenda-one/agent-mcp` (npm) | MCP server exposing `ascenda_emit_work_signal` — the one interface for agent-observed *semantic* patterns the deterministic hooks cannot see |
| [ascenda-github-collector](./ascenda-github-collector/) | `@ascenda-one/github-collector` (npm) | Collaboration signals from a code forge — your own review load and PR activity, never anyone else's |
| [ascenda-pairing-sim](./ascenda-pairing-sim/) | not published | Console app that simulates the mobile app for pairing tests (confirm / list / revoke / e2e) |
| [ascenda-dev-server](./ascenda-dev-server/) | not published | Local mock of the `/v1` pairing + ingest contract — run any tool with no backend, phone, or DevAuth. Dev-only; binds to `127.0.0.1` |

### Shared packages

The repo is an npm workspace. The installable tools above are thin shells over shared packages:

| Package | Role |
| --- | --- |
| [packages/tool-contract](./packages/tool-contract/) | Canonical DTOs, event catalog, and constants — mirrors [TOOL_PAIRING_API_REFERENCE.md](./api-docs/TOOL_PAIRING_API_REFERENCE.md); declared once, consumed everywhere |
| [packages/tool-kit](./packages/tool-kit/) | vscode-free shared runtime: command classifier, buckets, after-hours calculation, token file store, `/v1` HTTP client |
| [packages/ide-extension-core](./packages/ide-extension-core/) | The single extension implementation; host identity (VS Code vs Cursor) is detected at runtime |

## Pairing

Pairing is what links a tool installation to your Ascenda account. It happens
**once per machine**, and every tool on that machine reuses it.

1. In VS Code or Cursor, run **Ascenda: Connect App** (⇧⌘P / Ctrl+Shift+P).
2. Confirm in the Ascenda app — or, on Dev backends without a phone, with
   [ascenda-pairing-sim](./ascenda-pairing-sim/).
3. Run **Ascenda: Show Status** and note the `toolInstallationId`.

The CLI tools (Claude Code hooks, Codex hooks, the MCP server) read that
identity from your environment rather than pairing again — this is deliberate,
so one machine is one installation instead of three competing ones:

```bash
export ASCENDA_TOOL_INSTALLATION_ID="<the id from Show Status>"
```

Add it to your shell profile, then restart the tool. The write token is picked
up automatically from `~/.ascenda/tokens/`, written at pairing time. Without
this variable the CLI tools exit with `Missing ASCENDA_TOOL_INSTALLATION_ID`
rather than silently minting a second, unpaired identity.

## Build from source

You do not need this to use the tools — everything above installs prebuilt. It
is here because "verify what you're running" is a reasonable thing to want from
a telemetry tool, and this repo is Apache-2.0 precisely so you can.

```bash
npm install
npm run build     # shared packages first, then tools
npm run verify    # DRY guard rail (scripts/check-dry.sh) + full build + tests
```

The extension is bundled with esbuild at package time (`npm run package`), so
the shared packages are inlined; per-folder F5 debugging works after a root
build. Per-package development notes live in each package's own README.

## Phase 1 data collection (this repo)

**In scope**

- IDE usage (VS Code / Cursor)
- Terminal test/build/lint signals
- Claude Code AI interaction load
- Metadata-only, hashed workspace identifiers (salted with a machine-local secret that is never transmitted)
- Loose app pairing (QR / 6-digit code)

**Out of scope (backend / app / Phase 2+)**

- GitHub, Jira, Slack, Teams, calendar (backend activity-signals path)
- Wearables (Apple Health, Oura, Whoop, Garmin)
- Subjective NASA-TLX-style check-ins (Ascenda mobile app)
- Personalised baseline scoring (backend Phase 3)

## Install from a release (air-gapped / no registry)

The registry paths above are the normal ones. This section is the fallback for
machines that cannot reach the Marketplace or npm, and for anyone who wants to
verify a checksum before running anything.

Every tagged release attaches each shipped artifact plus a `manifest.json`. The
manifest is the only supported way to discover artifacts — resolve downloads
through it rather than from `main`. Requires **Node 20+**.

The newest release is always at a stable `latest` URL:

```bash
BASE=https://github.com/ascendaone-com/ai-engineer-tools/releases/latest/download
curl -fsSLO "$BASE/manifest.json"
cat manifest.json    # { version, minNode, artifacts: [{ name, url, sha256 }] }
```

**1. Extension (VS Code / Cursor).** One VSIX for both hosts. Download the
version named in the manifest and install it headlessly — this works with no
marketplace dependency:

```bash
curl -fsSLO "$BASE/ascenda-<version>.vsix"
code   --install-extension ./ascenda-<version>.vsix   # VS Code
cursor --install-extension ./ascenda-<version>.vsix   # Cursor — same file
```

The extension is on both the VS Code Marketplace and Open VSX, so installing
from there is preferred — you get auto-updates. The VSIX is the universal
fallback, not the recommended path.

**2. Hook CLIs (Claude Code / Codex).** Published to npm, so the shortest path is:

```bash
npx @ascenda-one/codex-hooks --help
npx @ascenda-one/claude-code-hooks --help
```

They are also attached to every release as self-contained single-file ESM
bundles — no `npm install`, no dependencies — for machines where you would
rather not go through npm at all:

```bash
mkdir -p ~/.ascenda/bin
curl -fsSL "$BASE/ascenda-codex-hooks.mjs" -o ~/.ascenda/bin/ascenda-codex-hook
chmod +x ~/.ascenda/bin/ascenda-codex-hook
export PATH="$HOME/.ascenda/bin:$PATH"    # add to your shell rc
```

`~/.ascenda/bin` is the install target rather than `npm i -g`: no sudo, and no
npm-global permission failures on locked-down machines.

**3. Verify before you run.** Check the checksum against the manifest, and
optionally the build provenance:

```bash
shasum -a 256 ascenda-codex-hooks.mjs        # must match sha256 in manifest.json
gh attestation verify ascenda-codex-hooks.mjs --repo ascendaone-com/ai-engineer-tools
```

Releases are built only by [`.github/workflows/release.yml`](./.github/workflows/release.yml),
gated on `npm run verify`, and signed with keyless Sigstore build provenance.

## Developing on this repo

**Run everything with no backend, phone, or DevAuth:** see
[TESTING.md](./TESTING.md) — `./scripts/dev-quickstart.sh` gets events flowing
against a local mock server ([ascenda-dev-server](./ascenda-dev-server/)) in
about two minutes. This is the fastest way to see the whole pipe work end to
end without touching a real backend.

Per-package development notes:

| Tool | Guide |
| --- | --- |
| VS Code / Cursor | [ascenda-vscode-extension-telemetry](./ascenda-vscode-extension-telemetry/README.md) |
| Claude Code | [ascenda-claude-code-hooks](./ascenda-claude-code-hooks/README.md) · [ascenda-agent-skills](./ascenda-agent-skills/README.md) |
| Codex | [ascenda-codex-hooks](./ascenda-codex-hooks/README.md) |
| Semantic signals (MCP) | [ascenda-agent-mcp](./ascenda-agent-mcp/README.md) |
| Pairing sim (app stand-in) | [ascenda-pairing-sim](./ascenda-pairing-sim/README.md) |

To pair against a Dev backend without a phone:

```bash
ascenda-pairing-sim e2e --tool-type cursor_mcp
```

Point any tool at a non-default backend with `ASCENDA_API_BASE_URL` (CLIs) or
the `ascenda.apiBaseUrl` setting (extension) — `http://localhost:5002` for a
local backend, or the Azure Dev host. Never commit tokens.

Verified on Azure Dev: ingest, tool-scoped renew, `list`, and `revoke`
(post-revoke ingest returns `401`).

## Privacy & compliance

Workspace identifiers are hashed with a random salt generated on first run and stored only at `~/.ascenda/salt`. It is never sent, so the hashes cannot be reversed to folder or repository names by anyone holding the telemetry. Deleting the file re-anonymises the machine.

Metadata-only by default. Not a medical device — measures workload patterns for self-awareness, not diagnosis or treatment. Australian Privacy Act / GDPR-aligned consent via `ide_telemetry` scope.

See [section 7–8 of the research direction](./docs/WORKLOAD_TELEMETRY_RESEARCH_DIRECTION.md) for full compliance notes.
