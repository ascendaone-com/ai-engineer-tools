# ai-engineer-tools

Privacy-first developer telemetry and pairing tooling for Ascenda's AI engineer workload detection platform.

## Research direction

All packages align to the backend-agreed research foundation:

- Workload Telemetry Research Direction: NASA-TLX / human factors thesis, workload scoring, baselines, compliance, phased rollout
- [Tool Pairing API Reference](./api-docs/TOOL_PAIRING_API_REFERENCE.md) — pairing and event ingest contract

**Core thesis:** burnout is a lagging indicator. Ascenda measures workflow friction — context switching, AI prompt loops, verification burden, after-hours pressure — *before* overload is consciously recognised. Signals combine objective telemetry, subjective check-ins (app), and individual baselines (backend).

## Packages

| Package | Phase 1 role |
| --- | --- |
| [ascenda-vscode-extension-telemetry](./ascenda-vscode-extension-telemetry/) | VS Code IDE telemetry — editor activity, terminal classification, sessions |
| [ascenda-cursor-extension](./ascenda-cursor-extension/) | Cursor IDE telemetry + planned MCP/agent adapter |
| [ascenda-claude-code-hooks](./ascenda-claude-code-hooks/) | Claude Code agent hooks — prompts, tool calls, compaction, agent loops |
| [ascenda-codex-hooks](./ascenda-codex-hooks/) | OpenAI Codex lifecycle hooks — same agent signals as Claude hooks, via Codex's hooks.json |
| [ascenda-pairing-sim](./ascenda-pairing-sim/) | Console app that simulates the mobile app for pairing tests (confirm / list / revoke / e2e) |

### Shared packages

The repo is an npm workspace. The installable tools above are thin shells over shared packages:

| Package | Role |
| --- | --- |
| [packages/tool-contract](./packages/tool-contract/) | Canonical DTOs, event catalog, and constants — mirrors [TOOL_PAIRING_API_REFERENCE.md](./api-docs/TOOL_PAIRING_API_REFERENCE.md); declared once, consumed everywhere |
| [packages/tool-kit](./packages/tool-kit/) | vscode-free shared runtime: command classifier, buckets, after-hours calculation, token file store, `/v1` HTTP client |
| [packages/ide-extension-core](./packages/ide-extension-core/) | The single extension implementation; host identity (VS Code vs Cursor) is detected at runtime |

Build everything from the repo root (dependency-ordered):

```bash
npm install
npm run build     # shared packages first, then tools
npm run verify    # DRY guard rail (scripts/check-dry.sh) + full build
```

Both extension VSIXes are bundled with esbuild at package time (`npm run package` in each extension folder), so the shared packages are inlined; per-folder F5 debugging works after a root build.

## Phase 1 data collection (this repo)

**In scope**

- IDE usage (VS Code / Cursor)
- Terminal test/build/lint signals
- Claude Code AI interaction load
- Metadata-only, hashed workspace identifiers
- Loose app pairing (QR / 6-digit code)

**Out of scope (backend / app / Phase 2+)**

- GitHub, Jira, Slack, Teams, calendar (backend activity-signals path)
- Wearables (Apple Health, Oura, Whoop, Garmin)
- Subjective NASA-TLX-style check-ins (Ascenda mobile app)
- Personalised baseline scoring (backend Phase 3)

## Install from a release (no clone required)

Every tagged release attaches all four artifacts plus a `manifest.json`. The
manifest is the only supported way to discover artifacts — resolve downloads
through it rather than from `main`, and verify the checksum before running
anything. Requires **Node 20+**.

The newest release is always at a stable `latest` URL:

```bash
BASE=https://github.com/ascendaone-com/ai-engineer-tools/releases/latest/download
curl -fsSLO "$BASE/manifest.json"
cat manifest.json    # { version, minNode, artifacts: [{ name, url, sha256 }] }
```

**1. Extensions (VS Code / Cursor).** Download the VSIX named in the manifest and
install it headlessly — this works with no marketplace dependency:

```bash
curl -fsSLO "$BASE/ascenda-vscode-<version>.vsix"
code   --install-extension ./ascenda-vscode-<version>.vsix
cursor --install-extension ./ascenda-cursor-<version>.vsix
```

Once the extensions are on the VS Code Marketplace and OpenVSX, installing from
there is preferred (you get auto-updates); the VSIX remains the universal fallback.

**2. Hook CLIs (Claude Code / Codex).** These are self-contained single-file ESM
bundles — no `npm install`, no dependencies. Drop them on your PATH:

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

## Quick start

Per-package configuration and development instructions:

| Tool | Install guide |
| --- | --- |
| VS Code | [ascenda-vscode-extension-telemetry § Installation](./ascenda-vscode-extension-telemetry/README.md#installation-vs-code) |
| Cursor | [ascenda-cursor-extension § Installation](./ascenda-cursor-extension/README.md#installation-cursor) |
| Claude Code | [ascenda-claude-code-hooks § Installation](./ascenda-claude-code-hooks/README.md#installation-claude-code) |
| Pairing sim (app stand-in) | [ascenda-pairing-sim § Installation](./ascenda-pairing-sim/README.md#installation-terminal--cli) |

Typical flow:

1. Install and **F5** the VS Code or Cursor extension; run **Ascenda: Connect App**.
2. Confirm with the mobile app or [ascenda-pairing-sim](./ascenda-pairing-sim/) (DevAuth on `localhost:5002` or `https://app-asc-dev-api-aue.azurewebsites.net` — never commit tokens).
3. Optionally install [Claude Code hooks](./ascenda-claude-code-hooks/) with the same `toolInstallationId` / `eventWriteToken`.
4. Events POST to Ascenda per the [API reference](./api-docs/TOOL_PAIRING_API_REFERENCE.md).

Without a phone:

```bash
ascenda-pairing-sim e2e --tool-type cursor_mcp
```

Happy path on Azure Dev has been verified: ingest, tool-scoped renew, `list`, and `revoke` (post-revoke ingest returns `401`).

## Privacy & compliance

Metadata-only by default. Not a medical device — measures workload patterns for self-awareness, not diagnosis or treatment. Australian Privacy Act / GDPR-aligned consent via `ide_telemetry` scope.

See [section 7–8 of the research direction](./docs/WORKLOAD_TELEMETRY_RESEARCH_DIRECTION.md) for full compliance notes.
