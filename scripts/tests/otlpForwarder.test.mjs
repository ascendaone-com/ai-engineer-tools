import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logsUrl, parseKeyValues } from "../../examples/otlp-forwarder/forward-otlp.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "otlp-forwarder", "forward-otlp.mjs");

const EVENTS = [
  { schema: "agent-event/v0", id: "e1", time: "2026-10-14T01:02:03.456Z", agent: "claude_code", kind: "session.started", sessionId: "s1", model: "m-1", repoKey: "aabbccdd", branchKey: "0011223344556677", headRepoKey: "ddccbbaa", prMergedAt: "2026-10-14T02:00:00Z" },
  { schema: "agent-event/v0", id: "e2", time: "2026-10-14T01:02:04.000Z", agent: "claude_code", kind: "tool.failed", sessionId: "s1", tool: "Bash", outcome: "failure", promptId: "p1", utcOffsetMinutes: 600 }
];

function fakeReceiver(status = 200) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
}

// Async, so the receiver in this process can answer while the script runs.
function run(home, port, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--once"], {
      env: { PATH: process.env.PATH, ASCENDA_HOME: home, OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`, ...extraEnv }
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

const attr = (record, key) => record.attributes.find((a) => a.key === key)?.value;

test("sends the log as OTLP logs and picks up where it stopped", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "otlp-fwd-"));
  const logFile = path.join(home, "events.jsonl");
  fs.writeFileSync(logFile, `${EVENTS.map((event) => JSON.stringify({ event, payload: { secret: "not forwarded" } })).join("\n")}\nnot json\n`);
  const { server, requests, port } = await fakeReceiver();
  try {
    const first = await run(home, port, {
      OTEL_RESOURCE_ATTRIBUTES: "team.id=platform,department=eng%20ops",
      OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=k1"
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(requests.length, 1);
    const [{ url, headers, body }] = requests;
    assert.equal(url, "/v1/logs");
    assert.equal(headers["x-api-key"], "k1");

    const resource = Object.fromEntries(body.resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
    assert.deepEqual(resource, { "service.name": "ascenda-agent-events", "team.id": "platform", department: "eng ops" });

    const records = body.resourceLogs[0].scopeLogs[0].logRecords;
    assert.equal(records.length, 2);
    assert.equal(records[0].timeUnixNano, `${BigInt(Date.parse(EVENTS[0].time)) * 1_000_000n}`);
    assert.deepEqual(attr(records[0], "session.id"), { stringValue: "s1" });
    assert.deepEqual(attr(records[0], "event.name"), { stringValue: "session.started" });
    assert.deepEqual(attr(records[0], "gen_ai.request.model"), { stringValue: "m-1" });
    assert.deepEqual(attr(records[0], "vcs.repository.id"), { stringValue: "aabbccdd" });
    assert.deepEqual(attr(records[0], "ascenda.vcs.branch_key"), { stringValue: "0011223344556677" });
    assert.deepEqual(attr(records[0], "ascenda.vcs.head_repo_key"), { stringValue: "ddccbbaa" });
    assert.deepEqual(attr(records[0], "ascenda.pr.merged_at"), { stringValue: "2026-10-14T02:00:00Z" });
    assert.deepEqual(attr(records[1], "gen_ai.tool.name"), { stringValue: "Bash" });
    assert.deepEqual(attr(records[1], "ascenda.prompt.id"), { stringValue: "p1" });
    assert.deepEqual(attr(records[1], "ascenda.utc_offset_minutes"), { intValue: "600" });
    assert.equal(records[1].severityText, "ERROR");
    assert.equal(JSON.stringify(body).includes("not forwarded"), false, "only the public event goes out");

    // Nothing new: nothing sent. Then one more line: only that line.
    assert.equal((await run(home, port)).status, 0);
    assert.equal(requests.length, 1);
    fs.appendFileSync(logFile, `${JSON.stringify({ event: { ...EVENTS[0], id: "e3" } })}\n`);
    assert.equal((await run(home, port)).status, 0);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.resourceLogs[0].scopeLogs[0].logRecords.length, 1);
  } finally {
    server.close();
  }
});

test("a receiver that answers 503 keeps the place, so the events go again", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "otlp-fwd-"));
  fs.writeFileSync(path.join(home, "events.jsonl"), `${JSON.stringify({ event: EVENTS[0] })}\n`);
  const down = await fakeReceiver(503);
  try {
    assert.equal((await run(home, down.port)).status, 0);
    assert.equal(down.requests.length, 1);
  } finally {
    down.server.close();
  }
  const up = await fakeReceiver();
  try {
    assert.equal((await run(home, up.port)).status, 0);
    assert.equal(up.requests.length, 1);
  } finally {
    up.server.close();
  }
});

test("endpoint variables follow the OpenTelemetry rules", () => {
  assert.equal(logsUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/" }), "http://c:4318/v1/logs");
  assert.equal(logsUrl({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://c/custom" }), "http://c/custom");
  assert.equal(logsUrl({}, "http://c:4318"), "http://c:4318/v1/logs");
  assert.equal(logsUrl({}), undefined);
  assert.deepEqual(parseKeyValues("a=1, b=x%2Cy,bad"), { a: "1", b: "x,y" });
});
