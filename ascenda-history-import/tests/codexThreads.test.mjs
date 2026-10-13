/**
 * Codex sessions are threads, not files. These fixtures pin the four ways a
 * rollout's file and its thread come apart:
 *
 *  - a fork replays its parent's history at the top of its own rollout, and
 *    that replay is the parent's work, not the fork's;
 *  - a subagent thread folds into the session that spawned it, and its task
 *    text is not a person typing;
 *  - a long thread continues in a second, paginated rollout under the same
 *    id, and is still one session;
 *  - with history compression on, rollouts are `.jsonl.zst`.
 *
 * Every line is synthetic: field shapes only, content redacted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import {
  extractCodex,
  rolloutIdentityOf,
  rolloutReadingOrder,
  sessionIdFromRolloutName,
  sessionKeyOf
} from "../dist/extractors/codex.js";
import { scanCodex } from "../dist/scan.js";
import { resolveStorePaths } from "../dist/stores.js";

const PARENT = "11111111-1111-4111-8111-111111111111";
const FORK = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";
const CWD = "/work/repo-a";

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function meta(timestamp, id, extra = {}) {
  return line(timestamp, "session_meta", {
    id,
    timestamp,
    cwd: CWD,
    originator: "codex_cli_rs",
    cli_version: "0.150.0",
    source: "cli",
    git: { branch: "feature/redacted" },
    ...extra
  });
}

function prompt(timestamp) {
  return line(timestamp, "event_msg", { type: "user_message", message: "redacted", images: [] });
}

function tokens(timestamp, input, output, cached, lastInput = input) {
  return line(timestamp, "event_msg", {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
      last_token_usage: { input_tokens: lastInput, cached_input_tokens: 0, output_tokens: 0 },
      model_context_window: 258400
    }
  });
}

function turn(timestamp, model = "gpt-5.5") {
  return line(timestamp, "turn_context", { cwd: CWD, model, approval_policy: "on-request" });
}

function call(timestamp, name) {
  return line(timestamp, "response_item", { type: "function_call", name, arguments: "{}", call_id: "c" });
}

function reply(timestamp) {
  return line(timestamp, "response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "redacted" }]
  });
}

/** The parent thread: two prompts, 1000 input tokens all told. */
const parentLines = [
  meta("2026-08-03T09:00:00.000Z", PARENT),
  prompt("2026-08-03T09:00:01.000Z"),
  turn("2026-08-03T09:00:01.000Z"),
  tokens("2026-08-03T09:00:05.000Z", 400, 40, 100),
  prompt("2026-08-03T09:02:00.000Z"),
  turn("2026-08-03T09:02:00.000Z"),
  tokens("2026-08-03T09:02:05.000Z", 1000, 100, 500)
];

/** The parent's lines as a fork replays them: in one burst, stamped with
 * the fork's own write time. */
function replayAt(base) {
  const ms = Date.parse(base);
  return parentLines.map((l, i) => {
    const parsed = JSON.parse(l);
    parsed.timestamp = new Date(ms + 5 + i).toISOString();
    return JSON.stringify(parsed);
  });
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function snapshotWith(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-threads-"));
  const dir = path.join(root, "sessions", "2026", "08", "03");
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }
  return { root, dir };
}

function sessions(events) {
  return events.filter((e) => e.eventKind === "create_focus_session");
}

/* ------------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------------ */

test("a continuation's filename names its thread, without the rollout suffix", () => {
  assert.equal(sessionIdFromRolloutName(`rollout-2026-08-03T09-00-00-${PARENT}_0002.jsonl`), PARENT);
  assert.equal(sessionIdFromRolloutName(`rollout-2026-08-03T09-00-00-${PARENT}.jsonl.zst`), PARENT);
  assert.equal(sessionIdFromRolloutName(`rollout-2026-08-03T09-00-00-${PARENT}.jsonl`), PARENT);
});

