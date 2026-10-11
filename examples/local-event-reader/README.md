# Local event reader

A small script that reads the event log the collectors keep on your machine
and shows what your coding agents did. It needs Node 20 and nothing else: no
Ascenda account, no pairing, no packages from this repo.

## Get some events

Install any of the agent hooks without pairing. An unpaired install writes
every event to `~/.ascenda/events.jsonl`:

```bash
npx @ascenda-one/claude-code-hooks setup --no-pair
```

Codex, Cursor, Gemini CLI and Windsurf take the same `--no-pair` flag. A
paired install can keep the same file too:

```bash
npx @ascenda-one/claude-code-hooks setup --event-log
```

## Read them

```bash
node examples/local-event-reader/read-events.mjs
```

One summary per agent session: when it started, how long it ran, prompts,
tool calls and failures, and the tools it used most.

```bash
node examples/local-event-reader/read-events.mjs --follow
```

Prints each event as it lands, which is a quick way to see what a hook sends.

## What's in the file

One JSON object per line. `payload` is the event exactly as a paired install
would send it. It's metadata only: event types, tool names, size and duration
buckets, hashed project ids. No prompt text, file contents, file names or
command output ever appear in it.

The log rotates at 5 MB to `events.jsonl.1`, so it never takes more than about
10 MB. To stop it, run `setup --event-log off`, or set
`ASCENDA_EVENT_LOG_FILE=off`.
