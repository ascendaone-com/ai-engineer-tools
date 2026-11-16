/**
 * Codex token accounting, the duplicate-root guard and the streaming read.
 *
 * `inputTokens` is the input billed at the full rate on every store, so the
 * Codex figure ships with its cached and cache-written parts taken out.
 * `token_usage_record` carries the same running total as `token_count` and
 * folds by the same max. A rollout under both roots is read once. A rollout
 * is read line by line, and one that fails partway leaves its session as it
 * was before the file was opened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { extractCodex, dropDuplicateRollouts } from "../dist/extractors/codex.js";

const MAIN = "019b0000-0000-7000-8000-00000000000a";
const SUB = "019b0000-0000-7000-8000-00000000000b";
const OTHER = "019b0000-0000-7000-8000-00000000000c";
const CWD = "/work/repo-a";

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function usage({ input, cached = 0, cacheWrite, output = 0 }) {
  const out = { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 };
  if (cacheWrite !== undefined) out.cache_write_input_tokens = cacheWrite;
  out.total_tokens = input + output;
  return out;
}

function tokenCount(timestamp, total) {
  return line(timestamp, "event_msg", {
    type: "token_count",
    info: { total_token_usage: usage(total), last_token_usage: usage(total), model_context_window: 258400 }
  });
}

function usageRecord(timestamp, threadId, total) {
  return line(timestamp, "token_usage_record", {
    thread_id: threadId,
    session_id: threadId,
    turn_id: "t1",
    response_id: "resp_redacted",
    usage: usage(total),
    turn_token_usage: usage(total),
    thread_token_usage: usage(total)
  });
}

function meta(timestamp, id, extra = {}) {
  return line(timestamp, "session_meta", { id, timestamp, cwd: CWD, cli_version: "0.150.0", ...extra });
}

function prompt(timestamp) {
  return line(timestamp, "event_msg", { type: "user_message", message: "redacted", images: [] });
}

function call(timestamp) {
  return line(timestamp, "response_item", { type: "function_call", name: "shell_command", arguments: "{}" });
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** files: { "sessions/2026/11/10/rollout-….jsonl": string | Buffer } */
async function storeWith(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-tokens-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  return root;
}

function rollout(ts, id) {
  return `rollout-2026-11-10T${ts}-${id}.jsonl`;
}

function body(lines) {
  return lines.join("\n") + "\n";
}

async function sessionsOf(root, options) {
  const events = await collect(extractCodex(root, "x1", options));
  return {
    events,
    sessions: events.filter((e) => e.eventKind === "create_focus_session"),
    epoch: events.find((e) => e.eventKind === "extraction_epoch")
  };
}

/* ------------------------------------------------------------------------ *
 * Step 1: input excluding cache reads
 * ------------------------------------------------------------------------ */

test("inputTokens leaves out cache reads, and a rollout without cache writes ships no cacheCreationTokens", async () => {
  const root = await storeWith({
    [`sessions/2026/11/10/${rollout("01-00-00", MAIN)}`]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      tokenCount("2026-11-10T01:00:05.000Z", { input: 4000, cached: 3000, output: 40 }),
      tokenCount("2026-11-10T01:00:09.000Z", { input: 10000, cached: 8000, output: 90 })
    ])
  });
  const [s] = (await sessionsOf(root)).sessions;
  assert.equal(s.metrics.inputTokens, 2000);
  assert.equal(s.metrics.cacheReadTokens, 8000);
  assert.equal(s.metrics.outputTokens, 90);
  assert.equal("cacheCreationTokens" in s.metrics, false, "no field in the store, no key: not a 0");
  assert.equal(s.metrics.contextWindowPeakTokens, 10000, "context occupancy still counts the cached part");
});

test("a subagent's input is summed on the same definition", async () => {
  const root = await storeWith({
    [`sessions/2026/11/10/${rollout("01-00-00", MAIN)}`]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      tokenCount("2026-11-10T01:00:09.000Z", { input: 10000, cached: 8000, output: 90 })
    ]),
    [`sessions/2026/11/10/${rollout("01-01-00", SUB)}`]: body([
      meta("2026-11-10T01:01:00.000Z", SUB, { thread_source: "subagent", parent_thread_id: MAIN }),
      prompt("2026-11-10T01:01:01.000Z"),
      tokenCount("2026-11-10T01:01:09.000Z", { input: 3000, cached: 2500, output: 30 })
    ])
  });
  const [s] = (await sessionsOf(root)).sessions;
  assert.equal(s.metrics.inputTokens, 2000 + 500);
  assert.equal(s.metrics.cacheReadTokens, 8000 + 2500);
  assert.equal(s.metrics.subagentTokensTotal, 3000 + 30, "everything the subagent consumed, cache included");
});

