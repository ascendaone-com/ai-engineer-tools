#!/usr/bin/env node
// Sends the agent events on this machine to an HTTP endpoint you run, so a
// team's events can land in one place. Plain Node 20, no dependencies.
//
//   FORWARD_TOKEN=... node forward-events.mjs --url https://events.example.internal/ingest
//   node forward-events.mjs --url ... --once      send what's there now, then exit
//   node forward-events.mjs --url ... --label X   name this machine X (default: a random id)
//
// It reads ~/.ascenda/events.jsonl (or ASCENDA_EVENT_LOG_FILE), takes only
// each line's `event` field, the public agent-event/v0, and POSTs them in
// batches:
//
//   { "forwarder": "agent-events-forwarder/1", "source": "<label>", "events": [ ... ] }
//
// A 2xx moves its place in the file forward. Anything else keeps it, and the
// same events go again on the next try, so the receiver should dedupe on
// `event.id`. Its place is saved in ~/.ascenda/forwarder-state.json, so a
// restart carries on where it stopped. The token comes from FORWARD_TOKEN,
// never the command line, where other users of the machine could read it.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = flag("--url");
const once = args.includes("--once");
if (!url) {
  console.error("usage: forward-events.mjs --url <endpoint> [--label <name>] [--once]");
  process.exit(2);
}

const home = process.env.ASCENDA_HOME ?? path.join(os.homedir(), ".ascenda");
const configured = process.env.ASCENDA_EVENT_LOG_FILE?.trim();
const logFile = configured && configured.toLowerCase() !== "off"
  ? configured.replace(/^~(?=$|\/)/, os.homedir())
  : path.join(home, "events.jsonl");
const stateFile = path.join(home, "forwarder-state.json");

const BATCH = 200;
const POLL_MS = 5000;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

const state = readState();
// A random id, so the receiver can count machines without being told whose
// they are. Pass --label to choose one; whether it names a person is your
// team's decision, not this script's.
state.label = flag("--label") ?? state.label ?? crypto.randomUUID();
writeState(state);

const inodeOf = (file) => {
  try {
    return fs.statSync(file).ino;
  } catch {
    return undefined;
  }
};

/** Complete lines from `offset` onwards, and where the last complete one ends. */
function readFrom(file, offset) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], end: offset };
  }
  if (size <= offset) return { lines: [], end: size < offset ? 0 : offset };
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(size - offset);
  fs.readSync(fd, buffer, 0, buffer.length, offset);
  fs.closeSync(fd);
  const text = buffer.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { lines: [], end: offset }; // A line still being written.
  return { lines: text.slice(0, lastNewline).split("\n"), end: offset + Buffer.byteLength(text.slice(0, lastNewline + 1)) };
}

function eventsIn(lines) {
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line)?.event;
      if (event?.schema === "agent-event/v0") events.push(event);
    } catch {
      // Not JSON: skip it, never stall on it.
    }
  }
  return events;
}

async function post(events) {
  const headers = { "content-type": "application/json" };
  if (process.env.FORWARD_TOKEN) headers.authorization = `Bearer ${process.env.FORWARD_TOKEN}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ forwarder: "agent-events-forwarder/1", source: state.label, events }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) console.error(`${new Date().toISOString()} ${url} answered ${response.status}; will retry`);
    return response.ok;
  } catch (error) {
    console.error(`${new Date().toISOString()} ${url} unreachable (${error.cause?.code ?? error.message}); will retry`);
    return false;
  }
}

/** Sends one file's new lines from `offset`, batch by batch. Returns the new offset, or undefined to retry later. */
async function drain(file, offset) {
  const { lines, end } = readFrom(file, offset);
  const events = eventsIn(lines);
  for (let i = 0; i < events.length; i += BATCH) {
    // All-or-nothing per read: a failed batch resends the whole read next
    // time, which a receiver deduping on event.id absorbs.
    if (!(await post(events.slice(i, i + BATCH)))) return undefined;
  }
  return end;
}

async function tick() {
  const inode = inodeOf(logFile);
  if (inode === undefined) return; // No log yet.
  const before = `${state.inode}:${state.offset}`;
  if (state.inode !== undefined && inode !== state.inode) {
    // Rotated: the file we were reading is now events.jsonl.1. Finish it
    // first, then start the new file from the top.
    if (inodeOf(`${logFile}.1`) === state.inode) {
      const end = await drain(`${logFile}.1`, state.offset ?? 0);
      if (end === undefined) return;
    }
    state.inode = inode;
    state.offset = 0;
  }
  state.inode = inode;
  const end = await drain(logFile, state.offset ?? 0);
  if (end !== undefined) state.offset = end;
  if (`${state.inode}:${state.offset}` !== before) writeState(state);
}

await tick();
if (!once) {
  console.log(`Forwarding ${logFile} to ${url} as ${state.label}. Ctrl-C to stop.`);
  let busy = false;
  setInterval(async () => {
    if (busy) return; // A slow endpoint mustn't stack up overlapping sends.
    busy = true;
    try {
      await tick();
    } finally {
      busy = false;
    }
  }, POLL_MS);
}