test("identity reads forks, both subagent markers and paginated continuations off session_meta", () => {
  const fork = rolloutIdentityOf({ id: FORK, forked_from_id: PARENT }, "x.jsonl");
  assert.equal(fork.forkedFromId, PARENT);
  assert.equal(sessionKeyOf(fork), FORK, "a fork is a session of its own");

  const tagged = rolloutIdentityOf({ id: CHILD, thread_source: "subagent", parent_thread_id: PARENT }, "x.jsonl");
  assert.equal(tagged.isSubagent, true);
  assert.equal(sessionKeyOf(tagged), PARENT);

  const legacy = rolloutIdentityOf(
    { id: CHILD, source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } } },
    "x.jsonl"
  );
  assert.equal(legacy.isSubagent, true);
  assert.equal(sessionKeyOf(legacy), PARENT);

  const review = rolloutIdentityOf({ id: CHILD, source: { subagent: "review" } }, "x.jsonl");
  assert.equal(review.isSubagent, true);
  assert.equal(sessionKeyOf(review), CHILD, "no parent named: folds under its own id");

  const page = rolloutIdentityOf({ id: PARENT, history_mode: "paginated", history_base: "prev" }, "x.jsonl");
  assert.equal(page.isContinuation, true);
  assert.equal(rolloutIdentityOf({ id: PARENT, history_mode: "paginated" }, "x.jsonl").isContinuation, false);
});

/* ------------------------------------------------------------------------ *
 * Forks
 * ------------------------------------------------------------------------ */

test("a fork keeps its own id and counts only its own prompts and tokens", async () => {
  const forkAt = "2026-08-03T10:00:00.000Z";
  const forkLines = [
    meta(forkAt, FORK, { forked_from_id: PARENT }),
    ...replayAt(forkAt),
    prompt("2026-08-03T10:01:00.000Z"),
    turn("2026-08-03T10:01:00.000Z"),
    call("2026-08-03T10:01:10.000Z", "shell_command"),
    tokens("2026-08-03T10:01:30.000Z", 1300, 150, 600, 1300)
  ];
  const { root } = await snapshotWith({
    [`rollout-2026-08-03T09-00-00-${PARENT}.jsonl`]: parentLines.join("\n") + "\n",
    [`rollout-2026-08-03T10-00-00-${FORK}.jsonl`]: forkLines.join("\n") + "\n"
  });
  const events = await collect(extractCodex(root, "x1"));
  const byRef = new Map(sessions(events).map((s) => [s.sessionRef, s]));
  assert.equal(byRef.size, 2);

  const parent = byRef.get(PARENT);
  assert.equal(parent.metrics.promptCount, 2);
  assert.equal(parent.metrics.inputTokens, 1000);

  const fork = byRef.get(FORK);
  assert.ok(fork, "the fork is filed under its own id, not the replayed parent's");
  assert.equal(fork.metrics.promptCount, 1, "the replayed prompts are the parent's");
  assert.equal(fork.metrics.inputTokens, 300);
  assert.equal(fork.metrics.outputTokens, 50);
  assert.equal(fork.metrics.cacheReadTokens, 100);
  assert.equal(fork.metrics.toolCallCount, 1);
  assert.equal(fork.metrics.sessionStartedAt, forkAt);
  assert.equal(fork.metrics.metaLines, parentLines.length, "the replay is recognised and skipped");

  const prompts = events.filter((e) => e.eventKind === "ai_prompt_submitted");
  assert.equal(prompts.filter((e) => e.sessionRef === PARENT).length, 2);
  assert.equal(prompts.filter((e) => e.sessionRef === FORK).length, 1);
});

test("a fork whose counter restarted at zero isn't charged the parent's total", async () => {
  const forkAt = "2026-08-03T10:00:00.000Z";
  const forkLines = [
    meta(forkAt, FORK, { forked_from_id: PARENT }),
    ...replayAt(forkAt),
    prompt("2026-08-03T10:01:00.000Z"),
    tokens("2026-08-03T10:01:30.000Z", 200, 20, 0)
  ];
  const { root } = await snapshotWith({
    [`rollout-2026-08-03T10-00-00-${FORK}.jsonl`]: forkLines.join("\n") + "\n"
  });
  const [fork] = sessions(await collect(extractCodex(root, "x1")));
  assert.equal(fork.sessionRef, FORK);
  assert.equal(fork.metrics.inputTokens, 200);
  assert.equal(fork.metrics.outputTokens, 20);
});

test("a replay that keeps the parent's older timestamps doesn't stretch the fork back", async () => {
  const forkAt = "2026-08-03T10:00:00.000Z";
  const forkLines = [
    meta(forkAt, FORK, { forked_from_id: PARENT }),
    ...parentLines,
    prompt("2026-08-03T10:01:00.000Z"),
    tokens("2026-08-03T10:01:30.000Z", 1100, 110, 500)
  ];
  const { root } = await snapshotWith({
    [`rollout-2026-08-03T10-00-00-${FORK}.jsonl`]: forkLines.join("\n") + "\n"
  });
  const [fork] = sessions(await collect(extractCodex(root, "x1")));
  assert.equal(fork.metrics.sessionStartedAt, forkAt);
  assert.equal(fork.metrics.promptCount, 1);
  assert.equal(fork.metrics.inputTokens, 100);
});

