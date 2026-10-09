# @ascenda-one/github-collector

The collaboration signal family (consolidated report §4.2): review load and
pull-request activity, collected from a code forge.

## What it emits

| Event | Meaning | Workload leg |
|---|---|---|
| `review_requested_of_me` | someone asked **you** to review | supervision |
| `review_given` | **you** submitted a review | supervision |
| `pull_request_opened` | **you** opened a pull request | creation |

The two review events are the report's *verification overload* concern — the
checking burden that concentrates on senior engineers as a team adopts AI.

## The rule that shapes the whole package

**Only your own activity is ever emitted.** An event is produced when the
payload says you did the thing or you were asked; a payload about two other
people produces nothing at all. `ASCENDA_FORGE_LOGIN` is required and the
collector refuses to run without it, because falling back to the payload's
actor would silently start recording colleagues.

This is not squeamishness. "Who reviews for whom" is a map of a team, and a
wellbeing rail that assembles one has become a management tool. Concentration
of checking load is still answerable — it shows up in *your own* supervision
share, and in cohort aggregates the org rail already suppresses below its
minimum cohort size.

### What never travels

No repository name, PR title, branch, PR number, review body, or any other
person's login. The repository is reduced to an 8-character hash so that "is it
always the same repository" stays answerable without naming it. There is no
field on the emitted metadata that a title or a body could be placed in, and a
test asserts each of those strings is absent from what gets sent.

### Withdrawal is not derivable, deliberately

There is no "did not review" event and there must never be one. Reviewing less
is exactly the signal the report says must never be machine-interpreted — a
quiet week has too many innocent explanations. Nothing here counts absence.

## Consent

Collaboration events ride **`workflow_telemetry`**, not `ide_telemetry`, and the
collector has its own tool type (`github_collector`). Both are deliberate: a
pull request is not an IDE event, and someone may be willing to share how they
work in their editor and not how they work with their team. The two are
separately revocable.

## Use in GitHub Actions

Ready to copy: [`examples/workflow.yml`](./examples/workflow.yml). Each person
pairs a collector identity of their own,
`npx -y @ascenda-one/claude-code-hooks pair --tool-type github_collector`, which
prints the installation id and names the token file to read. Those go into
repository secrets with that person's suffix, along with their GitHub login.

```yaml
name: ascenda-collaboration
on:
  pull_request:
    types: [opened, review_requested]
  pull_request_review:
    types: [submitted]

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - name: ascenda (octocat)
        run: npx @ascenda-one/github-collector
        env:
          ASCENDA_TOOL_INSTALLATION_ID: ${{ secrets.ASCENDA_TOOL_INSTALLATION_ID_OCTOCAT }}
          ASCENDA_EVENT_WRITE_TOKEN: ${{ secrets.ASCENDA_EVENT_WRITE_TOKEN_OCTOCAT }}
          ASCENDA_FORGE_LOGIN: ${{ secrets.ASCENDA_FORGE_LOGIN_OCTOCAT }}
```

### `ASCENDA_FORGE_LOGIN` is configured, never derived

Set it to the paired person's own login, once, when you store their secrets.
Don't use `${{ github.actor }}`. The actor is whoever triggered the run, and
the installation secrets belong to one person:

- When a colleague opens a pull request or submits a review, they're the
  actor *and* the author, so the event matches and lands under your
  installation. That records a colleague.
- On `review_requested` the actor is the person asking. Your request would
  only match if you'd asked yourself, so `review_requested_of_me` never fires.

The collector can't tell a typed login from one wired to the actor, so this
rule lives in your workflow file.

### One step per participant

A step carries one person's installation, so a repository shared by several
people who've paired needs one step each, every one with its own suffixed
secrets. Each step reads the same payload and emits only its own person's
activity; the others exit with nothing to send. A matrix over the suffixes
works too, with `secrets[format('ASCENDA_FORGE_LOGIN_{0}', matrix.who)]` and
the same for the other two. Bear in mind that anyone who can edit the workflow
can read every participant's write token in a run.

The step exits 0 on every path that is not a configuration error, including
"nothing to emit". A telemetry step must never be the reason a build goes red.

Locally, pipe a payload instead:

```bash
cat examples/sample-review-submitted.json | ascenda-forge-collect pull_request_review
```
