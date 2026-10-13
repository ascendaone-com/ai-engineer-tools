# AGENTS.md

## This repository is public

`ascendaone-com/ai-engineer-tools` is a public GitHub repository under
Apache-2.0. Everything committed here — source, comments, docs, test
fixtures, commit messages, PR descriptions — is world-readable the moment it
is pushed, and stays readable afterwards: a force-push does not remove a diff
already visible on a pull request, and orphaned commits remain reachable by
SHA. Write every line as if a competitor and a customer will both read it,
because the cost of getting this wrong is not recoverable by editing later.

The published npm bundles strip comments, so prose in this repo reaches
people through GitHub rather than through releases. That is not a reason to
relax — GitHub is where people actually read it.

### Never commit

- **Internal repository, branch, or service names.** No `asc-core-be`, no
  `asc-ascenda-app-workspace`, no `claude/<branch>` names. Say "the backend",
  "the app workspace", "the backend repo".
- **Internal file paths, class names, or doc titles from other repos.** Not
  `Services/ToolTelemetryCatalog.cs`, not `PERSONALISED_INTERVENTION_ENGINE_SPEC.md`,
  not internal test-class names or decision-register IDs. Describe the thing
  by what it does: "the backend's telemetry catalog", "the backend's ingest
  tests".
- **Absolute paths from a developer machine.** No `/Users/<name>/…`. Use a
  placeholder or a repo-relative path.
- **Content from a real person's machine.** Prompt or response text, file
  paths, project, repository or branch names, and anything that names a
  person or a customer. Counts measured on that machine are a different
  thing, and they stay: see "Measured figures" below.
- **A working description of a control that is not yet enforced.** Saying
  "the deployed backend does not check X, so Y currently rides in under Z" is
  an instruction sheet. Record that enforcement is server-side and still
  rolling out, and that shipping is gated on it. Keep the guard, drop the
  bypass.

### Comments: what to keep

The test is **what a maintainer needs versus what a competitor needs.**

Keep: what the code does, the invariant it must preserve, why a rule exists,
what breaks if you change it, which fixtures pin it. A reverse-engineered
store's field names and paths belong in the header comment — the code
implements them anyway, so omitting them hides nothing from an outsider and
costs the next maintainer real time.

### Measured figures: keep them

Counts measured on a real store belong in comments, docs, changelog entries
and PR descriptions. "158 of 983 sessions reported spanning more than a day"
is what makes a rule land, and "on a real store" without the number invites a
reader to assume the case is weaker than it is. Keep counts, sizes, minutes,
ratios and session populations, and say what they were measured on and when.

The line is content, not counts. Publish the number, never the prompt text,
path or name it was counted from. Ask before publishing a figure that could
identify a person, a customer or an internal system.

### Before pushing

Grep your diff for internal names and absolute home paths:

```bash
git diff --cached | grep -nE "asc-core-be|asc-ascenda|/Users/|reference machine|verified live"
```

A hit is not automatically wrong — it is a prompt to ask whether that detail
is load-bearing for a maintainer, or just expensive.

## Mermaid diagrams

GitHub renders ```` ```mermaid ```` blocks, and a parse error replaces the
whole diagram with a red error box. Nothing in CI catches it.

- **No semicolons in labels, notes or messages.** Mermaid reads `;` as the
  end of a statement, so `Note over T: Persist token; re-pair later` breaks
  at the semicolon. Use a comma, or write it as `#59;`.
- **Quote labels that hold brackets or braces.** In a flowchart, `A[GET
  /v1/x/{id}]` is fine but `A[renew (401)]` isn't. Write `A["renew (401)"]`.
- **`end` is a keyword.** A bare `end` in a message or node id closes the
  enclosing `loop`, `alt` or `subgraph`. Capitalise it or quote it.

Paste the block into <https://mermaid.live> before you push. If it renders
there, it renders on GitHub.

## GitHub access

Git and `gh` sign in separately, so check each one on its own.

- **git pushes over SSH.** `origin` points at a host alias in
  `~/.ssh/config` that picks the key for the `ascendaone-com` account. Pushes
  go as that account whatever `gh` says. Don't change the remote to HTTPS.
- **`gh` uses its own token.** A machine can have several GitHub accounts
  signed in to `gh`, and only some can write here. Opening a PR fails with
  "must be a collaborator" when the wrong one is active, and re-running a
  workflow needs admin.

Before any `gh` write (a PR, a review, a run), check which account is active:

```bash
gh auth status
```

If it isn't one with write access, pass that account's token to the one
command and leave the active account alone:

```bash
GH_TOKEN=$(gh auth token --user ascendaone-com) gh pr create --base main
```

Tags and release runs are the maintainer's call. Pushing a `v*.*.*` tag
publishes to npm, the VS Code Marketplace and Open VSX, and can't be taken
back. Ask first, even for a dry run of `release.yml`.
