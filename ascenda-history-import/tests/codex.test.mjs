/**
 * Codex rollout extractor — the fixture set for the (codex, 0.1xx) shape.
 *
 * Lines here copy the field shapes of real rollouts with the content
 * replaced. The load-bearing assertion is the prompt classifier: a prompt is
 * the `user_message` event, and the `response_item` user-role copy that
 * follows it (which shares its role with injected environment context) must
 * not be counted a second time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isOutsideBusinessHours } from "@ascenda-one/tool-kit";
import {
  extractCodex,
  isHumanUserMessage,
  isToolOutputFailure,
  sessionIdFromRolloutName,
  sniffCodexLine,
  KNOWN_CODEX_LINE_TYPES
} from "../dist/extractors/codex.js";
import { HISTORY_STORES, STORE_SOURCE, STORE_HOST } from "../dist/types.js";
import { toWirePayload } from "../dist/ship.js";
import { buildCodexHandoff, HANDOFF_SCHEMA } from "../dist/localHandoff.js";
import { scanCodex } from "../dist/scan.js";
import { resolveStorePaths } from "../dist/stores.js";

const META_ID = "019bd8bb-16b9-7431-a616-88eee7b38dfe";
const FILE_ID = "00000000-0000-0000-0000-000000000000";
const CWD = "/Users/example/Dev/repo-a";
const V = "0.144.0-alpha.4";

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function tokenCount(timestamp, total, last, window) {
  return line(timestamp, "event_msg", {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: total.input,
        cached_input_tokens: total.cached,
        output_tokens: total.output,
        reasoning_output_tokens: 0,
        total_tokens: total.input + total.output
      },
      last_token_usage: {
        input_tokens: last.input,
        cached_input_tokens: last.cached,
        output_tokens: last.output,
        reasoning_output_tokens: 0,
        total_tokens: last.input + last.output
      },
      model_context_window: window
    },
    rate_limits: { primary: null, secondary: null, credits: null, plan_type: null }
  });
}

const T = {
  meta: "2026-07-20T10:00:00.000Z",
  p1: "2026-07-20T10:00:01.000Z",
  p2: "2026-07-20T10:00:40.000Z", // 39 s after p1: a rapid reprompt
  p3: "2026-07-20T23:30:00.000Z",
  end: "2026-07-20T23:31:00.000Z"
};

const fixtureLines = [
  line(T.meta, "session_meta", {
    id: META_ID,
    session_id: META_ID,
    timestamp: T.meta,
    cwd: CWD,
    originator: "codex_vscode",
    cli_version: V,
    source: "vscode",
    model_provider: "openai",
    git: { commit_hash: "0000000", branch: "feature/redacted", repository_url: "redacted" }
  }),
  line(T.meta, "response_item", {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "redacted instructions" }]
  }),
  // Turn 1: injected environment context on a user-role message, then the
  // prompt itself as an event and as a message. One prompt.
  line(T.p1, "response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "<environment_context>redacted</environment_context>" }]
  }),
  line(T.p1, "event_msg", { type: "user_message", message: "redacted", images: [] }),
  line(T.p1, "response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "redacted" }]
  }),
  line(T.p1, "turn_context", {
    turn_id: "t1",
    cwd: CWD,
    approval_policy: "on-request",
    sandbox_policy: { type: "workspace-write", writable_roots: [CWD] },
    model: "gpt-5.2-codex",
    effort: "medium"
  }),
  line("2026-07-20T10:00:02.000Z", "event_msg", {
    type: "task_started",
    turn_id: "t1",
    model_context_window: 258400
  }),
  line("2026-07-20T10:00:03.000Z", "world_state", { full: true, state: {} }),
  line("2026-07-20T10:00:04.000Z", "response_item", {
    type: "reasoning",
    summary: [],
    content: null,
    encrypted_content: "redacted"
  }),
  line("2026-07-20T10:00:05.000Z", "response_item", {
    type: "function_call",
    name: "shell_command",
    arguments: "{\"command\":\"redacted\"}",
    call_id: "call_1"
  }),
  line("2026-07-20T10:00:06.000Z", "response_item", {
    type: "function_call_output",
    call_id: "call_1",
    output: "Exit code: 0\nWall time: 0.3 seconds\nOutput:\nredacted"
  }),
  tokenCount("2026-07-20T10:00:07.000Z", { input: 1000, cached: 0, output: 50 }, { input: 1000, cached: 0, output: 50 }, 258400),
  line("2026-07-20T10:00:08.000Z", "response_item", {
    type: "function_call",
    name: "apply_patch",
    arguments: "{\"input\":\"redacted\"}",
    call_id: "call_2"
  }),
  line("2026-07-20T10:00:09.000Z", "response_item", {
    type: "function_call_output",
    call_id: "call_2",
    output: "Exit code: 1\nWall time: 0.1 seconds\nOutput:\nredacted"
  }),
  line("2026-07-20T10:00:10.000Z", "response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "redacted" }]
  }),
  line("2026-07-20T10:00:10.000Z", "event_msg", { type: "agent_message", message: "redacted" }),
  tokenCount("2026-07-20T10:00:11.000Z", { input: 2500, cached: 900, output: 120 }, { input: 1500, cached: 900, output: 70 }, 258400),
  line("2026-07-20T10:00:12.000Z", "event_msg", {
    type: "task_complete",
    turn_id: "t1",
    last_agent_message: null,
    duration_ms: 11_000
  }),
  // Turn 2: rapid reprompt, model switch, a built-in call kind with no name,
  // an output that carries `success: false`, and a runtime error.
  line(T.p2, "event_msg", { type: "user_message", message: "redacted", images: [], kind: "plain" }),
  line(T.p2, "turn_context", {
    turn_id: "t2",
    cwd: CWD,
    approval_policy: "on-request",
    sandbox_policy: { type: "workspace-write", writable_roots: [CWD] },
    model: "gpt-5.5",
    effort: "low"
  }),
  line("2026-07-20T10:00:41.000Z", "response_item", {
    type: "local_shell_call",
    call_id: "call_3",
    status: "completed",
    action: { type: "exec", command: ["redacted"] }
  }),
  line("2026-07-20T10:00:42.000Z", "response_item", {
    type: "function_call_output",
    call_id: "call_3",
    output: { content: "redacted", success: false }
  }),
  line("2026-07-20T10:00:43.000Z", "event_msg", { type: "error", message: "redacted" }),
  line("2026-07-20T10:00:44.000Z", "compacted", { message: "redacted summary" }),
  line("2026-07-20T10:00:44.000Z", "event_msg", { type: "context_compacted" }),
  line("2026-07-20T10:00:45.000Z", "response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "redacted" }]
  }),
  line("2026-07-20T10:31:00.000Z", "event_msg", {
    type: "task_complete",
    turn_id: "t2",
    last_agent_message: null,
    duration_ms: 31 * 60_000
  }),
  // Turn 3: a late prompt, an injected-kind user_message that is not a
  // person typing, plus one unknown subtype and one garbage line.
  line(T.p3, "event_msg", { type: "user_message", message: "redacted", images: [], kind: "environment_context" }),
  line(T.p3, "event_msg", { type: "user_message", message: "redacted", images: [] }),
  line(T.p3, "turn_context", {
    turn_id: "t3",
    cwd: CWD,
    approval_policy: "on-request",
    sandbox_policy: { type: "workspace-write", writable_roots: [CWD] },
    model: "gpt-5.5",
    effort: "low"
  }),
  line("2026-07-20T23:30:30.000Z", "response_item", { type: "hologram", payload: {} }),
  "not json at all",
  line(T.end, "event_msg", { type: "task_complete", turn_id: "t3", last_agent_message: null, duration_ms: 60_000 })
];

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function makeSnapshot({ archived = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-snap-"));
  const dir = path.join(root, archived ? "archived_sessions" : "sessions", "2026", "07", "20");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-20T20-00-00-${FILE_ID}.jsonl`);
  await fs.writeFile(file, fixtureLines.join("\n") + "\n");
  return { root, file };
}

/* ------------------------------------------------------------------------ *
 * Sniffing
 * ------------------------------------------------------------------------ */

