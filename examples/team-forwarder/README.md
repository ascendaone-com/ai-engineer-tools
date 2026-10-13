# Team forwarder

Two small scripts for getting agent events from several machines into one
place. Node 20, no dependencies, no Ascenda account.

- [`forward-events.mjs`](./forward-events.mjs) runs on each engineer's
  machine. It reads the local event log and posts each line's `event` to an
  endpoint you run, keeping its place across restarts, outages and log
  rotation.
- [`receive-events.mjs`](./receive-events.mjs) is a receiver to try the path
  on one machine. It listens on `127.0.0.1:4480`, drops duplicates and appends
  to `received.jsonl`. It has no authentication, so use your own service for a
  team.

```bash
node examples/team-forwarder/receive-events.mjs &
node examples/team-forwarder/forward-events.mjs --url http://127.0.0.1:4480/ingest --once
```

Before you run it across a team, read
[Collecting from a team](../../docs/TEAM_COLLECTION.md). It covers what to
agree with the people whose machines these are.
