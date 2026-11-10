/**
 * The effort setting, folded per session out of Claude Code and Codex stores:
 * `primaryEffort` in metrics (on the wire, with `effortClass` beside it), and
 * `effortChanges` beside metrics (to the handoff only).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { extractCodex } from "../dist/extractors/codex.js";
import { effortChangesOf, effortLevelOf, foldEffort, newEffortTrack, primaryEffortOf } from "../dist/effortFold.js";
import { buildCodexHandoff, buildHandoff } from "../dist/localHandoff.js";
import { toWirePayload } from "../dist/ship.js";

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const SESSION = "0f0e0d0c-1111-2222-3333-444455556666";

function user(timestamp) {
  return JSON.stringify({ type: "user", timestamp, sessionId: SESSION, version: "2.1.280", cwd: "/Users/example/Dev/testproj", message: { role: "user", content: "redacted" } });
}

// The shape Claude Code 2.1.2xx writes: a top-level `effort` string on each
// assistant line, beside the message.
function assistant(timestamp, effort, { id, model = "claude-opus-5-5", sidechain = false } = {}) {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    sessionId: SESSION,
    version: "2.1.280",
    ...(sidechain ? { isSidechain: true } : {}),
    ...(effort === undefined ? {} : { effort }),
    message: { id: id ?? `msg-${timestamp}`, role: "assistant", model, usage: { input_tokens: 1, output_tokens: 1 } }
  });
}

async function claudeSession(lines, subagentLines = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "effort-claude-"));
  try {
    const projectDir = path.join(dir, "projects", "testproj");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, `${SESSION}.jsonl`), lines.join("\n") + "\n", "utf8");
    if (subagentLines.length > 0) {
      // Where Claude Code writes a subagent's own transcript.
      const subDir = path.join(projectDir, SESSION, "subagents");
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(subDir, "agent-a1.jsonl"), subagentLines.join("\n") + "\n", "utf8");
    }
    const events = await collect(extractClaudeCode(dir, "x-effort"));
    return { events, session: events.find((e) => e.eventKind === "create_focus_session") };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("the fold: primary is the most common level, changes are in time order with the opening first", () => {
  const track = newEffortTrack();
  // Out of order on purpose: a session's lines can reach the fold from more
  // than one file.
  foldEffort(track, "high", "2026-11-10T10:05:00.000Z");
  foldEffort(track, "medium", "2026-11-10T10:00:00.000Z");
  foldEffort(track, "medium", "2026-11-10T10:01:00.000Z");
  foldEffort(track, "high", "2026-11-10T10:06:00.000Z");
  foldEffort(track, "high", null); // undated: counts, isn't placed
  assert.equal(primaryEffortOf(track), "high");
  assert.deepEqual(effortChangesOf(track), [
    { at: "2026-11-10T10:00:00.000Z", level: "medium" },
    { at: "2026-11-10T10:05:00.000Z", level: "high" }
  ]);
});

test("the fold: ties go to the level seen first, and nothing seen is null and empty", () => {
  const track = newEffortTrack();
  foldEffort(track, "medium", "2026-11-10T10:00:00.000Z");
  foldEffort(track, "high", "2026-11-10T10:01:00.000Z");
  assert.equal(primaryEffortOf(track), "medium");
  const empty = newEffortTrack();
  foldEffort(empty, undefined, "2026-11-10T10:00:00.000Z");
  foldEffort(empty, "  ", "2026-11-10T10:00:00.000Z");
  assert.equal(primaryEffortOf(empty), null);
  assert.deepEqual(effortChangesOf(empty), []);
});

test("the level reads a bare string or the hook payload's { level }, trimmed", () => {
  assert.equal(effortLevelOf("high"), "high");
  assert.equal(effortLevelOf(" xhigh "), "xhigh");
  assert.equal(effortLevelOf({ level: "low" }), "low");
  assert.equal(effortLevelOf({}), null);
  assert.equal(effortLevelOf(3), null);
  assert.equal(effortLevelOf(null), null);
});

test("claude code: a session that switched from medium to high keeps both", async () => {
  const { session } = await claudeSession([
    user("2026-11-10T09:00:00.000Z"),
    assistant("2026-11-10T09:00:05.000Z", "medium"),
    assistant("2026-11-10T09:00:10.000Z", "medium"),
    user("2026-11-10T09:10:00.000Z"),
    assistant("2026-11-10T09:10:05.000Z", "high"),
    assistant("2026-11-10T09:10:10.000Z", "high"),
    assistant("2026-11-10T09:10:15.000Z", "high")
  ]);
  assert.equal(session.metrics.primaryEffort, "high");
  assert.deepEqual(session.effortChanges, [
    { at: "2026-11-10T09:00:05.000Z", level: "medium" },
    { at: "2026-11-10T09:10:05.000Z", level: "high" }
  ]);
});

test("claude code: a transcript from before the field existed carries no effort at all", async () => {
  const { session } = await claudeSession([
    user("2026-11-10T09:00:00.000Z"),
    assistant("2026-11-10T09:00:05.000Z", undefined),
    assistant("2026-11-10T09:00:10.000Z", undefined)
  ]);
  assert.ok(!("primaryEffort" in session.metrics), "missing means unknown, never a default level");
  assert.ok(!("effortChanges" in session));
});

test("claude code: notices, subagent turns and split messages don't vote", async () => {
  const { session } = await claudeSession([
    user("2026-11-10T09:00:00.000Z"),
    assistant("2026-11-10T09:00:05.000Z", "medium"),
    // A runtime notice: no model ran.
    assistant("2026-11-10T09:00:06.000Z", "high", { model: "<synthetic>" }),
    // One API message written as two lines counts once.
    assistant("2026-11-10T09:00:09.000Z", "low", { id: "split" }),
    assistant("2026-11-10T09:00:09.500Z", "low", { id: "split" }),
    assistant("2026-11-10T09:00:12.000Z", "medium")
  ], [
    // A subagent's turns run at their own setting, in their own transcript.
    assistant("2026-11-10T09:00:07.000Z", "high", { sidechain: true, id: "sub-1" }),
    assistant("2026-11-10T09:00:08.000Z", "high", { sidechain: true, id: "sub-2" }),
    assistant("2026-11-10T09:00:08.500Z", "high", { sidechain: true, id: "sub-3" })
  ]);
  assert.ok(session.metrics.subagentTranscripts >= 1 || session.metrics.subagentAssistantTurns >= 1, "the subagent file was read");
  assert.equal(session.metrics.primaryEffort, "medium");
  assert.deepEqual(session.effortChanges.map((c) => c.level), ["medium", "low", "medium"]);
});

test("claude code: the handoff carries both, and the wire carries the primary and its class", async () => {
  const { events, session } = await claudeSession([
    user("2026-11-10T09:00:00.000Z"),
    assistant("2026-11-10T09:00:05.000Z", "medium"),
    assistant("2026-11-10T09:10:05.000Z", "xhigh"),
    assistant("2026-11-10T09:10:06.000Z", "xhigh")
  ]);
  const handoff = buildHandoff(events, "x-effort", "2026-11-11T00:00:00.000Z");
  const s = handoff.sessions.find((x) => x.sessionRef === SESSION);
  assert.equal(s.primaryEffort, "xhigh");
  assert.deepEqual(s.effortChanges.map((c) => c.level), ["medium", "xhigh"]);

  const metadata = toWirePayload(session, 0, "claude_code:test-install").metadata;
  assert.equal(metadata.primaryEffort, "xhigh");
  assert.equal(metadata.effortClass, "xhigh");
  assert.ok(!("effortChanges" in metadata), "the timeline stays on the machine");
});

test("the handoff says null and empty for a session with no effort", async () => {
  const { events } = await claudeSession([user("2026-11-10T09:00:00.000Z"), assistant("2026-11-10T09:00:05.000Z", undefined)]);
  const s = buildHandoff(events, "x", "2026-11-11T00:00:00.000Z").sessions[0];
  assert.equal(s.primaryEffort, null);
  assert.deepEqual(s.effortChanges, []);
});

// Codex writes `effort` on each turn_context line.
function codexLine(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

test("codex: turn_context effort folds into the primary and the timeline", async () => {
  const id = "019bd8bb-16b9-7431-a616-88eee7b38dfe";
  const cwd = "/Users/example/Dev/repo-a";
  const lines = [
    codexLine("2026-11-10T10:00:00.000Z", "session_meta", { id, session_id: id, timestamp: "2026-11-10T10:00:00.000Z", cwd, cli_version: "0.153.4" }),
    codexLine("2026-11-10T10:00:01.000Z", "event_msg", { type: "user_message", message: "redacted", images: [] }),
    codexLine("2026-11-10T10:00:01.000Z", "turn_context", { turn_id: "t1", cwd, model: "gpt-6-astra", effort: "medium" }),
    codexLine("2026-11-10T10:05:00.000Z", "event_msg", { type: "user_message", message: "redacted", images: [] }),
    codexLine("2026-11-10T10:05:00.000Z", "turn_context", { turn_id: "t2", cwd, model: "gpt-6-astra", effort: "high" }),
    codexLine("2026-11-10T10:09:00.000Z", "event_msg", { type: "user_message", message: "redacted", images: [] }),
    codexLine("2026-11-10T10:09:00.000Z", "turn_context", { turn_id: "t3", cwd, model: "gpt-6-astra", effort: "high" })
  ];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "effort-codex-"));
  try {
    const dir = path.join(root, "sessions", "2026", "11", "10");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `rollout-2026-11-10T10-00-00-${id}.jsonl`), lines.join("\n") + "\n");
    const events = await collect(extractCodex(root, "x-codex"));
    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.equal(session.metrics.primaryEffort, "high");
    assert.deepEqual(session.effortChanges, [
      { at: "2026-11-10T10:00:01.000Z", level: "medium" },
      { at: "2026-11-10T10:05:00.000Z", level: "high" }
    ]);
    const s = buildCodexHandoff(events, "x-codex", "2026-11-11T00:00:00.000Z").sessions[0];
    assert.equal(s.primaryEffort, "high");
    assert.equal(s.effortChanges.length, 2);
    assert.equal(toWirePayload(session, 0, "codex:test-install").metadata.effortClass, "high");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