test("sniffs a session_meta line with its anchor fields", () => {
  const sniffed = sniffCodexLine(fixtureLines[0]);
  assert.equal(sniffed.kind, "session_meta");
  assert.equal(sniffed.occurredAt, T.meta);
  assert.equal(sniffed.payload.cli_version, V);
  assert.equal(sniffed.subtype, null);
});

test("sniffs the payload subtype off response_item and event_msg lines", () => {
  const prompt = sniffCodexLine(line(T.p1, "event_msg", { type: "user_message", message: "x" }));
  assert.equal(prompt.kind, "event_msg");
  assert.equal(prompt.subtype, "user_message");
  const call = sniffCodexLine(line(T.p1, "response_item", { type: "function_call", name: "x" }));
  assert.equal(call.kind, "response_item");
  assert.equal(call.subtype, "function_call");
});

test("the extractor's known-type list matches the documented one", () => {
  assert.deepEqual(
    [...KNOWN_CODEX_LINE_TYPES].sort(),
    ["compacted", "event_msg", "response_item", "session_meta", "turn_context"]
  );
});

test("an unknown top-level type or payload subtype sniffs as unknown, named", () => {
  assert.deepEqual(sniffCodexLine(line(T.p1, "hologram", {})), { kind: "unknown", type: "hologram" });
  assert.deepEqual(sniffCodexLine(line(T.p1, "event_msg", { type: "hologram" })), {
    kind: "unknown",
    type: "event_msg:hologram"
  });
  assert.deepEqual(sniffCodexLine(line(T.p1, "response_item", {})), {
    kind: "unknown",
    type: "response_item:?"
  });
});

