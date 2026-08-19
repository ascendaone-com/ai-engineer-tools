import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  extractCursor,
  sniffCursorHeaderRow,
  sniffCursorBubbleRow,
  KNOWN_CURSOR_BUBBLE_VERSIONS,
  KNOWN_CURSOR_HEADER_TYPES
} from "../dist/extractors/cursor.js";

// Fixtures are shaped like a real Cursor 2026-08-18 store (147 composerHeaders
// / 17,727 bubbles, verified live): composerHeaders rows are real columns
// (composerId/createdAt/lastUpdatedAt/isSubagent) plus a `value` JSON blob
// self-labelling `"type":"head"`; bubbles are `cursorDiskKV` rows keyed
// `bubbleId:<composer>:<bubble>` self-labelling `_v` (uniformly 3 observed).
// Per the contract-test rule: one fixture per known (tool, version) pair, and
// an unknown _v / unknown header type must sniff as unparsed/unknown rather
// than half-parse.

const C1 = "11111111-1111-1111-1111-111111111111"; // normal composer — the session under test
const C2 = "22222222-2222-2222-2222-222222222222"; // subagent of C1
const C3 = "33333333-3333-3333-3333-333333333333"; // header with an unrecognised value.type — schema drift
const C4 = "44444444-4444-4444-4444-444444444444"; // subagent whose parent (C3) never got a fold
const ORPHAN = "55555555-5555-5555-5555-555555555555"; // bubbles with no header row at all

const CREATED_AT_MS = Date.UTC(2026, 6, 20, 10, 0, 0); // 2026-07-20T10:00:00Z
const UPDATED_AT_MS = CREATED_AT_MS + 4 * 60_000; // 4 minutes later — falls in "1-5m"

// Constructed from LOCAL field values (not a fixed UTC string) so the
// after-hours assertion holds regardless of the machine/CI running the test
// — the same technique isAfterHours itself compares against.
const AFTER_HOURS_DATE = new Date(2026, 6, 20, 23, 30, 0);
const IN_HOURS_DATE = new Date(2026, 6, 20, 14, 0, 0);

function sqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function headerRow({ composerId, createdAtMs, lastUpdatedAtMs, isSubagent, value }) {
  return `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, value) VALUES (${sqlString(
    composerId
  )}, 'workspace-1', ${createdAtMs}, ${lastUpdatedAtMs}, ${isSubagent ? 1 : 0}, ${sqlString(
    JSON.stringify(value)
  )});`;
}

function bubbleRow({ composerId, bubbleId, value }) {
  return `INSERT INTO cursorDiskKV (key, value) VALUES (${sqlString(
    `bubbleId:${composerId}:${bubbleId}`
  )}, ${sqlString(JSON.stringify(value))});`;
}