/* ------------------------------------------------------------------------ *
 * Step 2: cache writes
 * ------------------------------------------------------------------------ */

test("cache writes ship as cacheCreationTokens and come out of inputTokens", async () => {
  const root = await storeWith({
    [`sessions/2026/11/10/${rollout("01-00-00", MAIN)}`]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      tokenCount("2026-11-10T01:00:09.000Z", { input: 10000, cached: 8000, cacheWrite: 1200, output: 90 })
    ])
  });
  const [s] = (await sessionsOf(root)).sessions;
  assert.equal(s.metrics.cacheCreationTokens, 1200);
  assert.equal(s.metrics.inputTokens, 10000 - 8000 - 1200);
});

test("a reported zero cache write ships as 0", async () => {
  const root = await storeWith({
    [`sessions/2026/11/10/${rollout("01-00-00", MAIN)}`]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      tokenCount("2026-11-10T01:00:09.000Z", { input: 1000, cached: 500, cacheWrite: 0, output: 9 })
    ])
  });
  const [s] = (await sessionsOf(root)).sessions;
  assert.equal(s.metrics.cacheCreationTokens, 0);
});

/* ------------------------------------------------------------------------ *
 * Step 3: token_usage_record
 * ------------------------------------------------------------------------ */

function turnLines({ withCount, withRecord }) {
  const totals = [
    ["2026-11-10T01:00:05.000Z", { input: 30000, cached: 24000, cacheWrite: 1200, output: 300 }],
    ["2026-11-10T01:03:00.000Z", { input: 64000, cached: 56000, cacheWrite: 1800, output: 700 }]
  ];
  const lines = [meta("2026-11-10T01:00:00.000Z", MAIN), prompt("2026-11-10T01:00:01.000Z"), call("2026-11-10T01:00:02.000Z")];
  for (const [ts, total] of totals) {
    if (withCount) lines.push(tokenCount(ts, total));
    if (withRecord) lines.push(usageRecord(ts, MAIN, total));
  }
  return lines;
}

const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "tokensNotCollected"];
const tokenFigures = (m) => Object.fromEntries(TOKEN_KEYS.map((k) => [k, m[k]]));

test("a rollout with both line types ships what the token_count lines alone ship", async () => {
  const both = (await sessionsOf(await storeWith({
    [`sessions/2026/11/10/${rollout("01-00-00", MAIN)}`]: body(turnLines({ withCount: true, withRecord: true }))
  }))).sessions[0];
  const countOnly = (await sessionsOf(await storeWith({
    [`sessions/2026/11/10/${rollout("01-00-00", MAIN)}`]: body(turnLines({ withCount: true, withRecord: false }))
  }))).sessions[0];
  assert.deepEqual(tokenFigures(both.metrics), tokenFigures(countOnly.metrics));
  assert.equal(both.metrics.inputTokens, 64000 - 56000 - 1800);
  assert.equal(both.metrics.unknownLines, 0, "token_usage_record is a known line type");
  assert.equal(countOnly.metrics.unknownLines, 0);
});

test("a rollout with only token_usage_record lines still ships totals", async () => {
  const [s] = (await sessionsOf(await storeWith({
    [`sessions/2026/11/10/${rollout("01-00-00", MAIN)}`]: body(turnLines({ withCount: false, withRecord: true }))
  }))).sessions;
  assert.equal(s.metrics.tokensNotCollected, undefined);
  assert.equal(s.metrics.inputTokens, 64000 - 56000 - 1800);
  assert.equal(s.metrics.cacheReadTokens, 56000);
  assert.equal(s.metrics.cacheCreationTokens, 1800);
  assert.equal(s.metrics.outputTokens, 700);
  assert.equal(s.metrics.unknownLines, 0);
});