test("world_state is recognised as meta; garbage is unparsed", () => {
  assert.equal(sniffCodexLine(line(T.p1, "world_state", {})).kind, "meta");
  assert.equal(sniffCodexLine("nope").kind, "unparsed");
  assert.equal(sniffCodexLine(JSON.stringify({ payload: {} })).kind, "unparsed");
});

test("a user_message is human unless its kind says otherwise", () => {
  assert.equal(isHumanUserMessage({ message: "x" }), true);
  assert.equal(isHumanUserMessage({ message: "x", kind: "plain" }), true);
  assert.equal(isHumanUserMessage({ message: "x", kind: "environment_context" }), false);
  assert.equal(isHumanUserMessage({ message: "x", kind: "user_instructions" }), false);
});

test("a tool output fails on success:false or a non-zero exit-code prefix, and on nothing else", () => {
  assert.equal(isToolOutputFailure({ output: "Exit code: 0\nOutput:\nfine" }), false);
  assert.equal(isToolOutputFailure({ output: "Exit code: 2\nOutput:\nbad" }), true);
  assert.equal(isToolOutputFailure({ output: "Error: something" }), false, "free text is not sniffed");
  assert.equal(isToolOutputFailure({ output: "x", success: false }), true);
  assert.equal(isToolOutputFailure({ output: { content: "x", success: false } }), true);
  assert.equal(isToolOutputFailure({ output: { content: "x", success: true } }), false);
});

test("the session id comes off the rollout filename, with the store's own id preferred", async () => {
  assert.equal(sessionIdFromRolloutName(`rollout-2026-07-20T20-00-00-${FILE_ID}.jsonl`), FILE_ID);
  assert.equal(sessionIdFromRolloutName("odd-name.jsonl"), "odd-name");
  const { root } = await makeSnapshot();
  const events = await collect(extractCodex(root, "x1"));
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.equal(session.sessionRef, META_ID, "session_meta.id wins over the filename");
});

/* ------------------------------------------------------------------------ *
 * The fold
 * ------------------------------------------------------------------------ */