async function makeFixtureStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-import-test-"));

  const statements = [
    "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT);",
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",

    headerRow({
      composerId: C1,
      createdAtMs: CREATED_AT_MS,
      lastUpdatedAtMs: UPDATED_AT_MS,
      isSubagent: false,
      value: {
        type: "head",
        composerId: C1,
        name: "SECRET_TEXT_MARKER should never leak into a metric",
        totalLinesAdded: 42,
        totalLinesRemoved: 7,
        filesChangedCount: 3,
        contextUsagePercent: 55.25,
        unifiedMode: "agent",
        trackedGitRepos: [{ repoPath: "/Users/example/Dev/repo-a", branches: [{ branchName: "main" }] }],
        workspaceIdentifier: { uri: { fsPath: "/Users/example/Dev/repo-a" } }
      }
    }),
    headerRow({
      composerId: C2,
      createdAtMs: CREATED_AT_MS,
      lastUpdatedAtMs: UPDATED_AT_MS,
      isSubagent: true,
      value: {
        type: "head",
        composerId: C2,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        filesChangedCount: 0,
        contextUsagePercent: 0,
        unifiedMode: "agent",
        subagentInfo: { parentComposerId: C1, subagentTypeName: "explore" }
      }
    }),
    headerRow({
      composerId: C3,
      createdAtMs: CREATED_AT_MS,
      lastUpdatedAtMs: UPDATED_AT_MS,
      isSubagent: false,
      value: { type: "future_shape", composerId: C3 }
    }),
    headerRow({
      composerId: C4,
      createdAtMs: CREATED_AT_MS,
      lastUpdatedAtMs: UPDATED_AT_MS,
      isSubagent: true,
      value: {
        type: "head",
        composerId: C4,
        subagentInfo: { parentComposerId: C3, subagentTypeName: "explore" }
      }
    }),

    // C1's own bubbles.
    bubbleRow({
      composerId: C1,
      bubbleId: "b1",
      value: {
        _v: 3,
        type: 1,
        createdAt: IN_HOURS_DATE.toISOString(),
        text: "SECRET_TEXT_MARKER prompt text",
        tokenCount: { inputTokens: 0, outputTokens: 0 },
        humanChanges: [],
        approximateLintErrors: [],
        modelInfo: { modelName: "claude-opus-5" }
      }
    }),
    bubbleRow({
      composerId: C1,
      bubbleId: "b2",
      value: {
        _v: 3,
        type: 2,
        createdAt: IN_HOURS_DATE.toISOString(),
        text: "SECRET_TEXT_MARKER response text",
        tokenCount: { inputTokens: 10, outputTokens: 100 },
        humanChanges: [],
        approximateLintErrors: [],
        modelInfo: { modelName: "claude-opus-5" }
      }
    }),
    bubbleRow({
      composerId: C1,
      bubbleId: "b3",
      value: {
        _v: 3,
        type: 1,
        createdAt: AFTER_HOURS_DATE.toISOString(),
        tokenCount: { inputTokens: 0, outputTokens: 0 },
        humanChanges: [],
        approximateLintErrors: [],
        modelInfo: { modelName: "claude-opus-5" }
      }
    }),
    bubbleRow({
      composerId: C1,
      bubbleId: "b4",
      value: {
        _v: 3,
        type: 2,
        createdAt: IN_HOURS_DATE.toISOString(),
        tokenCount: { inputTokens: 5, outputTokens: 50 },
        humanChanges: [{ range: "1-2" }, { range: "5-6" }],
        approximateLintErrors: [{ line: 10 }],
        modelInfo: { modelName: "claude-opus-5" }
      }
    }),
    bubbleRow({
      composerId: C1,
      bubbleId: "b5-unparsed",
      value: { _v: 99, type: 1, createdAt: IN_HOURS_DATE.toISOString() }
    }),
    bubbleRow({
      composerId: C1,
      bubbleId: "b6-unknown-type",
      value: { _v: 3, type: 5, createdAt: IN_HOURS_DATE.toISOString() }
    }),

    // C2's bubbles — one task instruction, one assistant turn. Both fold
    // into C1's subagent* breakdown, neither becomes C1's own prompt/turn.
    bubbleRow({
      composerId: C2,
      bubbleId: "s1",
      value: {
        _v: 3,
        type: 1,
        createdAt: IN_HOURS_DATE.toISOString(),
        text: "SECRET_TEXT_MARKER task instruction",
        tokenCount: { inputTokens: 0, outputTokens: 0 }
      }
    }),
    bubbleRow({
      composerId: C2,
      bubbleId: "s2",
      value: {
        _v: 3,
        type: 2,
        createdAt: IN_HOURS_DATE.toISOString(),
        tokenCount: { inputTokens: 20, outputTokens: 200 }
      }
    }),

    // C3's bubble — its header was schema-drifted, so this becomes orphaned.
    bubbleRow({
      composerId: C3,
      bubbleId: "o1",
      value: { _v: 3, type: 2, createdAt: IN_HOURS_DATE.toISOString(), tokenCount: {} }
    }),
    // C4's bubble — a subagent whose parent (C3) never got a fold.
    bubbleRow({
      composerId: C4,
      bubbleId: "o2",
      value: { _v: 3, type: 2, createdAt: IN_HOURS_DATE.toISOString(), tokenCount: {} }
    }),
    // No header at all for ORPHAN.
    bubbleRow({
      composerId: ORPHAN,
      bubbleId: "o3",
      value: { _v: 3, type: 1, createdAt: IN_HOURS_DATE.toISOString(), tokenCount: {} }
    })
  ];

  execFileSync("sqlite3", [path.join(dir, "state.vscdb")], { input: statements.join("\n") });
  return dir;
}