test("a token_usage_record lands on the thread its thread_id names", async () => {
  const root = await storeWith({
    [`sessions/2026/11/10/${rollout("01-00-00", MAIN)}`]: body([
      meta("2026-11-10T01:00:00.000Z", MAIN),
      prompt("2026-11-10T01:00:01.000Z"),
      usageRecord("2026-11-10T01:00:09.000Z", MAIN, { input: 10000, cached: 8000, cacheWrite: 0, output: 90 })
    ]),
    [`sessions/2026/11/10/${rollout("01-01-00", SUB)}`]: body([
      meta("2026-11-10T01:01:00.000Z", SUB, { thread_source: "subagent", parent_thread_id: MAIN }),
      prompt("2026-11-10T01:01:01.000Z"),
      usageRecord("2026-11-10T01:01:09.000Z", SUB, { input: 3000, cached: 2500, cacheWrite: 0, output: 30 }),
      // The main thread's running total, seen from the subagent's rollout:
      // folded onto the main thread by max, so it can't add to it.
      usageRecord("2026-11-10T01:01:10.000Z", MAIN, { input: 10000, cached: 8000, cacheWrite: 0, output: 90 }),
      // A thread this session never read: left out.
      usageRecord("2026-11-10T01:01:11.000Z", OTHER, { input: 999999, cached: 0, cacheWrite: 0, output: 9999 })
    ])
  });
  const [s] = (await sessionsOf(root)).sessions;
  assert.equal(s.metrics.subagentTokensTotal, 3000 + 30, "the subagent's record is the subagent's");
  assert.equal(s.metrics.inputTokens, 2000 + 500);
  assert.equal(s.metrics.outputTokens, 90 + 30);
  assert.equal(s.metrics.unknownLines, 0);
});

test("a fork's replayed token_usage_record is the parent's, not the fork's", async () => {
  const PARENT = MAIN;
  const FORK = OTHER;
  const forkAt = "2026-11-10T02:00:00.000Z";
  const root = await storeWith({
    [`sessions/2026/11/10/${rollout("02-00-00", FORK)}`]: body([
      meta(forkAt, FORK, { forked_from_id: PARENT }),
      meta("2026-11-10T01:00:00.000Z", PARENT),
      prompt("2026-11-10T01:00:01.000Z"),
      usageRecord("2026-11-10T01:00:09.000Z", PARENT, { input: 10000, cached: 8000, cacheWrite: 0, output: 90 }),
      prompt("2026-11-10T02:01:00.000Z"),
      usageRecord("2026-11-10T02:01:09.000Z", FORK, { input: 13000, cached: 10500, cacheWrite: 100, output: 140 })
    ])
  });
  const [fork] = (await sessionsOf(root)).sessions;
  assert.equal(fork.sessionRef, FORK);
  assert.equal(fork.metrics.promptCount, 1);
  assert.equal(fork.metrics.inputTokens, 3000 - 2500 - 100, "the fork's own spend past the replayed total");
  assert.equal(fork.metrics.outputTokens, 50);
});

/* ------------------------------------------------------------------------ *
 * Step 4: one rollout, one read
 * ------------------------------------------------------------------------ */

test("the same rollout under both roots is read once and counted", async () => {
  const name = rollout("01-00-00", MAIN);
  const lines = body([
    meta("2026-11-10T01:00:00.000Z", MAIN),
    prompt("2026-11-10T01:00:01.000Z"),
    call("2026-11-10T01:00:02.000Z"),
    tokenCount("2026-11-10T01:00:09.000Z", { input: 1000, cached: 600, output: 9 })
  ]);
  const single = (await sessionsOf(await storeWith({ [`sessions/2026/11/10/${name}`]: lines }))).sessions[0];
  const { sessions, epoch } = await sessionsOf(
    await storeWith({ [`sessions/2026/11/10/${name}`]: lines, [`archived_sessions/${name}`]: lines })
  );
  assert.equal(sessions.length, 1);
  for (const key of ["promptCount", "toolCallCount", "inputTokens", "cacheReadTokens", "outputTokens"]) {
    assert.equal(sessions[0].metrics[key], single.metrics[key], key);
  }
  assert.equal(epoch.metrics.duplicateRolloutFiles, 1);
});

test("the duplicate guard keeps the larger copy, then the sessions/ copy, and a plain one over a compressed one", () => {
  const kept = (found) => dropDuplicateRollouts(found).files;
  const s = (size, ext = ".jsonl") => ({ file: `/r/sessions/2026/11/10/rollout-x${ext}`, root: "sessions", size });
  const a = (size, ext = ".jsonl") => ({ file: `/r/archived_sessions/rollout-x${ext}`, root: "archived_sessions", size });
  assert.deepEqual(kept([a(500), s(300)]), [a(500).file], "a copy caught mid-move is the shorter one");
  assert.deepEqual(kept([a(300), s(500)]), [s(500).file]);
  assert.deepEqual(kept([a(300), s(300)]), [s(300).file], "on a tie, the sessions/ copy");
  assert.deepEqual(kept([a(900, ".jsonl.zst"), s(100)]), [s(100).file], "sizes across formats don't compare");
  assert.deepEqual(dropDuplicateRollouts([s(1)]), { files: [s(1).file], duplicates: 0 });
  assert.deepEqual(dropDuplicateRollouts([a(1), s(2)]).duplicates, 1);
});