/* ------------------------------------------------------------------------ *
 * Subagents
 * ------------------------------------------------------------------------ */

function childLines(sourceFields) {
  return [
    meta("2026-08-03T09:00:30.000Z", CHILD, sourceFields),
    prompt("2026-08-03T09:00:31.000Z"), // the parent agent's task text
    turn("2026-08-03T09:00:31.000Z", "gpt-5.5-mini"),
    call("2026-08-03T09:00:35.000Z", "shell_command"),
    reply("2026-08-03T09:00:40.000Z"),
    tokens("2026-08-03T09:00:41.000Z", 400, 40, 0, 400)
  ];
}

test("a subagent thread folds into its parent, and its task text isn't a prompt", async () => {
  const { root } = await snapshotWith({
    [`rollout-2026-08-03T09-00-00-${PARENT}.jsonl`]: parentLines.join("\n") + "\n",
    [`rollout-2026-08-03T09-00-30-${CHILD}.jsonl`]:
      childLines({
        source: "subagent",
        thread_source: "subagent",
        parent_thread_id: PARENT
      }).join("\n") + "\n"
  });
  const events = await collect(extractCodex(root, "x1"));
  const all = sessions(events);
  assert.equal(all.length, 1, "a subagent isn't a session of its own");
  const [s] = all;
  assert.equal(s.sessionRef, PARENT);
  assert.equal(s.metrics.promptCount, 2);
  assert.equal(events.filter((e) => e.eventKind === "ai_prompt_submitted").length, 2);
  assert.equal(s.metrics.subagentTranscripts, 1);
  assert.equal(s.metrics.subagentPrompts, 1);
  assert.equal(s.metrics.subagentAssistantTurns, 1);
  assert.equal(s.metrics.subagentToolCallCount, 1);
  assert.equal(s.metrics.subagentTokensTotal, 440);
  assert.equal(s.metrics.inputTokens, 1400, "the subagent's spend is the session's spend");
  assert.equal(s.metrics.toolCallCount, 1);
  assert.equal(s.metrics.contextWindowPeakTokens, 1000, "context pressure is the thread's own");
  assert.equal(s.metrics.modelSwitchCount, 0, "a subagent's model isn't a switch on the parent");
  const calls = events.filter((e) => e.eventKind === "ai_tool_call_started");
  assert.deepEqual(calls.map((e) => e.sessionRef), [PARENT]);
});

test("the older source.subagent marker folds the same way, even when the child sorts first", async () => {
  const { root } = await snapshotWith({
    // An earlier timestamp in the name puts the child first.
    [`rollout-2026-08-03T08-59-00-${CHILD}.jsonl`]:
      childLines({
        cwd: "/work/elsewhere",
        source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } }
      }).join("\n") + "\n",
    [`rollout-2026-08-03T09-00-00-${PARENT}.jsonl`]: parentLines.join("\n") + "\n"
  });
  const all = sessions(await collect(extractCodex(root, "x1")));
  assert.equal(all.length, 1);
  assert.equal(all[0].sessionRef, PARENT);
  assert.equal(all[0].repoRef, CWD, "the parent's own session_meta names the repo");
  assert.equal(all[0].metrics.promptCount, 2);
  assert.equal(all[0].metrics.subagentPrompts, 1);
});

test("a session with no subagent carries no subagent breakdown", async () => {
  const { root } = await snapshotWith({
    [`rollout-2026-08-03T09-00-00-${PARENT}.jsonl`]: parentLines.join("\n") + "\n"
  });
  const [s] = sessions(await collect(extractCodex(root, "x1")));
  assert.equal("subagentTranscripts" in s.metrics, false);
  assert.equal("subagentPrompts" in s.metrics, false);
});

/* ------------------------------------------------------------------------ *
 * Paginated continuations
 * ------------------------------------------------------------------------ */

