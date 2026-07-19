# Releasing

Artifacts become downloadable only by pushing a `vX.Y.Z` tag. Everything else —
the umbrella CLI, the curl installer — depends on this path existing first.

## Cutting a release

```bash
git tag v0.2.0 && git push origin v0.2.0
```

[`.github/workflows/release.yml`](./.github/workflows/release.yml) then:

1. **Stamps the version.** `scripts/stamp-version.mjs` writes the tag into the
   root and all four shipped `package.json` files, so one tag means one version
   everywhere and the manifest carries a single `version`. Not committed back.
2. **Runs the gate.** `npm run verify` — the DRY guard rail, the full
   dependency-ordered build, and every workspace test suite. Red verify, no release.
3. **Builds artifacts** via the hermetic `vscode:prepublish` path (`build:shared`
   → typecheck → clean → esbuild bundle) and packages both VSIXes.
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

| Prerequisite | Why | Blocks |
| --- | --- | --- |
| **Claim the `@ascenda` npm scope** | Dependency-confusion surface flagged in the PR #1 review. An installer plan makes scope-squatting an active supply-chain risk. Publish stub-private packages if nothing is ready — just own the scope. | Nothing in this workflow, but do it first; it is independent and time-sensitive. |
| **VS Code Marketplace publisher `ascenda`** | Verification has the longest lead time of anything here. Create it now even if publishing comes later. | `VSCE_PAT` step |
| **OpenVSX namespace `ascenda`** | Cursor installs from OpenVSX, not the VS Code Marketplace. | `OVSX_PAT` step |

Repository secrets to add once those exist:

- `VSCE_PAT` — Azure DevOps PAT with Marketplace *Manage* scope.
- `OVSX_PAT` — OpenVSX access token.

Until each secret is set, its publish step logs a warning and skips. No release
ever fails for a missing marketplace token.

## Adding a new shipped tool

`scripts/release-artifacts.mjs` is the single source of truth for what a release
ships. Add the workspace to `RELEASE_PACKAGES`, then stage its build output in
the workflow's *Stage artifacts* step. Version stamping and the manifest pick it
up automatically; `scripts/tests/` covers both.
