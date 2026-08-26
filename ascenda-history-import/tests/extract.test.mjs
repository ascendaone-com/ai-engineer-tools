import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractClaudeCode, isToolResultUserLine } from "../dist/extractors/claudeCode.js";
import { toWirePayload, importKeyOf } from "../dist/ship.js";

// Fixture: one project, one session, shaped like a real 2.1.x transcript —
// two human prompts (one after-hours), one tool-result user line, two
// assistant turns with usage, one queue enqueue, one attachment, one
// last-prompt, one custom-title, one meta line, one garbage line. The
// session-level assertions below are the contract-per-version test the
// research note calls for.

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001";
const V = "2.1.227";

function line(obj) {
  return JSON.stringify(obj);
}

const fixtureLines = [
  line({
    type: "user",
    timestamp: "2026-07-20T10:00:00.000Z", // daytime local (UTC+10): 20:00? no — computed below
    sessionId: SESSION,
    version: V,
    cwd: "/Users/example/Dev/repo-a",
    gitBranch: "main",
    message: { role: "user", content: "first prompt (redacted)" }
  }),
  line({
    type: "assistant",
    timestamp: "2026-07-20T10:00:30.000Z",
    sessionId: SESSION,
    version: V,
    message: {
      role: "assistant",
      model: "claude-opus-5",
      usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000 }
    }
  }),
  line({
    type: "user",
    timestamp: "2026-07-20T10:00:31.000Z",
    sessionId: SESSION,
    version: V,
    toolUseResult: { ok: true },
    message: { role: "user", content: [{ type: "tool_result", content: "output (redacted)" }] }
  }),
  line({
    type: "assistant",
    timestamp: "2026-07-20T10:00:40.000Z",
    sessionId: SESSION,
    version: V,
    message: {
      role: "assistant",
      model: "claude-opus-5",
      usage: { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 500 }
    }
  }),
  line({
    type: "user",
    timestamp: "2026-07-20T23:30:00.000Z", // 23:30 UTC is after-hours in any TZ offset that keeps it in 19:00–07:00 local — see assertion note
    sessionId: SESSION,
    version: V,
    message: { role: "user", content: "late prompt (redacted)" }
  }),
  line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-07-20T23:31:00.000Z", sessionId: SESSION }),
  // The three window-only known types (`default:` in the fold switch). They
  // contribute their timestamp to the session window and nothing else — no
  // prompt, no turn, no token. They are here because nothing else exercised
  // them: before this, a type silently dropped from KNOWN_CLAUDE_LINE_TYPES
  // would reclassify real lines as `unknownLines` with no test objecting.
  // Timestamps sit inside the existing 10:00:00–23:31:00 window on purpose,
  // so the counts and `windowOldest` asserted below still mean what they did.
  line({ type: "attachment", timestamp: "2026-07-20T10:00:35.000Z", sessionId: SESSION, version: V }),
  line({ type: "last-prompt", timestamp: "2026-07-20T23:30:30.000Z", sessionId: SESSION, version: V }),
  line({ type: "custom-title", timestamp: "2026-07-20T23:30:45.000Z", sessionId: SESSION, version: V }),
  // One recognised-and-ignored line and one genuinely new type, so the two
  // counters stay distinguishable. Before META_CLAUDE_LINE_TYPES was wired up
  // the "mode" line landed in `unknownLines`; asserting only that count would
  // now pass with the meta split broken in either direction.
  line({ type: "mode", mode: "plan" }),
  line({ type: "hologram", version: V }),
  "not json at all"
];

async function makeFixtureStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hist-import-test-"));
  const project = path.join(root, "projects", "-Users-example-Dev-repo-a");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, `${SESSION}.jsonl`), fixtureLines.join("\n") + "\n");
  return root;
}

test("isToolResultUserLine catches both markers independently", () => {
  assert.equal(isToolResultUserLine({ toolUseResult: {} }), true);
  assert.equal(
    isToolResultUserLine({ message: { content: [{ type: "tool_result" }] } }),
    true
  );
  assert.equal(isToolResultUserLine({ message: { content: "typed by a person" } }), false);
  assert.equal(
    isToolResultUserLine({ message: { content: [{ type: "text", text: "hi" }] } }),
    false
  );
});