test("the fixture folds into the documented session shape", async () => {
  const { root } = await makeSnapshot();
  const events = await collect(extractCodex(root, "x1"));

  const prompts = events.filter((e) => e.eventKind === "ai_prompt_submitted");
  assert.equal(prompts.length, 3, "three user_message events; user-role messages and injected kinds are not prompts");
  assert.deepEqual(
    prompts.map((p) => p.occurredAt),
    [T.p1, T.p2, T.p3]
  );
  assert.ok(prompts.every((p) => p.provenance === "historical_direct"));
  assert.ok(prompts.every((p) => p.store === "codex"));
  assert.ok(prompts.every((p) => p.sourceVersion === V));
  assert.ok(prompts.every((p) => p.repoRef === CWD));

  const calls = events.filter((e) => e.eventKind === "ai_tool_call_started");
  assert.deepEqual(
    calls.map((c) => c.metrics.toolName),
    ["shell_command", "apply_patch", "local_shell_call"],
    "named calls by name; built-in call kinds by their item type"
  );

  const longTurns = events.filter((e) => e.eventKind === "agent_loop_long");
  assert.equal(longTurns.length, 1, "one turn reached the live hooks' long bucket");
  assert.equal(longTurns[0].metrics.durationBucket, "30-60m");
  assert.equal(longTurns[0].occurredAt, "2026-07-20T10:31:00.000Z");

  const session = events.find((e) => e.eventKind === "create_focus_session");
  const m = session.metrics;
  assert.equal(session.occurredAt, T.end);
  assert.equal(session.provenance, "historical_derived");
  assert.equal(m.promptCount, 3);
  assert.equal(m.assistantTurns, 2);
  assert.equal(m.toolCallCount, 3);
  assert.equal(m.toolResultCount, 3);
  assert.equal(m.toolResultErrorCount, 2, "one non-zero exit code, one success:false");
  assert.equal(m.apiErrorCount, 1);
  assert.equal(m.toolFailureCount, 3);
  assert.equal(m.inputTokens, 2500, "the largest cumulative figure, not a sum of cumulative figures");
  assert.equal(m.outputTokens, 120);
  assert.equal(m.cacheReadTokens, 900);
  assert.equal(m.contextWindowPeakTokens, 1500, "the largest last-request input");
  assert.equal(m.contextWindowTokens, 258400);
  assert.equal(m.contextWindowPeakPct, Math.round((1500 / 258400) * 1000) / 1000);
  assert.equal(m.modelCount, 2);
  assert.equal(m.modelSwitchCount, 1);
  assert.equal(m.primaryModel, "gpt-5.5");
  assert.equal(m.compactionCount, 1, "the compacted item is counted; its context_compacted event is not counted again");
  assert.equal(m.rapidRepromptCount, 1);
  assert.equal(m.unknownLines, 1);
  assert.equal(m.metaLines, 1);
  assert.equal(m.unparsedLines, 1);
  assert.equal(m.gitBranch, "feature/redacted");
  assert.equal(m.sessionStartedAt, T.meta);
  assert.equal(m.sessionMinutes, Math.round((Date.parse(T.end) - Date.parse(T.meta)) / 60_000));
  assert.equal(m.durationBucket, "60m+");

  const expectedAfterHours = [T.p1, T.p2, T.p3].filter((t) => isOutsideBusinessHours(new Date(t))).length;
  assert.equal(m.afterHoursPrompts, expectedAfterHours);
  const afterHours = events.filter((e) => e.eventKind === "after_hours_ai_session");
  assert.equal(afterHours.length, expectedAfterHours > 0 ? 1 : 0);

  const failure = events.find((e) => e.eventKind === "tool_failure");
  assert.deepEqual(failure.metrics, { toolFailureCount: 3, toolResultErrorCount: 2, apiErrorCount: 1 });

  assert.equal(
    events.filter((e) => e.eventKind.startsWith("context_compression")).length,
    0,
    "no manual/auto compression event: the rollout does not say which"
  );

  const epoch = events.find((e) => e.eventKind === "extraction_epoch");
  assert.equal(epoch.metrics.windowOldest, T.meta);
  assert.equal(epoch.metrics.windowNewest, T.end);
  assert.equal(epoch.metrics.sessionCount, 1);
  assert.equal(epoch.metrics.unreadableRolloutFiles, 0);
});