test("a store with no duplicate reports duplicateRolloutFiles 0", async () => {
  const { epoch } = await sessionsOf(await storeWith({
    [`sessions/2026/11/10/${rollout("01-00-00", MAIN)}`]: body(turnLines({ withCount: true, withRecord: false }))
  }));
  assert.equal(epoch.metrics.duplicateRolloutFiles, 0);
});

/* ------------------------------------------------------------------------ *
 * Step 5: streaming read
 * ------------------------------------------------------------------------ */

/** Why the CLI-decode case can't run here, or false when it can. */
function zstdCliMissing() {
  try {
    execFileSync("zstd", ["--version"], { stdio: "ignore" });
    return false;
  } catch {
    return "the zstd CLI isn't installed on this machine";
  }
}

function zstdCompress(plain) {
  if (typeof zlib.zstdCompressSync === "function") return zlib.zstdCompressSync(plain);
  return execFileSync("zstd", ["-cq"], { input: plain });
}

// The CLI fails a truncated frame with a non-zero exit after writing what it
// could decode, which is the partway failure this needs. (Node's built-in
// decoder hands back the decodable prefix of a truncated frame without an
// error, so it can't stand in.)
test("a compressed continuation that fails partway leaves its session as the first page left it", { skip: zstdCliMissing() }, async () => {
  const first = rollout("01-00-00", MAIN);
  const firstLines = body([
    meta("2026-11-10T01:00:00.000Z", MAIN),
    prompt("2026-11-10T01:00:01.000Z"),
    tokenCount("2026-11-10T01:00:09.000Z", { input: 1000, cached: 600, output: 9 })
  ]);
  // A later page with enough lines that the decoder hands some over before
  // it reaches the cut.
  const pageLines = [meta("2026-11-10T03:00:00.000Z", MAIN, { history_mode: "paginated", history_base: "x" })];
  for (let i = 0; i < 20000; i++) {
    pageLines.push(prompt(`2026-11-10T03:${String(Math.floor(i / 400) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(i % 1000).padStart(3, "0")}Z`));
  }
  const compressed = zstdCompress(Buffer.from(body(pageLines)));
  const truncated = compressed.subarray(0, Math.floor(compressed.length * 0.6));
  const alone = (await sessionsOf(await storeWith({ [`sessions/2026/11/10/${first}`]: firstLines }))).sessions[0];
  const { sessions, epoch } = await sessionsOf(
    await storeWith({
      [`sessions/2026/11/10/${first}`]: firstLines,
      [`sessions/2026/11/10/rollout-2026-11-10T03-00-00-${MAIN}_2.jsonl.zst`]: truncated
    }),
    { zstdDecoder: "cli" }
  );
  assert.equal(epoch.metrics.unreadableRolloutFiles, 1);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].metrics.promptCount, alone.metrics.promptCount, "nothing half-counted");
  assert.equal(sessions[0].metrics.inputTokens, alone.metrics.inputTokens);
});

test("a rollout past V8's string limit is read, not counted unreadable", { skip: !process.env.ASCENDA_SLOW_TESTS && "set ASCENDA_SLOW_TESTS=1 to run" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-large-"));
  const dir = path.join(root, "sessions", "2026", "11", "10");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, rollout("01-00-00", MAIN));
  const handle = await fs.open(file, "w");
  const filler = line("2026-11-10T01:00:02.000Z", "response_item", {
    type: "reasoning",
    summary: [],
    encrypted_content: "x".repeat(4000)
  }) + "\n";
  const target = 600 * 1024 * 1024;
  const block = filler.repeat(Math.floor((1024 * 1024) / filler.length));
  try {
    await handle.write(body([meta("2026-11-10T01:00:00.000Z", MAIN), prompt("2026-11-10T01:00:01.000Z")]));
    for (let written = 0; written < target; written += block.length) await handle.write(block);
    await handle.write(body([tokenCount("2026-11-10T01:00:09.000Z", { input: 1000, cached: 600, output: 9 })]));
  } finally {
    await handle.close();
  }
  try {
    const { sessions, epoch } = await sessionsOf(root);
    assert.equal(epoch.metrics.unreadableRolloutFiles, 0);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].metrics.promptCount, 1);
    assert.equal(sessions[0].metrics.inputTokens, 400);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
