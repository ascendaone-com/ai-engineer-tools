# Privacy and what this measures

What the collectors send, where it goes, and what the numbers do and don't tell you.

## Local first

The collectors work in two ways, and the first needs no account:

- **On your machine only.** The hooks write every event to
  `~/.ascenda/events.jsonl` and send a live signal to a socket on your Mac,
  which Waterline and the Flow app read. Nothing leaves the machine.
- **With your Ascenda account.** [Pair](./PAIRING.md) a tool once and its events
  go to Ascenda, so your sessions appear in Flow and on your weekly poster. The live signal
  keeps working, and `setup --event-log` keeps the local file as well.

Workspace and project identifiers are hashed with a random salt generated on
first run and stored only at `~/.ascenda/salt`. It is never sent, so those
hashes can't be turned back into folder or repository names by anyone holding
the telemetry. Deleting the file resets them.

The repository and branch keys aren't salted. For a GitHub repository, each
event carries `repoKey`, a digest of `owner/repo`, and off the default branch a
`branchKey`. The [GitHub collector](../ascenda-github-collector/) runs in a
workflow step, where no salt exists, and puts the same keys on pull request
events, so a session can be
[matched to its pull request](../packages/agent-events/README.md#matching-a-session-to-a-pull-request).
Its 8-character project digest is unsalted for the same reason. Anyone holding
your events can check a guess at a repository or branch name, and for a public
repository the name is public anyway. The keys are on by default, set only for
github.com remotes, and off with `setup --no-repo-keys` or
`ASCENDA_REPO_KEYS=off`.

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

## What this measures

**What it records.** Events you can name: prompts and corrections, tool
calls and how they ended, test and build runs, context compaction, how long
agent loops run, how many agents are going at once, and work outside your
usual hours. Counts and classifications, set against your own history.

**What we're testing.** Whether patterns like these shift before you notice
the work getting heavier, and whether your own baseline shows that sooner than
you'd see it yourself. That's the question the collectors were built to
answer. We don't have the answer yet.

**What's still open.** No published study yet links agent activity like this
to a validated measure of workload, and our own calibration study hasn't run.
Today the collectors count what happened and show it against your history.
The source is here, so you can check exactly what that means.

Wire contract: [Tool Pairing API Reference](../api-docs/TOOL_PAIRING_API_REFERENCE.md).
