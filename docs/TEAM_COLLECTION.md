# Collecting from a team

Each engineer's collectors write agent events to a file on their own
machine. This guide gets those events from several machines into one place
you run, so you can build your own view of how agent work goes across the
team. It needs no Ascenda account.

## Before you start

Events from one person's machine describe how that person works. Centralise
them and you're holding workplace data about named colleagues, so settle these
first:

- **Each engineer installs the collectors and the forwarder themselves**, and
  can read the file it sends from (`~/.ascenda/events.jsonl`). Nobody should be
  enrolled without knowing.
- **Write down the purpose.** "Understand how agent work goes across the team"
  is a purpose. Performance reviews are a different one, and people will
  reasonably say no to it.
- **Show aggregates, not people.** Report on the team, and hide any group too
  small to keep one person's numbers from showing.
- **Decide who can see the raw events, and for how long you keep them.**
- **Keep machines pseudonymous.** The forwarder labels each machine with a
  random id unless you pass `--label`. Whether a label names a person is your
  call, and the answer belongs in the written purpose.

What applies to you depends on where you are and how you employ people. Treat
this list as a starting point, not legal advice.

## What gets sent

Only the `event` field of each log line: the public
[agent event, v0](../packages/agent-events/). Which agent, what happened, which
tool, how it ended, when, and the agent's session id. Never prompt text, file
contents, file names, command lines or command output. The collectors don't
record those in the first place.

The forwarder posts batches like this:

```json
{
  "forwarder": "agent-events-forwarder/1",
  "source": "77991d0e-…",
  "events": [
    { "schema": "agent-event/v0", "id": "…", "time": "2026-10-13T00:23:59.211Z",
      "agent": "claude_code", "kind": "tool.started", "tool": "Read", "sessionId": "s1" }
  ]
}
```

`source` is the machine's label. `projectHash` in an event is salted on each
machine, so the same repository hashes differently on two laptops. To group by
repository across machines, use `repoKey`: it's the same digest everywhere, for
GitHub repositories. `branchKey` is the same for a branch, so a session can be
matched to the pull request on that branch. Both come with a catch: they aren't
salted, so anyone holding your events can check a guess at a repository or
branch name. Engineers can turn them off with `setup --no-repo-keys`, and then
you're back to `source` and `sessionId`. See
[Matching a session to a pull request](../packages/agent-events/README.md#matching-a-session-to-a-pull-request).

## Set it up

**1. Install the collectors on each machine without pairing.** An unpaired
install writes the event file by default:

```bash
npx -y @ascenda-one/claude-code-hooks setup --no-pair   # or codex-, cursor-, gemini-, windsurf-hooks
```

A machine that's also paired with Ascenda keeps the file with
`setup --event-log`.

**2. Run a receiver.** Anything that accepts a JSON `POST` will do: a small
service of your own, a serverless function, or an ingest endpoint you already
have. It should:

- check a bearer token,
- drop events whose `id` it has already stored, because the forwarder resends
  a batch after any failure,
- store `source` beside each event.

To try the whole path on one machine first,
[`receive-events.mjs`](../examples/team-forwarder/receive-events.mjs) does
exactly that on `127.0.0.1:4480`, with no token check, and appends to
`received.jsonl`.

**3. Run the forwarder on each machine.**
[`forward-events.mjs`](../examples/team-forwarder/forward-events.mjs) is one
file, Node 20, no dependencies:

```bash
FORWARD_TOKEN=... node forward-events.mjs --url https://events.example.internal/ingest
```

It reads only new lines, posts them every five seconds, and saves its place in
`~/.ascenda/forwarder-state.json`, so a restart carries on where it stopped.
When the endpoint is down it keeps its place and tries again. It follows the
log when it rotates at 5 MB. `--once` sends what's there and exits, which suits
a scheduled job. The token is read from `FORWARD_TOKEN`, never the command
line. Run it under whatever your team uses for background jobs.

Any log shipper that can tail a JSON-lines file works too. Read the `event`
field and leave the rest: everything else on the line follows Ascenda's
internal contract and can change in any release.

## What counts can tell you

With events in one place you can see how many agents run at once, which tools
fail most, how often agents stop to wait for someone, when the work happens,
and how all of that moves week to week.

Counts can't tell you whether a busy week was a good one, whether a change you
made helped, or how your team compares with others. That takes each person's
own read of their days, a baseline for each person, and other teams to compare
with. It's what we're building the
[Founding Benchmark](https://www.ascendaflow.com/benchmark?source=github) for,
with consent and small-group suppression built in.

## Building something with this?

Tell us what you're measuring, and what's missing from the events, in an
[issue](https://github.com/ascendaone-com/ai-engineer-tools/issues/new/choose).
That's what shapes v1 of the format.