test("extractClaudeCode folds a session correctly", async () => {
  const root = await makeFixtureStore();
  try {
    const events = [];
    for await (const e of extractClaudeCode(root, "test-extraction")) events.push(e);

    const prompts = events.filter((e) => e.eventKind === "ai_prompt_submitted");
    const sessions = events.filter((e) => e.eventKind === "create_focus_session");
    const epochs = events.filter((e) => e.eventKind === "extraction_epoch");

    // 2 human prompts — the tool-result user line must NOT be one.
    assert.equal(prompts.length, 2);
    assert.ok(prompts.every((p) => p.provenance === "historical_direct"));
    assert.ok(prompts.every((p) => p.sessionRef === SESSION));
    assert.ok(prompts.every((p) => p.repoRef === "/Users/example/Dev/repo-a"));

    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.provenance, "historical_derived");
    assert.equal(s.metrics.promptCount, 2);
    assert.equal(s.metrics.toolResultCount, 1);
    assert.equal(s.metrics.assistantTurns, 2);
    assert.equal(s.metrics.queuedPrompts, 1);
    assert.equal(s.metrics.inputTokens, 15);
    assert.equal(s.metrics.outputTokens, 150);
    assert.equal(s.metrics.cacheReadTokens, 1500);
    assert.equal(s.metrics.primaryModel, "claude-opus-5");
    assert.equal(s.metrics.gitBranch, "main");
    assert.equal(s.metrics.unknownLines, 1); // the "hologram" line, and only it
    assert.equal(s.metrics.metaLines, 1); // the "mode" line — recognised, not drift
    assert.equal(s.metrics.unparsedLines, 1); // the garbage line
    assert.equal(s.sourceVersion, V);

    assert.equal(epochs.length, 1);
    assert.equal(epochs[0].metrics.sessionCount, 1);
    assert.equal(epochs[0].metrics.windowOldest, "2026-07-20T10:00:00.000Z");

    // No metric anywhere may carry prompt text.
    for (const e of events) {
      const values = Object.values(e.metrics).join(" ");
      assert.ok(!values.includes("redacted"), `content leaked into metrics: ${values}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("wire payload hashes refs, keeps counts, and is re-run stable", async () => {
  const root = await makeFixtureStore();
  try {
    const events = [];
    for await (const e of extractClaudeCode(root, "test-extraction")) events.push(e);
    const session = events.find((e) => e.eventKind === "create_focus_session");
    const payload = toWirePayload(session, 7, "claude_code:test-install");

    assert.equal(payload.source, "claude_code");
    assert.equal(payload.eventType, "create_focus_session");
    assert.equal(payload.consentScope, "historical_import");
    assert.equal(payload.provenance, "historical_derived");
    assert.equal(payload.privacyMode, "metadata_only");
    // Raw path and branch name never on the wire — only salted 16-hex hashes.
    assert.match(payload.workspaceHash, /^[0-9a-f]{16}$/);
    assert.equal(payload.metadata.gitBranch, undefined);
    assert.match(payload.metadata.gitBranchHash, /^[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(payload).includes("/Users/example"), false);
    assert.equal(JSON.stringify(payload).includes('"main"'), false);
    // Same event + ordinal → same importKey (the future dedup anchor).
    assert.equal(importKeyOf(session, 7), payload.metadata.importKey);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Friction/correction/context signals -----------------------------------
// One session exercising every signal added to close the historical-import
// honesty audit's gaps: compaction (manual/auto/unknown-trigger), tool
// failures (is_error + api_error), context-window peak, human-corrected
// edits + lines-changed, rapid reprompts, abandoned queued prompts, model
// switches and gap-split active minutes. Timestamps are second offsets from
// T0 so the expected numbers below are hand-computable, not guessed at.

const FRICTION_SESSION = "bbbbbbbb-cccc-dddd-eeee-ffff00001111";
const T0 = Date.parse("2026-07-21T00:00:00.000Z");
const at = (offsetSeconds) => new Date(T0 + offsetSeconds * 1000).toISOString();

function usageLine(model, offsetSeconds, usage) {
  return line({
    type: "assistant",
    timestamp: at(offsetSeconds),
    sessionId: FRICTION_SESSION,
    version: V,
    message: { role: "assistant", model, usage }
  });
}

const frictionLines = [
  // t=0: first human prompt.
  line({
    type: "user",
    timestamp: at(0),
    sessionId: FRICTION_SESSION,
    version: V,
    cwd: "/Users/example/Dev/friction-proj",
    message: { role: "user", content: "prompt 1 (redacted)" }
  }),
  usageLine("claude-opus-5", 10, {
    input_tokens: 10,
    output_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 0
  }),
  // t=20: a failed tool call — the authoritative is_error marker.
  line({
    type: "user",
    timestamp: at(20),
    sessionId: FRICTION_SESSION,
    version: V,
    toolUseResult: "Error: boom",
    message: {
      role: "user",
      content: [{ type: "tool_result", is_error: true, content: "boom (redacted)", tool_use_id: "t1" }]
    }
  }),
  usageLine("claude-opus-5", 30, {
    input_tokens: 5,
    output_tokens: 50,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 0
  }),
  // t=90: second human prompt, 90s after the first — a rapid reprompt (<2m).
  line({
    type: "user",
    timestamp: at(90),
    sessionId: FRICTION_SESSION,
    version: V,
    message: { role: "user", content: "prompt 2 rapid (redacted)" }
  }),
  // Model switch #1 (opus -> sonnet) plus the context-window peak turn.
  usageLine("claude-sonnet-5", 100, {
    input_tokens: 5,
    output_tokens: 20,
    cache_read_input_tokens: 190000,
    cache_creation_input_tokens: 5000
  }),
  line({
    type: "system",
    subtype: "compact_boundary",
    timestamp: at(110),
    sessionId: FRICTION_SESSION,
    version: V,
    compactMetadata: { trigger: "manual" }
  }),
  line({
    type: "system",
    subtype: "compact_boundary",
    timestamp: at(120),
    sessionId: FRICTION_SESSION,
    version: V,
    compactMetadata: { trigger: "auto" }
  }),
  // A compaction with no readable trigger — counted, never guessed at.
  line({
    type: "system",
    subtype: "compact_boundary",
    timestamp: at(125),
    sessionId: FRICTION_SESSION,
    version: V
  }),
  line({
    type: "system",
    subtype: "api_error",
    timestamp: at(130),
    sessionId: FRICTION_SESSION,
    version: V,
    error: { message: "500", status: 500 }
  }),
  // t=140: a human-corrected edit — userModified plus a 2-line patch.
  line({
    type: "user",
    timestamp: at(140),
    sessionId: FRICTION_SESSION,
    version: V,
    toolUseResult: {
      type: "update",
      filePath: "/Users/example/Dev/friction-proj/file.ts",
      userModified: true,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [" context line", "+added line (redacted)", "-removed line (redacted)"]
        }
      ]
    },
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] }
  }),
  line({ type: "queue-operation", operation: "enqueue", timestamp: at(150), sessionId: FRICTION_SESSION }),
  // A task-notification removal — not an abandoned human prompt.
  line({
    type: "queue-operation",
    operation: "remove",
    timestamp: at(160),
    sessionId: FRICTION_SESSION,
    content: "<task-notification><task-id>x</task-id></task-notification>"
  }),
  // A real abandoned prompt — typed, then deleted before it sent.
  line({
    type: "queue-operation",
    operation: "remove",
    timestamp: at(170),
    sessionId: FRICTION_SESSION,
    content: "actually never mind (redacted)"
  }),
  // t=600: third human prompt, 430s after the last known line — past the
  // 5-minute active-gap threshold, so this gap must NOT count as active.
  line({
    type: "user",
    timestamp: at(600),
    sessionId: FRICTION_SESSION,
    version: V,
    message: { role: "user", content: "prompt 3 after a gap (redacted)" }
  }),
  // Model switch #2 (sonnet -> opus), 1s later — must count as active.
  usageLine("claude-opus-5", 601, {
    input_tokens: 2,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  })
];

async function makeFrictionStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hist-import-friction-"));
  const project = path.join(root, "projects", "-Users-example-Dev-friction-proj");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, `${FRICTION_SESSION}.jsonl`), frictionLines.join("\n") + "\n");
  return root;
}

test("extractClaudeCode surfaces compaction, failure, context-peak, edit and cadence signals", async () => {
  const root = await makeFrictionStore();
  try {
    const events = [];
    for await (const e of extractClaudeCode(root, "test-extraction")) events.push(e);

    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.ok(session, "expected a create_focus_session event");
    const m = session.metrics;

    assert.equal(m.promptCount, 3);
    assert.equal(m.assistantTurns, 4);
    assert.equal(m.inputTokens, 22);
    assert.equal(m.outputTokens, 171);
    assert.equal(m.cacheReadTokens, 191500);

    // Compaction: manual/auto split plus an unknown-trigger line that still
    // counts toward the total without being guessed into either bucket.
    assert.equal(m.compactionCount, 3);
    assert.equal(m.compactionManualCount, 1);
    assert.equal(m.compactionAutoCount, 1);

    // Failure: one is_error tool result, one api_error system line.
    assert.equal(m.toolResultErrorCount, 1);
    assert.equal(m.apiErrorCount, 1);
    assert.equal(m.toolFailureCount, 2);

    // Context peak: the sonnet turn (5 + 190000 + 5000 = 195005) against the
    // assumed 200k window.
    assert.equal(m.contextWindowPeakTokens, 195005);
    assert.equal(m.contextWindowPeakPct, 0.975);

    // Human-corrected edit + net lines changed (1 added + 1 removed).
    assert.equal(m.userModifiedEditCount, 1);
    assert.equal(m.linesChanged, 2);
    assert.equal(m.linesChangedBucket, "1-10");

    // Cadence: prompt 2 arrived 90s after prompt 1 (rapid); prompt 3 arrived
    // 510s after prompt 2 (not rapid).
    assert.equal(m.rapidRepromptCount, 1);

    // Queue: one real enqueue, one abandoned removal, one task-notification
    // removal that must NOT count as abandoned.
    assert.equal(m.queuedPrompts, 1);
    assert.equal(m.abandonedPromptCount, 1);

    // Model switch: opus -> sonnet -> opus, two transitions, two distinct
    // models, opus is the plurality primary.
    assert.equal(m.modelSwitchCount, 2);
    assert.equal(m.modelCount, 2);
    assert.equal(m.primaryModel, "claude-opus-5");

    // Active minutes: every gap is <=60s except the 430s gap before the
    // third prompt, which must be excluded — 171s of active time, not the
    // ~601s (10m) wall-clock duration.
    assert.equal(m.sessionMinutes, 10);
    assert.equal(m.activeMinutes, 3);
    assert.ok(
      m.activeMinutes < m.sessionMinutes,
      "gap-split active minutes must be well under idle-inflated wall clock"
    );

    assert.equal(typeof m.sessionStartedAt, "string");
    assert.equal(m.sessionStartedAt, at(0));

    // Aggregate canonical events, one per session (not one per occurrence).
    const manualCompaction = events.find((e) => e.eventKind === "context_compression_manual");
    const autoCompaction = events.find((e) => e.eventKind === "context_compression_auto");
    const toolFailure = events.find((e) => e.eventKind === "tool_failure");
    assert.equal(manualCompaction.metrics.compactionCount, 1);
    assert.equal(autoCompaction.metrics.compactionCount, 1);
    assert.equal(toolFailure.metrics.toolFailureCount, 2);

    // No metric anywhere may carry prompt/diff/error text.
    for (const e of events) {
      const values = Object.values(e.metrics).join(" ");
      assert.ok(!values.includes("redacted"), `content leaked into metrics: ${values}`);
      assert.ok(!values.includes("added line"), `diff text leaked into metrics: ${values}`);
      assert.ok(!values.includes("never mind"), `abandoned prompt text leaked into metrics: ${values}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Recursive subagent walk ------------------------------------------------
// Verifies the structural fix: nested `<sessionId>/**\/*.jsonl` transcripts
// are no longer silently skipped, their isSidechain user lines never inflate
// promptCount, and their failures/tokens fold into the parent session while
// staying visible via subagent* breakdown fields. Also covers the purge
// edge case — a subagent directory surviving after its top-level transcript
// evaporated — via a second, orphaned session.

const PARENT_SESSION = "cccccccc-dddd-eeee-ffff-000011112222";
const ORPHAN_SESSION = "orphan-session-with-no-top-level-file";

function sidechainLine(obj, sessionId) {
  return JSON.stringify({ isSidechain: true, sessionId, version: V, ...obj });
}

async function makeSubagentStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hist-import-subagent-"));
  const project = path.join(root, "projects", "-Users-example-Dev-subagent-proj");
  await fs.mkdir(project, { recursive: true });

  // Parent session: one human prompt, one main-thread assistant turn.
  const parentLines = [
    line({
      type: "user",
      timestamp: "2026-07-22T00:00:00.000Z",
      sessionId: PARENT_SESSION,
      version: V,
      cwd: "/Users/example/Dev/subagent-proj",
      message: { role: "user", content: "please look into this (redacted)" }
    }),
    line({
      type: "assistant",
      timestamp: "2026-07-22T00:00:05.000Z",
      sessionId: PARENT_SESSION,
      version: V,
      message: {
        role: "assistant",
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }
      }
    })
  ];
  await fs.writeFile(path.join(project, `${PARENT_SESSION}.jsonl`), parentLines.join("\n") + "\n");

  // Subagent 1, one level deep: task instruction (not a human prompt) plus
  // one failed tool call, which must merge into the parent's failure count.
  const subagentDir1 = path.join(project, PARENT_SESSION, "subagents");
  await fs.mkdir(subagentDir1, { recursive: true });
  const agent1Lines = [
    sidechainLine(
      {
        type: "user",
        timestamp: "2026-07-22T00:00:06.000Z",
        agentId: "agent-1",
        message: { role: "user", content: "investigate X (redacted)" }
      },
      PARENT_SESSION
    ),
    sidechainLine(
      {
        type: "assistant",
        timestamp: "2026-07-22T00:00:07.000Z",
        message: {
          role: "assistant",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0 }
        }
      },
      PARENT_SESSION
    ),
    sidechainLine(
      {
        type: "user",
        timestamp: "2026-07-22T00:00:08.000Z",
        toolUseResult: "Error: sub failed",
        message: {
          role: "user",
          content: [{ type: "tool_result", is_error: true, content: "sub failed (redacted)", tool_use_id: "s1" }]
        }
      },
      PARENT_SESSION
    )
  ];
  await fs.writeFile(path.join(subagentDir1, "agent-1.jsonl"), agent1Lines.join("\n") + "\n");

  // Subagent 2, nested TWO levels deep (subagents/nested/…) — the walk must
  // not be hardcoded to exactly one directory name or depth.
  const subagentDir2 = path.join(project, PARENT_SESSION, "subagents", "nested");
  await fs.mkdir(subagentDir2, { recursive: true });
  const agent2Lines = [
    sidechainLine(
      {
        type: "user",
        timestamp: "2026-07-22T00:00:09.000Z",
        agentId: "agent-2",
        message: { role: "user", content: "investigate Y (redacted)" }
      },
      PARENT_SESSION
    ),
    sidechainLine(
      {
        type: "assistant",
        timestamp: "2026-07-22T00:00:10.000Z",
        message: {
          role: "assistant",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }
        }
      },
      PARENT_SESSION
    )
  ];
  await fs.writeFile(path.join(subagentDir2, "agent-2.jsonl"), agent2Lines.join("\n") + "\n");

  // Orphan: a subagent directory with NO matching top-level transcript — the
  // purge-order edge case. Must still surface as a session, not vanish.
  const orphanSubagentDir = path.join(project, ORPHAN_SESSION, "subagents");
  await fs.mkdir(orphanSubagentDir, { recursive: true });
  const orphanLines = [
    sidechainLine(
      {
        type: "user",
        timestamp: "2026-07-23T00:00:00.000Z",
        agentId: "agent-orphan",
        message: { role: "user", content: "investigate Z (redacted)" }
      },
      ORPHAN_SESSION
    ),
    sidechainLine(
      {
        type: "assistant",
        timestamp: "2026-07-23T00:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }
        }
      },
      ORPHAN_SESSION
    )
  ];
  await fs.writeFile(path.join(orphanSubagentDir, "agent-orphan.jsonl"), orphanLines.join("\n") + "\n");

  return root;
}

