#!/usr/bin/env node
// A receiver to try the forwarder against: it accepts batches on
// http://127.0.0.1:4480/ingest, drops events it has already seen, and appends
// the rest to received.jsonl with the forwarder's `source` beside each one.
// For trying things out on one machine. It has no authentication and listens
// on loopback only. Use your own service for a team.
//
//   node receive-events.mjs [--port 4480] [--out received.jsonl]

import * as fs from "node:fs";
import * as http from "node:http";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(flag("--port", "4480"));
const out = flag("--out", "received.jsonl");

const seen = new Set();
try {
  for (const line of fs.readFileSync(out, "utf8").split("\n")) if (line) seen.add(JSON.parse(line).event.id);
} catch {
  // First run.
}

http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/ingest") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let batch;
    try {
      batch = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let added = 0;
    for (const event of batch.events ?? []) {
      if (!event?.id || seen.has(event.id)) continue;
      seen.add(event.id);
      fs.appendFileSync(out, `${JSON.stringify({ source: batch.source, event })}\n`);
      added++;
    }
    console.log(`${new Date().toISOString()} ${batch.source}: ${added} new, ${(batch.events?.length ?? 0) - added} already had`);
    res.writeHead(204).end();
  });
}).listen(port, "127.0.0.1", () => console.log(`Listening on http://127.0.0.1:${port}/ingest, writing ${out}`));
