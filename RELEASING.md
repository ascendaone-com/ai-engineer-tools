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

## Registry status

`ascenda-one` is the one name for all of it — npm org, Marketplace publisher,
OpenVSX namespace, Claude Code marketplace. Do not introduce a second one.

| Registry | Identifier | Status |
| --- | --- | --- |
| VS Code Marketplace | `ascenda-one.ascenda` | **Live.** Publishes automatically via `VSCE_PAT`. |
| Open VSX (Cursor installs from here) | `ascenda-one.ascenda` | **Live.** Publishes automatically via `OVSX_PAT`. Namespace ownership is *unverified* — see below. |
| npm | `@ascenda-one/*` | **Live.** Publishes automatically via `NPM_TOKEN`. |
| Claude Code plugins | `ascenda@ascenda-one` | **Live**, but served from `.claude-plugin/marketplace.json` on `main` — not from a release. See [Plugin distribution](#plugin-distribution-is-not-tag-driven). |

### Open VSX namespace verification (outstanding)

Publishing works without it; verification only removes the "not a verified
publisher" warning on the listing and locks the namespace to a known owner.
Open VSX namespaces are first-come-first-served — claiming is a separate,
optional step *after* publishing, not a gate before it.

To claim: file the **Claim namespace ownership** issue against
[`EclipseFdn/open-vsx.org`](https://github.com/EclipseFdn/open-vsx.org/issues/new/choose),
namespace `ascenda-one`. The template requires **12+ months of public GitHub
history** on the account filing it, so it must be filed by a long-standing
account that has commits in this repository — not necessarily the account that
published. Cite an existing commit as evidence; do not manufacture one for the
purpose.

### Plugin distribution is not tag-driven

Every other artifact here ships by pushing a tag. The Claude Code plugin does
not: `/plugin marketplace add ascendaone-com/ai-engineer-tools` reads
`.claude-plugin/marketplace.json` from `main` directly, and
`ascenda-agent-skills/.claude-plugin/plugin.json` pins the version users get.

Consequences worth knowing:

- **A merge to `main` is a plugin release.** There is no separate publish step
  and no tag gate.
- Bump `version` in `plugin.json` when the plugin's behaviour changes, or users
  will not receive the update — omitting it falls back to the commit SHA, which
  makes every commit a new version.
- Validate before merging: `claude plugin validate ./ascenda-agent-skills --strict`.
- The plugin's hooks and MCP server invoke the **published npm packages** via
  `npx`, so a plugin change that depends on new CLI behaviour needs the npm
  release to land *first*.

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

## Repository secrets

All three are set. Rotating or re-creating one is the only reason to revisit
this list.

| Secret | What it is |
| --- | --- |
| `VSCE_PAT` | Azure DevOps PAT with Marketplace **Manage** scope. Not an npm or GitHub token — the failure mode for pasting the wrong type is an opaque "invalid token". |
| `OVSX_PAT` | Open VSX access token, generated on open-vsx.org itself. Also not an Azure DevOps PAT. |
| `NPM_TOKEN` | npm **automation** token (or granular token with "bypass 2FA" checked) for the `@ascenda-one` scope with read+write. Interactive tokens cannot publish from CI — there is no one present to approve the 2FA prompt. |

Each publish step still warns and skips when its own token is absent, but a
tagged release now **fails a preflight check** before it builds anything if any
of the three is missing — otherwise the release completes green, publishes
nothing, and cannot be re-run, because the GitHub Release already exists. Set
the repository variable `ALLOW_PARTIAL_RELEASE=true` to restore the old
skip-quietly behaviour for a release you intend to be partial.

The preflight only checks that a secret is set. An expired `VSCE_PAT` passes it
and fails at the Marketplace step; see the gotcha on transfers below.

## Gotchas that have actually bitten

### npm provenance requires `repository` in every published package.json

Releases are signed with Sigstore build provenance, and npm **rejects the
publish** if `repository.url` does not match the repo the workflow ran in:

```
npm error 422 Unprocessable Entity — Error verifying sigstore provenance bundle:
package.json: "repository.url" is "", expected to match "https://github.com/ascendaone-com/ai-engineer-tools"
```

Every package in `RELEASE_PACKAGES` needs:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/ascendaone-com/ai-engineer-tools.git",
  "directory": "<the package folder>"
}
```

A missing `repository` field passes `npm run verify` and fails only at publish
time, after the GitHub Release has already been created.

### Transferring the repo to another owner is a repo-side change only

`asc-core-be` moved to the `Ascenda-One-Pty-Ltd` org; this repo has not. When it
moves, **nothing changes on any registry**. The npm scope `@ascenda-one`, the
Marketplace publisher `ascenda-one` and the Open VSX namespace `ascenda-one` are
identities in those systems, not on GitHub, and all three publish steps
authenticate with a stored token (`NPM_TOKEN` / `VSCE_PAT` / `OVSX_PAT`) rather
than with GitHub OIDC trusted publishing. There is nothing to update on
npmjs.org, in the Marketplace publisher, or on open-vsx.org.

What does change is every place this repo names itself. The provenance gotcha
above is the hard one — `npm publish --provenance` errors rather than warns, so
the first tag after a transfer fails at the npm step, *after* the GitHub Release
and both marketplace publishes have already gone out. The rest keep working on
GitHub's redirect until the old name is reused, and two of them are already
baked into shipped artifacts: the extension README's absolute image URLs render
from the Marketplace and Open VSX listings, and
`releases/latest/download/manifest.json` is what installed clients poll.

`scripts/tests/repoIdentity.test.mjs` holds the whole set. It reads the expected
owner from `GITHUB_REPOSITORY` in CI (the exact value provenance compares
against) and from the `origin` remote locally, so it needs no update in advance
— it starts failing on the first CI run after the transfer and names every file.
Preview the work at any time:

```bash
GITHUB_REPOSITORY=NEW-OWNER/ai-engineer-tools npm run test:scripts
```

The sweep itself is mechanical — one pass, then `npm run verify`:

```bash
git grep -lz ascendaone-com/ai-engineer-tools | xargs -0 sed -i '' 's|ascendaone-com/ai-engineer-tools|NEW-OWNER/ai-engineer-tools|g'
```

One thing the test cannot see: repository secrets are per-repo, and a publish
step with a missing token **warns and skips**, so a release that lost its
secrets in the move goes green having published nothing. Confirm all three are
present before the first tag under the new owner.

### A rerun cannot recreate an existing GitHub Release

`gh release create` fails with *"a release with the same tag name already
exists"*. `gh run rerun --failed` re-runs steps that failed **or were skipped**,
so a run that succeeded at the release step and failed later will fail on the
rerun. Either delete the GitHub Release first (the tag can stay), or — usually
simpler — bump to a new tag.

### Images in READMEs must be absolute URLs

The extension README is published to the VS Code Marketplace, Open VSX **and**
npm, none of which resolve repo-relative paths. Use full
`https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/…`
URLs. See [`docs/images/README.md`](./docs/images/README.md).

## Adding a new shipped tool

`scripts/release-artifacts.mjs` is the single source of truth for what a release
ships. Three steps, all required:

1. Add the workspace to `RELEASE_PACKAGES` (with its `npm` name if it publishes
   to the registry).
2. Stage its build output in the workflow's *Stage artifacts* step.
3. Add the `repository` field to its `package.json` — see the provenance gotcha
   above, or the publish fails after the release is already created.

Version stamping and the manifest pick it up automatically; `scripts/tests/`
covers both.

Skipping step 1 is silent: the package builds, tests pass, and it simply never
reaches npm — while its README goes on telling people to `npx` it. Both
`@ascenda-one/agent-mcp` and `@ascenda-one/github-collector` shipped in that
state before being caught.
