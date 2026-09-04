/**
 * The wire vocabulary guard for this adapter — the same bar
 * `ascenda-history-import/tests/wireVocabulary.test.mjs` holds its extractors
 * to, applied to a live hook mapper. See the Cursor adapter's copy for the
 * three silent drifts this exists to catch; the assertions are identical
 * across adapters, only the fixtures differ.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_METADATA_FIELDS, EVENT_WORKLOAD_CATEGORY, METRIC_KEYS } from "@ascenda-one/tool-contract";
import { mapWindsurfEvent } from "../dist/mapWindsurfEvent.js";
import { WINDSURF_HOST } from "../dist/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../src");
const CLI = path.resolve(HERE, "../dist/cli.js");
const CANONICAL = new Set(Object.keys(EVENT_WORKLOAD_CATEGORY));
const REGISTERED_KEYS = new Set([...EVENT_METADATA_FIELDS, ...Object.keys(METRIC_KEYS)]);
const CONTEXT_KEYS = new Set(["contextWindowPeakPct", "contextUsagePercent"]);

/** One input per branch the mapper can take. Extend when a branch is added. */
const FIXTURES = [
  ["pre_user_prompt", { tool_info: { user_prompt: "that is wrong, try again" } }],
  ["pre_read_code", { tool_info: { file_path: "/p/a.ts" } }],
  ["post_read_code", { tool_info: { file_path: "/p/a.ts" } }],
  ["pre_write_code", { tool_info: { file_path: "/p/a.ts" } }],
  ["post_write_code", { tool_info: { file_path: "/p/a.ts" } }],
  ["pre_run_command", { tool_info: { command_line: "npm test", cwd: "/p" } }],
  ["post_run_command", { tool_info: { command_line: "npm test", cwd: "/p" } }],
  ["post_run_command", { tool_info: { command_line: "git status", cwd: "/p" } }],
  ["pre_mcp_tool_use", { tool_info: { mcp_tool_name: "search" } }],
  ["post_mcp_tool_use", { tool_info: { mcp_tool_name: "search", mcp_result: { isError: true } } }],
  ["post_mcp_tool_use", { tool_info: { mcp_tool_name: "search", mcp_result: { content: "hits" } } }],
  ["post_cascade_response", {}, 45 * 60000],
  ["post_cascade_response", {}, 90 * 60000]
];

function emitted() {
  return FIXTURES.flatMap(([hook, input, turnMs]) => mapWindsurfEvent(hook, { agent_action_name: hook, ...input }, turnMs));
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []
  );
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("every eventType this adapter emits is in the catalog", () => {
  const offenders = [];
  const seen = new Set();
  for (const file of sourceFiles(SRC)) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/eventType:\s*"([^"]+)"/g)) {
      seen.add(m[1]);
      if (!CANONICAL.has(m[1])) offenders.push(`${path.relative(SRC, file)}: ${m[1]}`);
    }
  }
  assert.ok(seen.size > 0, "found no eventType literals — did the scan path break?");
  assert.deepEqual(offenders, [], `off-catalog event types would ship as unclassified:\n  ${offenders.join("\n  ")}`);
  for (const event of emitted()) assert.ok(CANONICAL.has(event.eventType), `${event.eventType} is not in the catalog`);
});

test("every metadata key this adapter emits is a wire field or a registered metric key", () => {
  const events = emitted();
  assert.ok(events.length >= FIXTURES.length - 1, "the fixtures no longer reach the mapper's branches");
  const offenders = new Set();
  const seen = new Set();
  for (const event of events) {
    for (const key of Object.keys(event.metadata ?? {})) {
      seen.add(key);
      if (!REGISTERED_KEYS.has(key)) offenders.add(`${event.eventType}.${key}`);
    }
  }
  assert.ok(seen.has("host") && seen.has("durationBucket"), "expected at least the host tag and a duration bucket");
  assert.deepEqual([...offenders], [], `keys nothing downstream can read:\n  ${[...offenders].join("\n  ")}`);
});

test("context occupancy, when reported, rides a registered unit-bearing key as a fraction", () => {
  // Cascade has no compaction hook, so no reading is expected; the assertion
  // still runs so a future branch that adds one cannot improvise a spelling.
  for (const event of emitted()) {
    for (const [key, value] of Object.entries(event.metadata ?? {})) {
      if (!/context/i.test(key)) continue;
      assert.ok(CONTEXT_KEYS.has(key), `${key} is an improvised context spelling — use contextWindowPeakPct or contextUsagePercent`);
      if (key === "contextWindowPeakPct") assert.ok(value >= 0 && value <= 1.5, `${key}=${value} does not look like a fraction`);
    }
  }
});

const SUPERSEDED_DIALECT = ["0-5m", "5-30m", "30m-2h", "2-8h", "8-24h", "24h+"];

test("the adapter mints no duration vocabulary of its own", () => {
  const offenders = [];
  for (const file of sourceFiles(SRC)) {
    const text = stripComments(fs.readFileSync(file, "utf8"));
    for (const bucket of SUPERSEDED_DIALECT) {
      if (text.includes(`"${bucket}"`) || text.includes(`'${bucket}'`)) offenders.push(`${path.relative(SRC, file)}: ${bucket}`);
    }
  }
  assert.deepEqual(offenders, [], `superseded duration buckets would read as 0 minutes:\n  ${offenders.join("\n  ")}`);
});

test("every file that sets durationBucket routes through the shared bucketer", () => {
  const offenders = [];
  let checked = 0;
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    if (!/durationBucket[:\s,}]/.test(text)) continue;
    checked++;
    if (!text.includes("bucketDurationMs")) offenders.push(path.relative(SRC, file));
  }
  assert.ok(checked > 0, "found no durationBucket producers — did the scan path break?");
  assert.deepEqual(offenders, [], `these set durationBucket without bucketDurationMs:\n  ${offenders.join("\n  ")}`);
});

test("the built CLI puts the UTC offset and an idempotency key on every wire payload", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-guard-home-"));
  const logFile = path.join(home, "events.jsonl");
  const [hook, input] = FIXTURES[6];
  // Cascade names the hook on stdin, so no argv — one command serves every hook.
  const result = spawnSync("node", [CLI], {
    input: JSON.stringify({ agent_action_name: hook, trajectory_id: "ws-1", ...input }),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      ASCENDA_HOME: home,
      ASCENDA_STATE_DIR: path.join(home, "state"),
      ASCENDA_EVENT_LOG_FILE: logFile,
      ASCENDA_TOOL_INSTALLATION_ID: "",
      ASCENDA_EVENT_WRITE_TOKEN: ""
    }
  });
  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lines.length >= 1, "the CLI logged nothing");
  for (const { delivery, payload } of lines) {
    assert.equal(delivery, "not_sent");
    assert.equal(payload.metadata.host, WINDSURF_HOST);
    assert.ok(Number.isInteger(payload.utcOffsetMinutes), `utcOffsetMinutes missing: ${JSON.stringify(payload)}`);
    assert.match(payload.idempotencyKey, /^[0-9a-f-]{36}$/, "the idempotency key is minted at construction, by the shared sender");
    assert.equal(payload.source, "cli_agent");
    for (const key of Object.keys(payload.metadata)) assert.ok(REGISTERED_KEYS.has(key), `${key} reached the wire unregistered`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});