test("sniffCursorHeaderRow dispatches on value.type, treating a missing type as unparsed", () => {
  assert.equal(KNOWN_CURSOR_HEADER_TYPES.has("head"), true);
  const known = sniffCursorHeaderRow({
    composerId: "c",
    createdAt: 1,
    lastUpdatedAt: 2,
    isSubagent: 0,
    recordType: "head",
    linesAdded: 1,
    linesRemoved: 0,
    filesChangedCount: 0,
    contextUsagePercent: 10,
    mode: "agent",
    trackedGitReposJson: null,
    workspaceFsPath: null,
    parentComposerId: null
  });
  assert.equal(known.kind, "head");

  const futureShape = sniffCursorHeaderRow({
    composerId: "c",
    createdAt: 1,
    lastUpdatedAt: 2,
    isSubagent: 0,
    recordType: "future_shape",
    linesAdded: null,
    linesRemoved: null,
    filesChangedCount: null,
    contextUsagePercent: null,
    mode: null,
    trackedGitReposJson: null,
    workspaceFsPath: null,
    parentComposerId: null
  });
  assert.deepEqual(futureShape, { kind: "unknown", type: "future_shape" });

  assert.deepEqual(
    sniffCursorHeaderRow({
      composerId: "c",
      createdAt: 1,
      lastUpdatedAt: 2,
      isSubagent: 0,
      recordType: null,
      linesAdded: null,
      linesRemoved: null,
      filesChangedCount: null,
      contextUsagePercent: null,
      mode: null,
      trackedGitReposJson: null,
      workspaceFsPath: null,
      parentComposerId: null
    }),
    { kind: "unparsed" }
  );
});

test("sniffCursorBubbleRow dispatches on _v, then on type, never trusting fields from an unknown version", () => {
  assert.equal(KNOWN_CURSOR_BUBBLE_VERSIONS.has(3), true);
  const user = sniffCursorBubbleRow({
    key: "bubbleId:c1:b1",
    v: 3,
    btype: 1,
    createdAt: "2026-07-21T00:00:00.000Z",
    inputTokens: 1,
    outputTokens: 2,
    humanChangesCount: 0,
    lintErrorsCount: 0,
    modelName: "default"
  });
  assert.equal(user.kind, "user");
  assert.equal(user.composerId, "c1");

  const futureVersion = sniffCursorBubbleRow({
    key: "bubbleId:c1:b2",
    v: 4,
    btype: 1,
    createdAt: "2026-07-21T00:00:00.000Z",
    inputTokens: 999,
    outputTokens: 999,
    humanChangesCount: 0,
    lintErrorsCount: 0,
    modelName: "default"
  });
  assert.deepEqual(futureVersion, { kind: "unparsed", composerId: "c1" });

  const unknownType = sniffCursorBubbleRow({
    key: "bubbleId:c1:b3",
    v: 3,
    btype: 7,
    createdAt: null,
    inputTokens: 0,
    outputTokens: 0,
    humanChangesCount: 0,
    lintErrorsCount: 0,
    modelName: null
  });
  assert.deepEqual(unknownType, { kind: "unknown", composerId: "c1" });

  const malformedKey = sniffCursorBubbleRow({
    key: "not-a-bubble-key",
    v: 3,
    btype: 1,
    createdAt: null,
    inputTokens: 0,
    outputTokens: 0,
    humanChangesCount: 0,
    lintErrorsCount: 0,
    modelName: null
  });
  assert.deepEqual(malformedKey, { kind: "unparsed", composerId: null });
});