test("extractClaudeCode walks nested subagent transcripts without inflating human prompt counts", async () => {
  const root = await makeSubagentStore();
  try {
    const events = [];
    for await (const e of extractClaudeCode(root, "test-extraction")) events.push(e);

    const sessions = events.filter((e) => e.eventKind === "create_focus_session");
    const parent = sessions.find((e) => e.sessionRef === PARENT_SESSION);
    const orphan = sessions.find((e) => e.sessionRef === ORPHAN_SESSION);
    assert.ok(parent, "expected the parent session to be extracted");
    assert.ok(orphan, "expected the orphaned subagent-only directory to still surface as a session");

    // Two subagent transcripts, nested at two different depths, both found.
    assert.equal(parent.metrics.subagentTranscripts, 2);
    // Two subagent task instructions — neither is a human prompt.
    assert.equal(parent.metrics.subagentPrompts, 2);
    assert.equal(parent.metrics.promptCount, 1); // only the real human prompt
    assert.equal(
      events.filter((e) => e.eventKind === "ai_prompt_submitted" && e.sessionRef === PARENT_SESSION).length,
      1
    );
    assert.equal(parent.metrics.subagentAssistantTurns, 2);
    assert.equal(parent.metrics.subagentTokensTotal, 10 + 2); // (3+7+0) + (1+1+0)

    // The subagent's failed tool call merges into the parent's failure count.
    assert.equal(parent.metrics.toolResultErrorCount, 1);
    assert.equal(parent.metrics.assistantTurns, 1); // main thread only — unaffected

    // Orphan: no top-level file, no human prompts, but not silently dropped.
    assert.equal(orphan.metrics.promptCount, 0);
    assert.equal(orphan.metrics.subagentTranscripts, 1);
    assert.equal(orphan.metrics.subagentPrompts, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
