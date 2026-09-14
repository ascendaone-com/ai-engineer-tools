/**
 * Runs the person cut short.
 *
 * `fixtures/claude-session-interrupts.jsonl` is a hand-built Claude Code
 * transcript with no content in it: every text is `redacted` or an interrupt
 * marker, and the line shapes (`stop_reason`, `interruptedByShutdown`, the
 * `stop_hook_summary` system line, the `for tool use` marker variant) are the
 * ones real transcripts carry. It holds six markers and three cuts:
 *
 *  | when (UTC)        | the marker follows                        | counts |
 *  |-------------------|-------------------------------------------|--------|
 *  | 8 Sep 12:00:09    | a tool result (`for tool use` variant)    | yes    |
 *  | 8 Sep 12:00:33    | a reply still streaming (no stop_reason)  | yes    |
 *  | 8 Sep 12:03:00    | `end_turn` and the stop-hook summary      | no     |
 *  | 8 Sep 12:04:03    | a tool call, but the app was shutting down| no     |
 *  | 9 Sep 12:00:01    | a prompt, before any reply                | yes    |
 *  | 9 Sep 12:00:21    | a finished turn, then a slash command     | no     |
 *
 * The desktop app's importer runs the same fixture in its own parity test, so
 * a change to what counts here has to be made there too.
 *
 * `fixtures/handoff-before-interrupted-runs.json` is a handoff written by this
 * package before the count existed, for a small session with no marker in it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { isInterruptionMarkerLine, stepRun } from "../dist/interruptedRuns.js";
import { buildHandoff } from "../dist/localHandoff.js";
import { localDayKey } from "../dist/daySlice.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "claude-session-interrupts.jsonl");
const BEFORE = path.join(HERE, "fixtures", "handoff-before-interrupted-runs.json");

async function extractLines(lines, name = "aaaaaaaa-bbbb-cccc-dddd-000000000077") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "interrupted-runs-"));
  const project = path.join(dir, "projects", "-Users-example-Dev-repo-interrupts");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, `${name}.jsonl`), lines.join("\n") + "\n");
  const events = [];
  for await (const event of extractClaudeCode(dir, "extraction-interrupted-runs")) events.push(event);
  await fs.rm(dir, { recursive: true, force: true });
  return events;
}

async function extractFixture() {
  const text = await fs.readFile(FIXTURE, "utf8");
  return extractLines(text.trim().split("\n"));
}

const sessionOf = (events) => events.find((e) => e.eventKind === "create_focus_session");
const handoffOf = (events) => buildHandoff(events, "extraction-interrupted-runs", "2026-09-14T00:00:00.000Z");
const dayOf = (iso) => localDayKey(new Date(iso));

/** What a reader does with a handoff: the count, or null for "not counted". */
function interruptedRunsRead(file, session) {
  if (file.interruptedRunsCounted !== true) return null;
  return typeof session.interruptedRuns === "number" ? session.interruptedRuns : null;
}

const base = { sessionId: "s", cwd: "/Users/example/Dev/repo-interrupts", timestamp: "2026-09-08T12:00:00.000Z" };
const prompt = (ts) => JSON.stringify({ ...base, type: "user", timestamp: ts, message: { role: "user", content: "redacted" } });
const reply = (ts, stop) =>
  JSON.stringify({ ...base, type: "assistant", timestamp: ts, message: { role: "assistant", model: "claude-opus-5", stop_reason: stop, content: [] } });
const marker = (ts, extra = {}) =>
  JSON.stringify({ ...base, type: "user", timestamp: ts, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, ...extra });

// ── The marker ─────────────────────────────────────────────────────────────

test("both marker spellings are markers, and a prompt that mentions one isn't", () => {
  const line = (content) => ({ type: "user", message: { role: "user", content } });
  assert.equal(isInterruptionMarkerLine(line("[Request interrupted by user]")), true);
  assert.equal(isInterruptionMarkerLine(line([{ type: "text", text: "[Request interrupted by user for tool use]" }])), true);
  assert.equal(isInterruptionMarkerLine(line("why did you write [Request interrupted by user] there?")), false);
  assert.equal(
    isInterruptionMarkerLine(line([{ type: "text", text: "[Request interrupted by user]" }, { type: "image" }])),
    false,
    "a line carrying a non-text block isn't judged"
  );
});

// ── Through the extractor ──────────────────────────────────────────────────

