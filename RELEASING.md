# Releasing

Artifacts become downloadable only by pushing a `vX.Y.Z` tag. Everything else —
the umbrella CLI, the curl installer — depends on this path existing first.

## Cutting a release

```bash
git tag v0.2.0 && git push origin v0.2.0
```

[`.github/workflows/release.yml`](./.github/workflows/release.yml) then:

1. **Stamps the version.** `scripts/stamp-version.mjs` writes the tag into the
   root and every shipped `package.json` (see `RELEASE_PACKAGES` in
   `scripts/release-artifacts.mjs` for the current list), so one tag means one
   version everywhere and the manifest carries a single `version`. Not committed back.
2. **Runs the gate.** `npm run verify` — the DRY guard rail, the full
   dependency-ordered build, and every workspace test suite. Red verify, no release.
3. **Builds artifacts** via the hermetic `vscode:prepublish` path (`build:shared`
   → typecheck → clean → esbuild bundle) and packages the extension VSIX.
4. **Writes `manifest.json`** — `{ version, minNode, artifacts: [{ name, url, sha256 }] }`.
   `minNode` is derived from the root `engines.node`, so it cannot drift.
5. **Attests provenance** with keyless Sigstore signing, then creates the Release.
6. **Publishes to Marketplace and OpenVSX** if the tokens are set (see below).

Dry-run the whole path without tagging via the workflow's `workflow_dispatch`
input: it builds, verifies and produces a manifest, publishing nothing.

## The `latest` pointer

GitHub serves the newest release's assets at a stable URL, so no extra hosting
is needed:

```
https://github.com/ascendaone-com/ai-engineer-tools/releases/latest/download/manifest.json
```

The installer reads this manifest and resolves every artifact through it — never
"whatever is on main".

## Manual prerequisites

These need accounts and cannot be done from CI. The release still succeeds
without them — the VSIX attached to the release is the universal fallback — but
each one is a gap until it is done.

`ascenda-one` is the one name for all of it — npm org, Marketplace publisher,
OpenVSX namespace. Do not introduce a second one.

| Prerequisite | Status | Blocks |
| --- | --- | --- |
| VS Code Marketplace publisher `ascenda-one` | **Account exists**, owned, no extensions published under it yet. | — |
| OpenVSX namespace `ascenda-one` | Not yet claimed. Cursor installs from OpenVSX, not the VS Code Marketplace, so Cursor users need this. | `OVSX_PAT` step |
| npm org `ascenda-one` | Exists. Needs an automation access token as the `NPM_TOKEN` secret. | `Publish CLIs to npm` step |

### Extension identity: one, not two

Previously `ascenda-vscode-extension-telemetry` and `ascenda-cursor-extension`
built and published as two separate identities (`ascenda-one.ascenda-vscode`
and `ascenda-one.ascenda-cursor`) even though their `src/extension.ts` were
identical one-line re-exports of `@ascenda-one/ide-extension-core` — no code
difference justified two listings, and because Cursor installs from Open VSX
rather than the VS Code Marketplace, publishing both there would have given
Cursor users two indistinguishable "Ascenda" extensions to choose between.
Fixed before either identity went live (neither had been published under
`OVSX_PAT`/`VSCE_PAT` yet): `ascenda-cursor-extension` is retired, the
surviving package publishes as plain `ascenda` (not `ascenda-vscode`), and
one VSIX goes to both registries. `packages/ide-extension-core/src/host.ts`
already does runtime host detection and drives host-aware copy (e.g.
`pairingPanel.ts`'s "This Cursor installation is now paired…"), so nothing
about the Cursor experience depended on having a second package.

**The identifiers, going forward:**

| | Identifier |
| --- | --- |
| VS Code Marketplace | `ascenda-one.ascenda` |
| Open VSX (used by Cursor) | `ascenda-one.ascenda` — same publisher, same name, same VSIX |
| `package.json` `name` | `ascenda` |
| `package.json` `publisher` | `ascenda-one` |

Publishing one identity to both registries does not merge their install
counts or reviews — the VS Code Marketplace and Open VSX each keep their own
listing data under the same `<publisher>.<name>`; treat them as two counts
for one product, not one combined figure.

If a genuine Cursor-native surface is built later (a bundle of skills, rules,
MCP config, and onboarding commands for Cursor's separate Plugins
Marketplace — see [`ascenda-agent-skills`](./ascenda-agent-skills/) and
[`docs/CURSOR_ADAPTER_PLAN.md`](./docs/CURSOR_ADAPTER_PLAN.md)), that is a
different marketplace and a different kind of product, not a second copy of
this editor extension. `ascenda-cursor` is free to use there if that day comes.

### First publish, manually (one-time, per registry)

CI publishes automatically once `VSCE_PAT`/`OVSX_PAT` are set as repository
secrets (see below) — for most releases that's all this needs. The two
registries otherwise want the extension's *first* listing created once,
by hand, before CI can push updates to it:

1. **VS Code Marketplace** — sign in at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
   as the `ascenda-one` publisher, **+ New extension → Visual Studio Code**,
   and upload a built VSIX (`cd ascenda-vscode-extension-telemetry && npm run compile && npx vsce package --no-dependencies`)
   or publish straight from the CLI with a PAT: `npx vsce publish -p <VSCE_PAT>`
   from that directory. The extension's `name`/`publisher` fields in
   `package.json` are what fix the listing at `ascenda-one.ascenda` —
   nothing to choose in the web UI.
2. **Open VSX** — claim the `ascenda-one` namespace at
   [open-vsx.org](https://open-vsx.org) (needs a GitHub-linked Eclipse
   account and namespace ownership verification — this is the slower step),
   then `npx ovsx create-namespace ascenda-one -p <OVSX_PAT>` once, and
   `npx ovsx publish -p <OVSX_PAT>` from the same built VSIX. Cursor resolves
   extensions from here, so this is the step that actually makes the
   extension discoverable inside Cursor.

After that first listing exists on each registry, every subsequent release
(tag push) publishes automatically through the two steps below, as long as
their secrets are set.

Repository secrets to add once those exist:

- `VSCE_PAT` — Azure DevOps PAT with Marketplace *Manage* scope.
- `OVSX_PAT` — OpenVSX access token.
- `NPM_TOKEN` — npm **automation** token for the `ascenda-one` org. Automation tokens bypass 2FA; interactive ones cannot publish from CI.

Until each secret is set, its publish step logs a warning and skips. No release
ever fails for a missing marketplace token.

## Adding a new shipped tool

`scripts/release-artifacts.mjs` is the single source of truth for what a release
ships. Add the workspace to `RELEASE_PACKAGES`, then stage its build output in
the workflow's *Stage artifacts* step. Version stamping and the manifest pick it
up automatically; `scripts/tests/` covers both.
