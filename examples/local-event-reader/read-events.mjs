#!/usr/bin/env node
// Reads the local event log the collectors write and shows what your coding
// agents did. Plain Node 20, no dependencies, no Ascenda code, no account.
//
//   node read-events.mjs              one summary per session
//   node read-events.mjs --follow     print each event as it lands
//   node read-events.mjs <file>       read a different log
//
// The log is ~/.ascenda/events.jsonl unless ASCENDA_EVENT_LOG_FILE or
// `setup --event-log <path>` says otherwise. An unpaired install writes it by
// default. It rotates at 5 MB to events.jsonl.1, which the summary reads too.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const args = process.argv.slice(2);
const follow = args.includes("--follow");
const file = args.find((arg) => !arg.startsWith("--")) ?? defaultLogPath();

function defaultLogPath() {
  const configured = process.env.ASCENDA_EVENT_LOG_FILE?.trim();
  if (configured && configured.toLowerCase() !== "off") return configured.replace(/^~(?=$|\/)/, os.homedir());
  return path.join(process.env.ASCENDA_HOME ?? path.join(os.homedir(), ".ascenda"), "events.jsonl");
}

/** One log line to the few fields this reader shows, or undefined for a line it can't use. */
function parse(line) {
  if (!line.trim()) return undefined;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined; // A half-written last line while an agent is mid-write.
  }
  const payload = entry?.payload;
  if (!payload?.eventType) return undefined;
  return {
    time: new Date(payload.occurredAt ?? entry.loggedAt),
    agent: payload.metadata?.host ?? payload.source,
    session: payload.sessionId ?? "(no session)",
    type: payload.eventType,
    tool: payload.metadata?.toolName
  };
}

const AGENT_NAMES = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini_cli: "Gemini CLI",
  windsurf: "Windsurf",
  vscode_extension: "VS Code"
};
const agentName = (agent) => AGENT_NAMES[agent] ?? agent;
const clock = (time) => time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function readAll() {
  const lines = [];
  for (const candidate of [`${file}.1`, file]) {
    try {
      lines.push(...fs.readFileSync(candidate, "utf8").split("\n"));
    } catch {
      // The rotated file usually doesn't exist yet.
    }
  }
  return lines.map(parse).filter(Boolean);
}

function summarise(events) {
  if (events.length === 0) {
    console.log(`No events in ${file} yet.`);
    console.log("Run an agent with an unpaired install, or turn the log on with `setup --event-log`.");
    return;
  }
  const sessions = new Map();
  for (const event of events) {
    const key = `${event.agent}\u0000${event.session}`;
    const s = sessions.get(key) ?? { agent: event.agent, session: event.session, first: event.time, last: event.time, prompts: 0, tools: 0, failures: 0, byTool: new Map() };
    if (event.time < s.first) s.first = event.time;
    if (event.time > s.last) s.last = event.time;
    if (event.type === "ai_prompt_submitted") s.prompts++;
    if (event.type === "ai_tool_call_started") {
      s.tools++;
      if (event.tool) s.byTool.set(event.tool, (s.byTool.get(event.tool) ?? 0) + 1);
    }
    if (event.type === "ai_tool_call_failed") s.failures++;
    sessions.set(key, s);
  }
  const ordered = [...sessions.values()].sort((a, b) => a.last - b.last);
  for (const s of ordered) {
    const minutes = Math.round((s.last - s.first) / 60000);
    const top = [...s.byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([tool, n]) => `${tool} ${n}`).join(", ");
    console.log(`${s.first.toLocaleString()}  ${agentName(s.agent)}  ${minutes} min`);
    console.log(`  ${s.prompts} prompts, ${s.tools} tool calls, ${s.failures} failed${top ? `  (${top})` : ""}`);
    console.log(`  session ${s.session}`);
  }
}

function printEvent(event) {
  const tool = event.tool ? ` ${event.tool}` : "";
  console.log(`${clock(event.time)}  ${agentName(event.agent).padEnd(12)} ${event.type}${tool}`);
}

/** Polls rather than watching: fs.watch misses appends on some filesystems, and a rename on rotation. */
function tail() {
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {
    // Not created yet; start from the beginning once it is.
  }
  let partial = "";
  console.log(`Watching ${file}. Ctrl-C to stop.`);
  setInterval(() => {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // Rotated: the new file starts empty.
    if (size === offset) return;
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    fs.closeSync(fd);
    offset = size;
    const lines = (partial + buffer.toString("utf8")).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const event = parse(line);
      if (event) printEvent(event);
    }
  }, 500);
}

if (follow) tail();
else summarise(readAll());