test("a paginated continuation folds into one session with its first page", async () => {
  const page2 = [
    meta("2026-08-03T11:00:00.000Z", PARENT, { history_mode: "paginated", history_base: "page-1" }),
    prompt("2026-08-03T11:00:05.000Z"),
    turn("2026-08-03T11:00:05.000Z", "gpt-5.5-max"),
    tokens("2026-08-03T11:00:10.000Z", 1600, 160, 700)
  ];
  const { root } = await snapshotWith({
    [`rollout-2026-08-03T09-00-00-${PARENT}.jsonl`]: parentLines.join("\n") + "\n",
    [`rollout-2026-08-03T11-00-00-${PARENT}_0002.jsonl`]: page2.join("\n") + "\n"
  });
  const events = await collect(extractCodex(root, "x1"));
  const all = sessions(events);
  assert.equal(all.length, 1, "one thread, one session");
  const [s] = all;
  assert.equal(s.sessionRef, PARENT);
  assert.equal(s.metrics.promptCount, 3);
  assert.equal(s.metrics.inputTokens, 1600, "the cumulative counter carries across pages");
  assert.equal(s.metrics.sessionStartedAt, "2026-08-03T09:00:00.000Z");
  assert.equal(s.occurredAt, "2026-08-03T11:00:10.000Z");
  assert.equal(s.metrics.modelSwitchCount, 1, "the switch is seen across the page boundary");
  const epoch = events.find((e) => e.eventKind === "extraction_epoch");
  assert.equal(epoch.metrics.sessionCount, 1);
});

test("a continuation of a fork isn't mistaken for a replay", async () => {
  const page2 = [
    meta("2026-08-03T11:00:00.000Z", FORK, {
      forked_from_id: PARENT,
      history_mode: "paginated",
      history_base: "page-1"
    }),
    prompt("2026-08-03T11:00:00.200Z"),
    tokens("2026-08-03T11:00:10.000Z", 50, 5, 0)
  ];
  const { root } = await snapshotWith({
    [`rollout-2026-08-03T11-00-00-${FORK}_0002.jsonl`]: page2.join("\n") + "\n"
  });
  const [s] = sessions(await collect(extractCodex(root, "x1")));
  assert.equal(s.metrics.promptCount, 1);
  assert.equal(s.metrics.inputTokens, 50);
});

/* ------------------------------------------------------------------------ *
 * Compressed rollouts
 * ------------------------------------------------------------------------ */

test("reading order drops a .zst beside its plain twin and keeps pages in order", () => {
  const order = rolloutReadingOrder([
    "/s/b/rollout-2026-08-03T11-00-00-a_0002.jsonl",
    "/s/a/rollout-2026-08-03T09-00-00-a.jsonl.zst",
    "/s/a/rollout-2026-08-03T09-00-00-a.jsonl",
    "/s/a/rollout-2026-08-03T10-00-00-b.jsonl.zst"
  ]);
  assert.deepEqual(order, [
    "/s/a/rollout-2026-08-03T09-00-00-a.jsonl",
    "/s/a/rollout-2026-08-03T10-00-00-b.jsonl.zst",
    "/s/b/rollout-2026-08-03T11-00-00-a_0002.jsonl"
  ]);
});

test("a .jsonl.zst rollout is read like a plain one", { skip: typeof zlib.zstdCompressSync !== "function" }, async () => {
  const compressed = zlib.zstdCompressSync(Buffer.from(parentLines.join("\n") + "\n"));
  const { root } = await snapshotWith({
    [`rollout-2026-08-03T09-00-00-${PARENT}.jsonl.zst`]: compressed
  });
  const events = await collect(extractCodex(root, "x1"));
  const [s] = sessions(events);
  assert.equal(s.sessionRef, PARENT);
  assert.equal(s.metrics.promptCount, 2);
  assert.equal(s.metrics.inputTokens, 1000);
  assert.equal(events.find((e) => e.eventKind === "extraction_epoch").metrics.unreadableRolloutFiles, 0);
});

test("a .jsonl.zst that can't be decoded is counted unreadable, not dropped in silence", async () => {
  const { root } = await snapshotWith({
    [`rollout-2026-08-03T09-00-00-${PARENT}.jsonl.zst`]: "this is not zstd\n",
    [`rollout-2026-08-03T10-00-00-${FORK}.jsonl`]: [meta("2026-08-03T10:00:00.000Z", FORK)].join("\n") + "\n"
  });
  const events = await collect(extractCodex(root, "x1"));
  assert.equal(sessions(events).length, 1);
  assert.equal(events.find((e) => e.eventKind === "extraction_epoch").metrics.unreadableRolloutFiles, 1);
});

test("scan counts compressed rollouts beside plain ones", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  const paths = resolveStorePaths(home, {});
  const dir = path.join(paths.codexSessions, "2026", "08", "03");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "rollout-a.jsonl"), "x\n");
  await fs.writeFile(path.join(dir, "rollout-b.jsonl.zst"), "y\n");
  const inv = await scanCodex(paths);
  assert.equal(inv.counts.rollouts, 2);
});
