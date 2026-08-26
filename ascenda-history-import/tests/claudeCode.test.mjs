import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  sniffClaudeLine,
  KNOWN_CLAUDE_LINE_TYPES,
  extractClaudeCode,
  isToolFailureLine
} from "../dist/extractors/claudeCode.js";

// Fixture lines shaped like Claude Code 2.1.x transcripts (real field shapes,
// content replaced). Per the contract-test rule: one fixture set per known
// (tool, version) pair, and
// an unknown shape must sniff as unparsed rather than half-parse.

const userLine = JSON.stringify({
  type: "user",
  timestamp: "2026-07-21T03:14:15.926Z",
  sessionId: "0f0e0d0c-1111-2222-3333-444455556666",
  version: "2.1.227",
  cwd: "/Users/example/Dev/some-repo",
  gitBranch: "main",
  message: { role: "user", content: "redacted" }
});

const assistantLine = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-21T03:14:22.001Z",
  sessionId: "0f0e0d0c-1111-2222-3333-444455556666",
  version: "2.1.227",
  message: {
    role: "assistant",
    model: "claude-opus-5",
    usage: { input_tokens: 12, output_tokens: 34 }
  }
});

test("sniffs a user line with its schema anchor fields", () => {
  const sniffed = sniffClaudeLine(userLine);
  assert.equal(sniffed.kind, "user");
  assert.equal(sniffed.sourceVersion, "2.1.227");
  assert.equal(sniffed.occurredAt, "2026-07-21T03:14:15.926Z");
  assert.equal(sniffed.sessionId, "0f0e0d0c-1111-2222-3333-444455556666");
});

test("sniffs the model id off an assistant line", () => {
  const sniffed = sniffClaudeLine(assistantLine);
  assert.equal(sniffed.kind, "assistant");
  assert.equal(sniffed.model, "claude-opus-5");
});

// Pinned literal, deliberately NOT derived from KNOWN_CLAUDE_LINE_TYPES. The
// loop below used to iterate the constant it was validating, which made it a
// tautology: deleting a type from the extractor deleted the assertion that
// covered it, and the suite stayed green. Verified by removing "attachment"
// and "last-prompt" from the constant — all 108 tests passed. A dropped type
// stops being parsed and starts counting as `unknownLines`, i.e. the drift
// signal itself becomes the drift, so this list must be updated by hand and
// on purpose.
const DOCUMENTED_CLAUDE_LINE_TYPES = [
  "user",
  "assistant",
  "attachment",
  "system",
  "queue-operation",
  "last-prompt",
  "custom-title"
];

test("every documented line type is recognised", () => {
  for (const type of DOCUMENTED_CLAUDE_LINE_TYPES) {
    const sniffed = sniffClaudeLine(JSON.stringify({ type, version: "2.1.227" }));
    assert.equal(sniffed.kind, type, `expected ${type} to be known`);
  }
});

test("the extractor's known-type list matches the documented one", () => {
  // Fails in both directions: a type quietly dropped from the extractor, and a
  // type added without a fixture or a decision about what it should fold into.
  assert.deepEqual(
    [...KNOWN_CLAUDE_LINE_TYPES].sort(),
    [...DOCUMENTED_CLAUDE_LINE_TYPES].sort()
  );
});

test("unknown-but-valid line types sniff as unknown with the type named", () => {
  const alien = JSON.stringify({ type: "hologram", version: "99.0.0" });
  const sniffed = sniffClaudeLine(alien);
  assert.equal(sniffed.kind, "unknown");
  assert.equal(sniffed.type, "hologram");
});

test("observed meta types (mode, ai-title, pr-link) are unknown, not unparsed", () => {
  for (const type of ["mode", "ai-title", "pr-link", "worktree-state"]) {
    assert.equal(sniffClaudeLine(JSON.stringify({ type })).kind, "unknown");
  }
});

test("non-JSON and blank lines sniff as unparsed", () => {
  assert.equal(sniffClaudeLine("not json at all").kind, "unparsed");
  assert.equal(sniffClaudeLine("").kind, "unparsed");
  assert.equal(sniffClaudeLine("   ").kind, "unparsed");
});

test("a JSON scalar is unparsed, not a crash", () => {
  assert.equal(sniffClaudeLine("42").kind, "unparsed");
  assert.equal(sniffClaudeLine("null").kind, "unparsed");
});

test("isToolFailureLine reads the is_error marker, not the toolUseResult text", () => {
  assert.equal(
    isToolFailureLine({ message: { content: [{ type: "tool_result", is_error: true }] } }),
    true
  );
  assert.equal(
    isToolFailureLine({ message: { content: [{ type: "tool_result", is_error: false }] } }),
    false
  );
  assert.equal(isToolFailureLine({ message: { content: [{ type: "tool_result" }] } }), false);
  // A string toolUseResult alone (no is_error flag reachable) is not enough —
  // several tools' error text doesn't start with "Error", so the marker is
  // read structurally rather than sniffed from formatting.
  assert.equal(
    isToolFailureLine({ toolUseResult: "Error: boom", message: { content: "typed by a person" } }),
    false
  );
  assert.equal(isToolFailureLine({ message: { content: [{ type: "text", text: "hi" }] } }), false);
});

// Contract-vocabulary pin. The backend's metrics service reads
// `durationBucket` off create_focus_session events expecting exactly the
// tool-contract vocabulary ("0-1m" | "1-5m" | "5-10m" | "10-30m" | "30-60m" |
// "60m+", packages/tool-contract/src/index.ts DurationBucket). This extractor
// used to emit a third, incompatible dialect ("0-5m" | "5-30m" | ...), which
// silently zeroed out SessionMinutesPerDay for every historical session. This
// test fails if that drift reopens, from either side: a bucket string outside
// the contract vocabulary, or a session whose durationBucket and sessionMinutes
// disagree about which bucket the duration falls in.
const CONTRACT_DURATION_BUCKETS = new Set(["0-1m", "1-5m", "5-10m", "10-30m", "30-60m", "60m+"]);

async function withTempSnapshot(lines, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-import-test-"));
  try {
    const projectDir = path.join(dir, "projects", "testproj");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "session1.jsonl"), lines.join("\n") + "\n", "utf8");
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("create_focus_session emits a contract-vocabulary durationBucket plus exact sessionMinutes", async () => {
  const start = "2026-07-21T03:00:00.000Z";
  const end = "2026-07-21T03:03:00.000Z"; // 3 minutes apart — falls in "1-5m"
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: start,
      sessionId: "session1",
      version: "2.1.227",
      cwd: "/Users/example/Dev/testproj",
      message: { role: "user", content: "redacted" }
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: end,
      sessionId: "session1",
      version: "2.1.227",
      message: { role: "assistant", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } }
    })
  ];

  await withTempSnapshot(lines, async (snapshotDir) => {
    const events = [];
    for await (const event of extractClaudeCode(snapshotDir, "extraction-1")) {
      events.push(event);
    }
    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.ok(session, "expected a create_focus_session event");
    assert.ok(
      CONTRACT_DURATION_BUCKETS.has(session.metrics.durationBucket),
      `durationBucket ${session.metrics.durationBucket} is not in the tool-contract vocabulary`
    );
    assert.equal(session.metrics.durationBucket, "1-5m");
    assert.equal(session.metrics.sessionMinutes, 3);
  });
});
