/**
 * The wire vocabulary guard for this adapter — the same bar
 * `ascenda-history-import/tests/wireVocabulary.test.mjs` holds its extractors
 * to, applied to a live hook mapper.
 *
 * Three drifts have each shipped silently from this repo: an event name the
 * catalog had never heard of (bucketed `unclassified`), a `metrics` key
 * spelled the way the host spells it rather than the way the reader does
 * (~8,720 rows read as "not collected"), and a home-grown duration dialect
 * (every bucket resolved to 0 minutes). None raised anywhere — the compiler
 * accepted them, ingestion accepted them, the gauge showed a dash. So each
 * is checked here, at runtime, against the contract's own lists, and the
 * built CLI is run once end to end to prove the shared sender puts the UTC
 * offset and the idempotency key on the wire. A fifth adapter copies this
 * file and its fixtures; the assertions do not change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_METADATA_FIELDS, EVENT_WORKLOAD_CATEGORY, METRIC_KEYS } from "@ascenda-one/tool-contract";
import { mapCursorEvent } from "../dist/mapCursorEvent.js";
import { CURSOR_HOST } from "../dist/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../src");
const CLI = path.resolve(HERE, "../dist/cli.js");
const CANONICAL = new Set(Object.keys(EVENT_WORKLOAD_CATEGORY));
const REGISTERED_KEYS = new Set([...EVENT_METADATA_FIELDS, ...Object.keys(METRIC_KEYS)]);
const CONTEXT_KEYS = new Set(["contextWindowPeakPct", "contextUsagePercent"]);

/** One input per branch the mapper can take. Extend when a branch is added. */
const FIXTURES = [
  ["sessionStart", { conversation_id: "c1", composer_mode: "agent" }],
  ["sessionEnd", { conversation_id: "c1" }],
  ["beforeSubmitPrompt", { prompt: "that is wrong, try again" }],
  ["preToolUse", { tool_name: "Shell", tool_input: { command: "npm test" } }],
  ["postToolUse", { tool_name: "Shell", tool_input: { command: "npm test" }, tool_output: '{"exitCode":0}', duration: 42000 }],
  ["postToolUse", { tool_name: "Shell", tool_input: { command: "npm test" }, tool_output: '{"exitCode":1}', duration: 9000 }],
  ["postToolUse", { tool_name: "web_search", tool_output: '{"error":"timeout"}' }],
  ["postToolUse", { tool_name: "Write", tool_output: '{"exitCode":0}', duration: 1200 }],
  ["postToolUse", { tool_name: "Edit", tool_output: "not json" }],
  ["postToolUse", { tool_name: "Grep", tool_output: '{"exitCode":0}' }],
  ["postToolUseFailure", { tool_name: "Shell", tool_input: { command: "npm run build" }, is_interrupt: false, duration: 3000 }],
  ["postToolUseFailure", { tool_name: "Shell", tool_input: { command: "npm run dev" }, is_interrupt: true }],
  ["postToolUseFailure", { tool_name: "Read", is_interrupt: false }],
  ["preCompact", { trigger: "auto", context_usage_percent: 85 }],
  ["preCompact", { trigger: "manual" }],
  ["stop", { status: "completed" }, 45 * 60000],
  ["stop", { status: "completed" }, 90 * 60000]
];

function emitted() {
  return FIXTURES.flatMap(([hook, input, turnMs]) => mapCursorEvent(hook, input, turnMs));
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
  assert.ok(events.length >= FIXTURES.length - 2, "the fixtures no longer reach the mapper's branches");
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
  for (const event of emitted()) {
    for (const [key, value] of Object.entries(event.metadata ?? {})) {
      if (!/context/i.test(key)) continue;
      assert.ok(CONTEXT_KEYS.has(key), `${key} is an improvised context spelling — use contextWindowPeakPct or contextUsagePercent`);
      if (key === "contextWindowPeakPct") assert.ok(value >= 0 && value <= 1.5, `${key}=${value} does not look like a fraction`);
    }
  }
  const [compaction] = mapCursorEvent("preCompact", { trigger: "auto", context_usage_percent: 85 });
  assert.equal(compaction.metadata.contextWindowPeakPct, 0.85, "Cursor's percent lands as the canonical fraction");
  const [silent] = mapCursorEvent("preCompact", { trigger: "auto" });
  assert.equal("contextWindowPeakPct" in silent.metadata, false, "no reading is an absent key, never 0");
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
  const [hook, input] = FIXTURES[4];
  const result = spawnSync("node", [CLI, hook], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      ASCENDA_HOME: home,
      ASCENDA_STATE_DIR: path.join(home, "state"),
      ASCENDA_EVENT_LOG_FILE: logFile,
      // Unpaired on purpose: the log records byte-for-byte what a send would
      // have put on the wire, which is what this test reads.
      ASCENDA_TOOL_INSTALLATION_ID: "",
      ASCENDA_EVENT_WRITE_TOKEN: ""
    }
  });
  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lines.length >= 1, "the CLI logged nothing");
  for (const { delivery, payload } of lines) {
    assert.equal(delivery, "not_sent");
    assert.equal(payload.metadata.host, CURSOR_HOST);
    assert.ok(Number.isInteger(payload.utcOffsetMinutes), `utcOffsetMinutes missing: ${JSON.stringify(payload)}`);
    assert.match(payload.idempotencyKey, /^[0-9a-f-]{36}$/, "the idempotency key is minted at construction, by the shared sender");
    assert.equal(payload.source, "cli_agent");
    for (const key of Object.keys(payload.metadata)) assert.ok(REGISTERED_KEYS.has(key), `${key} reached the wire unregistered`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});