test("extractCursor folds a composer's bubbles, excludes subagent composers from their own session, and counts drift", async () => {
  const snapshotDir = await makeFixtureStore();
  try {
    const events = [];
    for await (const e of extractCursor(snapshotDir, "test-extraction")) events.push(e);

    const prompts = events.filter((e) => e.eventKind === "ai_prompt_submitted");
    const sessions = events.filter((e) => e.eventKind === "create_focus_session");
    const afterHours = events.filter((e) => e.eventKind === "after_hours_ai_session");
    const epochs = events.filter((e) => e.eventKind === "extraction_epoch");

    // Only C1 gets a session — C2/C4 (subagents) and C3 (unrecognised
    // header type) never do.
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.sessionRef, C1);
    assert.equal(s.store, "cursor");
    assert.equal(s.provenance, "historical_derived");
    assert.equal(s.sourceVersion, "3");
    assert.equal(s.repoRef, "/Users/example/Dev/repo-a");

    // 2 of C1's own human bubbles (b1, b3) — not C2's task instruction.
    assert.equal(prompts.length, 2);
    assert.ok(prompts.every((p) => p.sessionRef === C1));
    assert.ok(prompts.every((p) => p.provenance === "historical_direct"));
    assert.ok(prompts.every((p) => p.sourceVersion === "3"));

    assert.equal(s.metrics.promptCount, 2);
    assert.equal(s.metrics.assistantTurns, 2); // b2, b4 — not b6 (unknown type)
    assert.equal(s.metrics.inputTokens, 15); // b2(10) + b4(5)
    assert.equal(s.metrics.outputTokens, 150); // b2(100) + b4(50)
    assert.equal(s.metrics.linesAdded, 42);
    assert.equal(s.metrics.linesRemoved, 7);
    assert.equal(s.metrics.filesChangedCount, 3);
    assert.equal(s.metrics.contextUsagePercent, 55.25);
    assert.equal(s.metrics.mode, "agent");
    assert.equal(s.metrics.humanChangesCount, 2); // from b4
    assert.equal(s.metrics.approximateLintErrorsCount, 1); // from b4
    assert.equal(s.metrics.unparsedBubbles, 1); // b5
    assert.equal(s.metrics.unknownBubbles, 1); // b6
    assert.equal(s.metrics.primaryModel, "claude-opus-5");
    assert.equal(s.metrics.afterHoursPrompts, 1); // b3
    assert.equal(s.metrics.sessionMinutes, 4);
    assert.equal(s.metrics.durationBucket, "1-5m");
    assert.equal(s.metrics.sessionStartedAt, new Date(CREATED_AT_MS).toISOString());

    // C2's work: one task instruction (not a prompt), one assistant turn,
    // 220 tokens — folded into C1's subagent breakdown.
    assert.equal(s.metrics.subagentComposers, 1);
    assert.equal(s.metrics.subagentPrompts, 1);
    assert.equal(s.metrics.subagentAssistantTurns, 1);
    assert.equal(s.metrics.subagentTokensTotal, 220);

    assert.equal(afterHours.length, 1);
    assert.equal(afterHours[0].metrics.afterHoursPrompts, 1);

    assert.equal(epochs.length, 1);
    assert.equal(epochs[0].metrics.sessionCount, 1);
    assert.equal(epochs[0].metrics.unknownComposerHeaderTypes, 1); // C3
    // C3's own bubble (orphanedBubbles) + C4's bubble under an unfoldable
    // parent (orphanedSubagentBubbles) + ORPHAN's bubble (orphanedBubbles).
    assert.equal(epochs[0].metrics.orphanedBubbles, 2);
    assert.equal(epochs[0].metrics.orphanedSubagentBubbles, 1);

    // No metric anywhere may carry prompt/response text.
    for (const e of events) {
      const values = Object.values(e.metrics).join(" ");
      assert.ok(!values.includes("SECRET_TEXT_MARKER"), `content leaked into metrics: ${values}`);
    }
  } finally {
    await fs.rm(snapshotDir, { recursive: true, force: true });
  }
});

test("extractCursor yields nothing for a snapshot with no staged Cursor db", async () => {
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-import-empty-"));
  try {
    const events = [];
    for await (const e of extractCursor(emptyDir, "test-extraction")) events.push(e);
    assert.deepEqual(events, []);
  } finally {
    await fs.rm(emptyDir, { recursive: true, force: true });
  }
});