test("active time is split, and every supervising minute is in the unknown band", async () => {
  const { root } = await makeSnapshot();
  const events = await collect(extractCodex(root, "x1"));
  const session = events.find((e) => e.eventKind === "create_focus_session");
  const m = session.metrics;
  assert.equal(m.handsOnMinutes + m.agentSupervisingMinutes >= 0, true);
  assert.equal(
    m.activeSplitUnposturedInstants,
    m.activeSplitInstants,
    "the rollout records no permission_mode, so no instant carries a posture"
  );
  const bands = Object.keys(session.autonomySplit);
  assert.ok(
    bands.every((b) => b === "unknown"),
    `only the unknown band may appear on this store, got ${bands.join(",")}`
  );
  assert.ok(session.dayBreakdown.length >= 1);
  assert.equal(
    session.dayBreakdown.reduce((n, d) => n + d.prompts, 0),
    3,
    "the day slices account for every prompt"
  );
});

test("a rollout whose build wrote only context_compacted events still counts compactions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-snap-"));
  const dir = path.join(root, "sessions", "2026", "07", "21");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `rollout-2026-07-21T00-00-00-${FILE_ID}.jsonl`),
    [
      line("2026-07-21T00:00:00.000Z", "session_meta", { id: FILE_ID, cwd: CWD, cli_version: V }),
      line("2026-07-21T00:00:01.000Z", "event_msg", { type: "user_message", message: "x" }),
      line("2026-07-21T00:00:02.000Z", "event_msg", { type: "context_compacted" }),
      line("2026-07-21T00:00:03.000Z", "event_msg", { type: "context_compacted" })
    ].join("\n") + "\n"
  );
  const events = await collect(extractCodex(root, "x1"));
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.equal(session.metrics.compactionCount, 2);
});

test("no recorded window means no ratio, not a ratio against a guess", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-snap-"));
  const dir = path.join(root, "sessions", "2026", "07", "21");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `rollout-2026-07-21T00-00-00-${FILE_ID}.jsonl`),
    [
      line("2026-07-21T00:00:00.000Z", "session_meta", { id: FILE_ID, cwd: CWD, cli_version: "0.81.0" }),
      line("2026-07-21T00:00:01.000Z", "event_msg", { type: "user_message", message: "x" }),
      tokenCount("2026-07-21T00:00:02.000Z", { input: 100, cached: 0, output: 5 }, { input: 100, cached: 0, output: 5 }, null)
    ].join("\n") + "\n"
  );
  const events = await collect(extractCodex(root, "x1"));
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.equal(session.metrics.contextWindowPeakTokens, 100);
  assert.equal("contextWindowPeakPct" in session.metrics, false);
  assert.equal("contextWindowTokens" in session.metrics, false);
  const handoff = buildCodexHandoff(events, "x1", "2026-07-21T01:00:00.000Z");
  assert.equal(handoff.sessions[0].contextWindowPeakPct, null);
  assert.equal(handoff.sessions[0].contextWindowTokens, null);
});

test("archived rollouts are read alongside live ones", async () => {
  const { root } = await makeSnapshot({ archived: true });
  const events = await collect(extractCodex(root, "x1"));
  assert.equal(events.filter((e) => e.eventKind === "create_focus_session").length, 1);
});

test("a rollout that cannot be read is counted on the epoch marker, not skipped in silence", async () => {
  if (process.getuid?.() === 0) return; // root ignores file modes
  const { root, file } = await makeSnapshot();
  await fs.chmod(file, 0o000);
  try {
    const events = await collect(extractCodex(root, "x1"));
    assert.equal(events.filter((e) => e.eventKind === "create_focus_session").length, 0);
    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.ok(epoch, "the store produced no sessions and still reports why");
    assert.equal(epoch.metrics.unreadableRolloutFiles, 1);
  } finally {
    await fs.chmod(file, 0o644);
  }
});

test("an empty snapshot yields nothing at all", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-snap-"));
  assert.deepEqual(await collect(extractCodex(root, "x1")), []);
});

