/**
 * Prompts the person typed.
 *
 * Claude Code writes some main-thread `user` lines on the person's behalf, and
 * `promptCount` leaves them out: a notification or a peer (`origin.kind`), the
 * runtime's bookkeeping (`isMeta`, `isCompactSummary`), a line that is nothing
 * but wrapper elements, and an interrupt marker. The desktop app's importer
 * declines the same lines and stamps `promptBasis: "typed"`; this package now
 * does both.
 *
 * `fixtures/claude-session-interrupts.jsonl` holds six typed prompts, six
 * interrupt markers, one slash command's output and one tool result.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { isTypedPromptLine } from "../dist/interruptedRuns.js";
import { buildHandoff } from "../dist/localHandoff.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "claude-session-interrupts.jsonl");
const BEFORE = path.join(HERE, "fixtures", "handoff-before-interrupted-runs.json");

async function extractFiles(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "typed-prompts-"));
  const project = path.join(dir, "projects", "-Users-example-Dev-repo-prompts");
  for (const [name, lines] of Object.entries(files)) {
    const file = path.join(project, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, lines.join("\n") + "\n");
  }
  const events = [];
  for await (const event of extractClaudeCode(dir, "extraction-typed-prompts")) events.push(event);
  await fs.rm(dir, { recursive: true, force: true });
  return events;
}

const extractLines = (lines) => extractFiles({ "s1.jsonl": lines });
const sessionOf = (events) => events.find((e) => e.eventKind === "create_focus_session");
const handoffOf = (events) => buildHandoff(events, "extraction-typed-prompts", "2026-09-14T00:00:00.000Z");

/** What a reader does with a handoff's missing stamp. */
const promptBasisRead = (file) => file.promptBasis ?? "every_user_line";

const base = { sessionId: "s1", cwd: "/Users/example/Dev/repo-prompts" };
const userAt = (timestamp, content, extra = {}) =>
  JSON.stringify({ ...base, type: "user", timestamp, message: { role: "user", content }, ...extra });
const replyAt = (timestamp) =>
  JSON.stringify({
    ...base,
    type: "assistant",
    timestamp,
    message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [], usage: { input_tokens: 1, output_tokens: 1 } }
  });
const line = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });

// ── The rule ───────────────────────────────────────────────────────────────

