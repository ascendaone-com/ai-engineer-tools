#!/usr/bin/env node
// Sends the agent events on this machine to an OpenTelemetry collector as
// OTLP/HTTP logs (JSON encoding). Plain Node 20, no dependencies.
//
//   node forward-otlp.mjs --endpoint http://localhost:4318
//   node forward-otlp.mjs --endpoint ... --once     send what's there now, then exit
//
// The endpoint, headers and resource attributes follow the standard
// environment variables, so it fits where other OpenTelemetry senders already
// run:
//
//   OTEL_EXPORTER_OTLP_ENDPOINT        base URL, /v1/logs is added
//   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT   the full logs URL, used as given
//   OTEL_EXPORTER_OTLP_HEADERS         k=v,k=v (for an API key)
//   OTEL_RESOURCE_ATTRIBUTES           k=v,k=v (team.id, department, ...)
//   OTEL_SERVICE_NAME                  default "ascenda-agent-events"
//
// It reads ~/.ascenda/events.jsonl (or ASCENDA_EVENT_LOG_FILE), takes only
// each line's `event` field, the public agent-event/v0, and sends one log
// record per event. The field-to-attribute mapping is in
// packages/agent-events/README.md. Its place in the file is saved in
// ~/.ascenda/otlp-forwarder-state.json, so a restart carries on where it
// stopped. OTLP has no dedupe, so a send that failed after the collector
// took it arrives twice; `ascenda.event.id` lets you drop the copy.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCOPE = { name: "ascenda-agent-events-otlp-forwarder", version: "1" };

/** k=v,k=v with percent-encoded values, as the OTEL_* variables spell them. */
export function parseKeyValues(text) {
  const out = {};
  for (const pair of (text ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep it as written.
    }
    out[key] = value;
  }
  return out;
}

export function logsUrl(env, flagValue) {
  if (flagValue) return flagValue.replace(/\/+$/, "") + (/\/v1\/logs$/.test(flagValue) ? "" : "/v1/logs");
  if (env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) return env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) return `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, "")}/v1/logs`;
  return undefined;
}

const str = (key, value) => (value === undefined || value === null || value === "" ? [] : [{ key, value: { stringValue: String(value) } }]);

/** The attributes for one event. Fields with no OpenTelemetry name go under `ascenda.`. */
export function attributesFor(event) {
  return [
    ...str("event.name", event.kind),
    ...str("session.id", event.sessionId),
    ...str("gen_ai.agent.name", event.agent),
    ...str("gen_ai.tool.name", event.tool),
    ...str("gen_ai.request.model", event.model),
    ...str("vcs.repository.id", event.repoKey),
    ...str("ascenda.vcs.branch_key", event.branchKey),
    ...str("ascenda.vcs.action", event.vcsAction),
    ...str("ascenda.prompt.id", event.promptId),
    ...str("ascenda.subagent.id", event.subagentId),
    ...str("ascenda.outcome", event.outcome),
    ...str("ascenda.wait.reason", event.reason),
    ...str("ascenda.duration_bucket", event.durationBucket),
    ...str("ascenda.project_hash", event.projectHash),
    ...str("ascenda.event.id", event.id),
    ...str("ascenda.collector.version", event.collectorVersion),
    ...(typeof event.utcOffsetMinutes === "number"
      ? [{ key: "ascenda.utc_offset_minutes", value: { intValue: String(event.utcOffsetMinutes) } }]
      : [])
  ];
}

export function logRecord(event) {
  const ms = Date.parse(event.time);
  const nanos = Number.isFinite(ms) ? `${BigInt(ms) * 1_000_000n}` : undefined;
  return {
    ...(nanos ? { timeUnixNano: nanos } : {}),
    observedTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
    severityNumber: event.kind === "tool.failed" ? 17 : 9,
    severityText: event.kind === "tool.failed" ? "ERROR" : "INFO",
    body: { stringValue: event.kind },
    attributes: attributesFor(event)
  };
}

export function exportRequest(events, resourceAttributes) {
  return {
    resourceLogs: [
      {
        resource: { attributes: Object.entries(resourceAttributes).flatMap(([k, v]) => str(k, v)) },
        scopeLogs: [{ scope: SCOPE, logRecords: events.map(logRecord) }]
      }
    ]
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const once = args.includes("--once");
  const url = logsUrl(process.env, flag("--endpoint"));
  if (!url) {
    console.error("usage: forward-otlp.mjs --endpoint <url> [--once]  (or set OTEL_EXPORTER_OTLP_ENDPOINT)");
    process.exit(2);
  }
  const resourceAttributes = {
    "service.name": process.env.OTEL_SERVICE_NAME ?? "ascenda-agent-events",
    ...parseKeyValues(process.env.OTEL_RESOURCE_ATTRIBUTES)
  };
  const extraHeaders = parseKeyValues(process.env.OTEL_EXPORTER_OTLP_HEADERS);

  const home = process.env.ASCENDA_HOME ?? path.join(os.homedir(), ".ascenda");
  const configured = process.env.ASCENDA_EVENT_LOG_FILE?.trim();
  const logFile = configured && configured.toLowerCase() !== "off"
    ? configured.replace(/^~(?=$|\/)/, os.homedir())
    : path.join(home, "events.jsonl");
  const stateFile = path.join(home, "otlp-forwarder-state.json");
  const BATCH = 200;
  const POLL_MS = 5000;

  const readState = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return {};
    }
  };
  const writeState = (s) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  };
  const state = readState();

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
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
        body: JSON.stringify(exportRequest(events, resourceAttributes)),
        signal: AbortSignal.timeout(10_000)
      });
      if (response.ok) return true;
      // A 400 or 422 won't get better by resending the same batch; skip it
      // rather than stall the log behind it.
      if (response.status === 400 || response.status === 422) {
        console.error(`${new Date().toISOString()} ${url} rejected a batch of ${events.length} (${response.status}); skipped`);
        return true;
      }
      console.error(`${new Date().toISOString()} ${url} answered ${response.status}; will retry`);
      return false;
    } catch (error) {
      console.error(`${new Date().toISOString()} ${url} unreachable (${error.cause?.code ?? error.message}); will retry`);
      return false;
    }
  }

  async function drain(file, offset) {
    const { lines, end } = readFrom(file, offset);
    const events = eventsIn(lines);
    for (let i = 0; i < events.length; i += BATCH) {
      if (!(await post(events.slice(i, i + BATCH)))) return undefined;
    }
    return end;
  }

  async function tick() {
    const inode = inodeOf(logFile);
    if (inode === undefined) return; // No log yet.
    const before = `${state.inode}:${state.offset}`;
    if (state.inode !== undefined && inode !== state.inode) {
      // Rotated: finish the old file (now events.jsonl.1), then start the new one.
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
    console.log(`Forwarding ${logFile} to ${url}. Ctrl-C to stop.`);
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await tick();
      } finally {
        busy = false;
      }
    }, POLL_MS);
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