test("a cut mid-turn counts: after a tool result, while streaming, and before any reply", async () => {
  const session = sessionOf(await extractFixture());
  assert.equal(session.metrics.interruptedRuns, 3);
});

test("an interrupt after the turn ended, or from the app shutting down, doesn't count", () => {
  const isToolResult = () => false;
  let running = true;
  ({ running } = stepRun(running, JSON.parse(reply("2026-09-08T12:01:05.000Z", "end_turn")), isToolResult));
  assert.equal(running, false);
  assert.equal(stepRun(running, JSON.parse(marker("2026-09-08T12:03:00.000Z")), isToolResult).cut, false);

  assert.equal(
    stepRun(true, JSON.parse(marker("2026-09-08T12:04:03.000Z", { interruptedByShutdown: true })), isToolResult).cut,
    false
  );
  assert.equal(stepRun(true, JSON.parse(marker("2026-09-08T12:04:03.000Z")), isToolResult).cut, true);

  const summary = { type: "system", subtype: "stop_hook_summary" };
  assert.equal(stepRun(true, summary, isToolResult).running, false);
});

test("a slash command's output after a finished turn doesn't start one", () => {
  const stdout = { type: "user", message: { role: "user", content: "<local-command-stdout>redacted</local-command-stdout>" } };
  assert.equal(stepRun(false, stdout, () => false).running, false);
});

test("cuts land on the local day of the marker, the way prompts do", async () => {
  const session = sessionOf(await extractFixture());
  const byDay = Object.fromEntries(session.dayBreakdown.map((d) => [d.day, d.interruptedRuns]));
  const first = dayOf("2026-09-08T12:00:09.000Z");
  const second = dayOf("2026-09-09T12:00:01.000Z");
  assert.equal(byDay[first], 2);
  assert.equal(byDay[second], 1);
  assert.equal(
    session.dayBreakdown.reduce((sum, d) => sum + d.interruptedRuns, 0),
    session.metrics.interruptedRuns,
    "every dated cut is placed on exactly one day"
  );
});

test("a subagent transcript's markers are never the person's cut", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "interrupted-runs-sub-"));
  const project = path.join(dir, "projects", "-Users-example-Dev-repo-interrupts");
  const nested = path.join(project, "s1", "subagents");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(project, "s1.jsonl"), [prompt("2026-09-08T12:00:00.000Z"), reply("2026-09-08T12:00:05.000Z", "end_turn")].join("\n"));
  await fs.writeFile(
    path.join(nested, "agent-1.jsonl"),
    [reply("2026-09-08T12:00:01.000Z", "tool_use"), marker("2026-09-08T12:00:02.000Z", { isSidechain: true })].join("\n")
  );
  const events = [];
  for await (const event of extractClaudeCode(dir, "x")) events.push(event);
  await fs.rm(dir, { recursive: true, force: true });
  assert.equal(sessionOf(events).metrics.interruptedRuns, 0);
});

// ── The handoff and its label ──────────────────────────────────────────────

test("a session with no interrupts writes 0, and the label says it was counted", async () => {
  const events = await extractLines([prompt("2026-09-08T12:00:00.000Z"), reply("2026-09-08T12:00:05.000Z", "end_turn")]);
  const handoff = handoffOf(events);
  assert.equal(handoff.interruptedRunsCounted, true);
  assert.equal(handoff.sessions[0].interruptedRuns, 0);
  assert.deepEqual(
    handoff.sessions[0].days.map((d) => d.interruptedRuns),
    [0],
    "every day slice carries the count, zero included"
  );
  assert.equal(interruptedRunsRead(handoff, handoff.sessions[0]), 0);
});

test("the schema doesn't move: the label is additive", async () => {
  const before = JSON.parse(await fs.readFile(BEFORE, "utf8"));
  const after = handoffOf(await extractLines([prompt("2026-09-08T12:00:00.000Z"), reply("2026-09-08T12:00:05.000Z", "end_turn")]));
  assert.equal(after.schema, before.schema);
});

test("a handoff from before this change reads as not counted, never as zero", async () => {
  const before = JSON.parse(await fs.readFile(BEFORE, "utf8"));
  assert.equal("interruptedRunsCounted" in before, false);
  assert.ok(before.sessions.length > 0, "the fixture holds a session to read");
  for (const session of before.sessions) {
    assert.equal("interruptedRuns" in session, false);
    for (const day of session.days) assert.equal("interruptedRuns" in day, false);
    assert.equal(interruptedRunsRead(before, session), null);
  }
});
