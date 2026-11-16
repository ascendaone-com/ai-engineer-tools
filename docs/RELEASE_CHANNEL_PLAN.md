# Release Channel Plan

Two changes to how a release reaches people. The update note says what
changed, not just that something did. And the Claude Code plugin moves from
"whatever is on `main`" to a pinned commit, so merging a PR is no longer a
plugin release. Line numbers are against `main` at `badbcf6`.

Status: both parts implemented in this PR. The two parts touch different files and can land apart.

## Part 1: the update note says what changed

### Today

`pendingReleaseNotice` (`packages/tool-kit/src/releaseCheck.ts:216-242`)
writes "the Ascenda hooks here are 0.1.41, and 0.1.43 is out. Run …". The
person learns a version number and a chore. Nothing tells them why the chore
is worth doing, and the changelog section that says so already exists for
every tag: `release.yml` refuses to build a tag without one
(`scripts/release-notes.mjs`, run at `release.yml:83-84`).

### Change

1. **Manifest.** In `scripts/release-manifest.mjs`, `buildManifest`
   (lines 28-56), add `summary`: the first paragraph of the tag's
   changelog section, read with the existing `releaseNotes({ tag })` from
   `scripts/release-notes.mjs`, stripped of Markdown links and emphasis, cut
   at the last sentence end before 200 characters. A section whose first
   paragraph is a list uses the first bullet. Add a test in
   `scripts/tests/` with a section of each shape.
2. **Check.** In `releaseCheck.ts`, `fetchManifest` (lines 165-183) reads
   `summary` when it's a string of at most 200 characters, and stores it as
   `latestSummary` on `ReleaseCheck`. Anything else is ignored; a manifest
   without it is fine.
3. **Note.** `pendingReleaseNotice` appends ` What's new: <summary>` after
   the version sentence, for the `behind` case only. The `unsupported` note
   stays as it is: it's about a floor, not a feature.
4. **Status.** `describeReleaseCheck` (line 245) shows the summary on the
   `latest` line when there is one.

The summary is release copy, so the house voice rules that
`scripts/release-notes-voice.mjs` checks already apply to it. Make the
release workflow fail if the derived summary is empty (step 1 throws).

### Tests

- `releaseCheck` test: a manifest with `summary` stores it; one with a
  300-character or non-string `summary` doesn't; the `behind` note carries
  it and the `unsupported` note doesn't.
- Manifest test as above.

## Part 2: the plugin ships from a pinned commit

### Today

`.claude-plugin/marketplace.json` names the plugin with
`"source": "./ascenda-agent-skills"`, a path in the same repository, so
`/plugin marketplace add ascendaone-com/ai-engineer-tools` serves whatever
`main` holds. `RELEASING.md` (lines 80-110) says so: "A merge to `main` is a
plugin release." A half-finished plugin change merged for review reaches
every plugin user on their next marketplace refresh.

### Change

Use the marketplace's `git-subdir` source, which takes a commit:

```json
{
  "name": "ascenda",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/ascendaone-com/ai-engineer-tools.git",
    "path": "ascenda-agent-skills",
    "ref": "main",
    "sha": "<40-char commit>"
  },
  …
}
```

1. Switch the entry to that shape, with `sha` set to the commit of the
   current plugin release (the merge that set `plugin.json` to 0.3.1).
2. **Promotion.** A plugin release becomes a PR that changes only `sha` (and
   `version` in both `marketplace.json` and `plugin.json`, which
   `scripts/tests/releasePackages.test.mjs` already keeps in step). Write
   the steps in `RELEASING.md`, replacing "Plugin distribution is not
   tag-driven".
3. **Merge method.** The pinned `sha` must exist on `main` after merge. A
   squash merge rewrites commits, so the promotion PR must point at a commit
   already on `main`: merge the plugin change first, then open the promotion
   PR naming that merge commit. Say this in `RELEASING.md`.
4. **Guard.** Add a test to `scripts/tests/releasePackages.test.mjs` that
   the `sha` is 40 hex characters, and add to `scripts/check-dry.sh` (the
   repo's guard-rail script, run by `npm run verify`) a check that
   `git merge-base --is-ancestor <sha> HEAD` succeeds.
5. Validate with `claude plugin validate ./ascenda-agent-skills --strict`,
   then add the marketplace from a scratch Claude Code config dir and
   confirm it installs the pinned version. Record the result in the PR.

### Check first

Before switching, confirm on the current Claude Code release that a
marketplace added by `owner/repo` honours `git-subdir` with `sha` for a
plugin in the same repository, and that a refresh with an unchanged `sha`
doesn't re-download. If it doesn't, stop and record what it did here.

Result (Claude Code 2.1.316, scratch `CLAUDE_CONFIG_DIR`, marketplace added
from a local checkout carrying the new entry): it works.

- `claude plugin validate ./ascenda-agent-skills --strict` passes.
- Install resolves the pinned commit. `installed_plugins.json` records
  `gitCommitSha` equal to the `sha`, and pinning the 0.2.2 commit installed
  0.2.2 though `main` holds 0.3.1.
- `marketplace update` and `plugin update` with the same `sha` say "already at
  the latest version" and leave the cache untouched.
- Moving `sha` to the 0.3.1 commit and updating installed 0.3.1 beside 0.2.2.

## Done when

- `npm run verify` passes.
- Running `node scripts/release-manifest.mjs --tag <last tag> --dir <a
  folder with one dummy file> --repo ascendaone-com/ai-engineer-tools`
  locally prints a manifest with `summary`.
- The plugin installs from the pinned commit in a clean config dir.
- `RELEASING.md` describes the promotion step.
- `CHANGELOG.md` has a line under the unreleased heading for Part 1.
