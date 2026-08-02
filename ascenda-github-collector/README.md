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
      - run: npx @ascenda-one/github-collector
        env:
          ASCENDA_TOOL_INSTALLATION_ID: ${{ secrets.ASCENDA_TOOL_INSTALLATION_ID }}
          ASCENDA_EVENT_WRITE_TOKEN: ${{ secrets.ASCENDA_EVENT_WRITE_TOKEN }}
          ASCENDA_FORGE_LOGIN: ${{ github.actor }}
```

The step exits 0 on every path that is not a configuration error, including
"nothing to emit". A telemetry step must never be the reason a build goes red.

Locally, pipe a payload instead:

```bash
cat examples/sample-review-submitted.json | ascenda-forge-collect pull_request_review
```