/* ------------------------------------------------------------------------ *
 * Identity on the wire and in the handoff
 * ------------------------------------------------------------------------ */

test("codex is a registered store riding cli_agent with host codex, like the live hooks", async () => {
  assert.ok(HISTORY_STORES.includes("codex"));
  assert.equal(STORE_SOURCE.codex, "cli_agent");
  assert.equal(STORE_HOST.codex, "codex");
  assert.equal(STORE_HOST.claude_code, undefined, "a source that names its tool carries no host");

  const { root } = await makeSnapshot();
  const events = await collect(extractCodex(root, "x1"));
  const session = events.find((e) => e.eventKind === "create_focus_session");
  const payload = toWirePayload(session, 0, "cli_agent:test-install");
  assert.equal(payload.source, "cli_agent");
  assert.equal(payload.metadata.host, "codex");
  assert.equal(payload.eventType, "create_focus_session");
  assert.equal("gitBranch" in payload.metadata, false, "the branch name never reaches the wire");
  assert.equal(typeof payload.metadata.branchHash, "string");
});

test("the codex handoff carries the session shape and a project digest", async () => {
  const { root } = await makeSnapshot();
  const events = await collect(extractCodex(root, "x1"));
  const handoff = buildCodexHandoff(events, "x1", "2026-07-21T01:00:00.000Z");
  assert.equal(handoff.schema, HANDOFF_SCHEMA);
  assert.equal(handoff.store, "codex");
  assert.equal(handoff.windowOldest, T.meta);
  assert.equal(handoff.windowNewest, T.end);
  assert.equal(handoff.sessions.length, 1);
  const s = handoff.sessions[0];
  assert.equal(s.sessionRef, META_ID);
  assert.equal(s.promptCount, 3);
  assert.equal(s.toolCallCount, 3);
  assert.equal(s.toolFailureCount, 3);
  assert.equal(s.compactionCount, 1);
  assert.equal(s.primaryModel, "gpt-5.5");
  assert.equal(s.contextWindowTokens, 258400);
  assert.equal(s.contextWindowPeakTokens, 1500);
  assert.equal(s.startedAt, T.meta);
  assert.equal(s.provenance, "historical_derived");
  // The halves partition the total in milliseconds and are each rounded once
  // at the edge, so their rounded sum can differ from the rounded total by
  // one minute — never more.
  assert.ok(
    Math.abs(s.handsOnMinutes + s.agentSupervisingMinutes - s.activeMinutes) <= 1,
    "the two halves partition the total, to rounding"
  );
  assert.equal("subagentTranscripts" in s, false, "a field this store can never collect is absent, not null");
  assert.equal(handoff.projects.length, 1);
  assert.equal(handoff.projects[0].sessions, 1);
  assert.equal(handoff.projects[0].promptCount, 3);
});

/* ------------------------------------------------------------------------ *
 * Scan
 * ------------------------------------------------------------------------ */

test("scan counts rollouts by file facts only, across both roots", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  const paths = resolveStorePaths(home);
  assert.equal((await scanCodex(paths)).present, false);

  const live = path.join(paths.codexSessions, "2026", "07", "20");
  const archived = path.join(paths.codexArchivedSessions, "2026", "01", "01");
  await fs.mkdir(live, { recursive: true });
  await fs.mkdir(archived, { recursive: true });
  await fs.writeFile(path.join(live, "rollout-a.jsonl"), "not even parsed\n");
  await fs.writeFile(path.join(live, "rollout-b.jsonl"), "x\n");
  await fs.writeFile(path.join(archived, "rollout-c.jsonl"), "y\n");
  await fs.writeFile(path.join(live, "notes.txt"), "ignored\n");

  const inv = await scanCodex(paths);
  assert.equal(inv.present, true);
  assert.equal(inv.counts.rollouts, 2);
  assert.equal(inv.counts.archivedRollouts, 1);
  assert.equal(inv.counts.bytes, 20);
  assert.ok(inv.oldest && inv.newest);
  assert.equal(inv.retentionRisk, undefined, "no purge has been observed, so none is claimed");
});