test("lines the runtime writes on the person's behalf aren't typed", () => {
  const declined = {
    "a task notification": line("redacted", { origin: { kind: "task-notification" } }),
    "another session speaking": line("redacted", { origin: { kind: "peer" } }),
    "isMeta": line("redacted", { isMeta: true }),
    "a compaction summary": line("redacted", { isCompactSummary: true }),
    "the interrupt marker": line("[Request interrupted by user]"),
    "its tool-use variant": line([{ type: "text", text: "[Request interrupted by user for tool use]" }]),
    "a slash command": line("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
    "a slash command's stdout": line("<local-command-stdout>redacted</local-command-stdout>"),
    "a slash command's stderr": line("<local-command-stderr>redacted</local-command-stderr>"),
    "the local-command caveat": line([{ type: "text", text: "<local-command-caveat>redacted</local-command-caveat>" }]),
    "a bare reminder": line("  <system-reminder>redacted</system-reminder>\n")
  };
  for (const [what, record] of Object.entries(declined)) {
    assert.equal(isTypedPromptLine(record), false, what);
  }
});

test("a typed prompt is typed, wrapper or not", () => {
  const typed = {
    "plain text": line("redacted"),
    "a text block": line([{ type: "text", text: "redacted" }]),
    "a reminder with a prompt beside it": line("<system-reminder>redacted</system-reminder>\nredacted"),
    "a prompt that opens like a wrapper": line("<command-name> is the tag I meant"),
    "a prompt that mentions the marker": line("why did you write [Request interrupted by user] there?"),
    "a prompt with an image": line([{ type: "text", text: "redacted" }, { type: "image" }]),
    "an origin nobody declines": line("redacted", { origin: { kind: "human" } })
  };
  for (const [what, record] of Object.entries(typed)) {
    assert.equal(isTypedPromptLine(record), true, what);
  }
});

// ── Through the extractor ──────────────────────────────────────────────────

test("promptCount counts the typed prompts, and syntheticPromptLines the rest", async () => {
  const text = await fs.readFile(FIXTURE, "utf8");
  const events = await extractLines(text.trim().split("\n"));
  const session = sessionOf(events);
  assert.equal(session.metrics.promptCount, 6);
  assert.equal(session.metrics.syntheticPromptLines, 7, "six markers and one slash command's output");
  assert.equal(events.filter((e) => e.eventKind === "ai_prompt_submitted").length, 6);
  assert.equal(
    session.dayBreakdown.reduce((sum, d) => sum + d.prompts, 0),
    6,
    "the day slices count the same prompts"
  );
});

test("a declined line bounds nothing: the split reads it like bookkeeping", async () => {
  // A prompt, a reply, something two minutes later, a prompt two minutes after
  // that. Bookkeeping in the middle leaves one four-minute hands-on span; agent
  // output there would cut it to two.
  const around = (middle) => [
    userAt("2026-09-08T12:00:00.000Z", "redacted"),
    replyAt("2026-09-08T12:00:10.000Z"),
    middle,
    userAt("2026-09-08T12:04:10.000Z", "redacted"),
    replyAt("2026-09-08T12:04:20.000Z")
  ];
  const split = (events) => {
    const { handsOnMinutes, agentSupervisingMinutes, activeMinutes, activeSplitInstants } = sessionOf(events).metrics;
    return { handsOnMinutes, agentSupervisingMinutes, activeMinutes, activeSplitInstants };
  };
  const at = "2026-09-08T12:02:10.000Z";
  const bookkeeping = split(await extractLines(around(JSON.stringify({ ...base, type: "attachment", timestamp: at }))));
  const agentOutput = split(await extractLines(around(JSON.stringify({ ...base, type: "system", subtype: "informational", timestamp: at }))));
  assert.notDeepEqual(bookkeeping, agentOutput, "the fixture tells the two apart");

  for (const [what, middle] of Object.entries({
    "a notification": userAt(at, "redacted", { origin: { kind: "task-notification" } }),
    "an isMeta line": userAt(at, "redacted", { isMeta: true }),
    "a slash command's output": userAt(at, "<local-command-stdout>redacted</local-command-stdout>"),
    "an interrupt marker": userAt(at, "[Request interrupted by user]")
  })) {
    assert.deepEqual(split(await extractLines(around(middle))), bookkeeping, what);
  }
});

test("a subagent's lines stay subagent prompts, never synthetic ones", async () => {
  const events = await extractFiles({
    "s1.jsonl": [userAt("2026-09-08T12:00:00.000Z", "redacted"), replyAt("2026-09-08T12:00:05.000Z")],
    "s1/subagents/agent-1.jsonl": [userAt("2026-09-08T12:00:01.000Z", "redacted", { isSidechain: true, isMeta: true })]
  });
  const { metrics } = sessionOf(events);
  assert.equal(metrics.promptCount, 1);
  assert.equal(metrics.syntheticPromptLines, 0);
  assert.equal(metrics.subagentPrompts, 1);
});

// ── The handoff and its stamp ──────────────────────────────────────────────

test("the handoff stamps promptBasis typed and carries the receipt per session", async () => {
  const handoff = handoffOf(
    await extractLines([
      userAt("2026-09-08T12:00:00.000Z", "redacted"),
      userAt("2026-09-08T12:00:01.000Z", "redacted", { isMeta: true }),
      replyAt("2026-09-08T12:00:05.000Z")
    ])
  );
  assert.equal(handoff.promptBasis, "typed");
  assert.equal(handoff.sessions[0].promptCount, 1);
  assert.equal(handoff.sessions[0].syntheticPromptLines, 1);
});

test("a handoff from before the stamp reads as every user line, and the schema doesn't move", async () => {
  const before = JSON.parse(await fs.readFile(BEFORE, "utf8"));
  assert.equal("promptBasis" in before, false);
  assert.equal(promptBasisRead(before), "every_user_line");
  for (const session of before.sessions) assert.equal("syntheticPromptLines" in session, false);

  const after = handoffOf(await extractLines([userAt("2026-09-08T12:00:00.000Z", "redacted"), replyAt("2026-09-08T12:00:05.000Z")]));
  assert.equal(after.schema, before.schema);
  assert.equal(promptBasisRead(after), "typed");
});
