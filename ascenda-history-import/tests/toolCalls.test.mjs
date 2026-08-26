/**
 * Tool-call counting across the three stores that can answer for it.
 *
 * Why per-tool-call EVENTS and not a session metric: the backend's demand
 * rail derives a bucket's tool-call count by counting rows whose canonical
 * type is `ai_tool_call_started` (falling back to
 * `ai_tool_call_completed`/`_failed`). It never reads a `toolCallCount` key
 * off metadata. A session-level metric would ride the wire, be stored, and
 * be counted by nothing.
 *
 * The counts still ride the session event too, because the local handoff has
 * no event stream to count — it reads the session digest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { extractCursor } from "../dist/extractors/cursor.js";
import { extractVsCode } from "../dist/extractors/vscode.js";
import {
  buildHandoff,
  buildCursorHandoff,
  buildVsCodeHandoff,
  HANDOFF_SCHEMA
} from "../dist/localHandoff.js";

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const SESSION = "0f0e0d0c-1111-2222-3333-444455556666";

/* ------------------------------------------------------------------------ *
 * Claude Code — `tool_use` content items on assistant lines
 * ------------------------------------------------------------------------ */

function ccAssistant(timestamp, toolNames, { sidechain = false } = {}) {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    sessionId: SESSION,
    version: "2.1.227",
    ...(sidechain ? { isSidechain: true, agentId: "agent-1" } : {}),
    message: {
      role: "assistant",
      model: "claude-opus-5",
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [
        { type: "text", text: "redacted" },
        ...toolNames.map((name, i) => ({
          type: "tool_use",
          id: `toolu_${timestamp}_${i}`,
          name,
          input: { path: "/Users/example/secret.txt" }
        }))
      ]
    }
  });
}

function ccUser(timestamp) {
  return JSON.stringify({
    type: "user",
    timestamp,
    sessionId: SESSION,
    version: "2.1.227",
    cwd: "/Users/example/Dev/some-repo",
    gitBranch: "main",
    message: { role: "user", content: "redacted" }
  });
}

async function makeClaudeSnapshot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-toolcalls-"));
  const projectDir = path.join(dir, "projects", "-Users-example-Dev-some-repo");
  await fs.mkdir(projectDir, { recursive: true });

  // Main thread: 1 + 2 (a parallel pair on one line) + 1 = 4 tool calls.
  const lines = [
    ccUser("2026-07-21T10:00:00.000Z"),
    ccAssistant("2026-07-21T10:00:05.000Z", ["Read"]),
    ccAssistant("2026-07-21T10:00:09.000Z", ["Bash", "Grep"]),
    // An assistant line with no tool_use at all — text only.
    ccAssistant("2026-07-21T10:00:12.000Z", []),
    ccAssistant("2026-07-21T10:00:20.000Z", ["Edit"])
  ];
  await fs.writeFile(path.join(projectDir, `${SESSION}.jsonl`), lines.join("\n") + "\n", "utf8");

  // Subagent transcript: 2 more tool calls, folded onto the same session but
  // counted separately, exactly as subagentAssistantTurns already is.
  const subDir = path.join(projectDir, SESSION, "subagents");
  await fs.mkdir(subDir, { recursive: true });
  await fs.writeFile(
    path.join(subDir, "agent-1.jsonl"),
    [
      ccAssistant("2026-07-21T10:00:14.000Z", ["Read"], { sidechain: true }),
      ccAssistant("2026-07-21T10:00:16.000Z", ["Bash"], { sidechain: true })
    ].join("\n") + "\n",
    "utf8"
  );
  return dir;
}

test("Claude Code counts tool_use items, main thread and subagents apart", async () => {
  const dir = await makeClaudeSnapshot();
  const events = await collect(extractClaudeCode(dir, "extract-1"));
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.ok(session, "expected a create_focus_session event");
  assert.equal(session.metrics.toolCallCount, 4);
  assert.equal(session.metrics.subagentToolCallCount, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("Claude Code emits one ai_tool_call_started per tool_use, at the line's own instant", async () => {
  const dir = await makeClaudeSnapshot();
  const events = await collect(extractClaudeCode(dir, "extract-1"));
  const calls = events.filter((e) => e.eventKind === "ai_tool_call_started");

  // Every call, main thread and subagent alike: the rail counts events, and
  // a subagent's Bash call is as real a demand on the machine as any other.
  assert.equal(calls.length, 6);
  assert.deepEqual(
    calls.map((e) => e.metrics.toolName).sort(),
    ["Bash", "Bash", "Edit", "Grep", "Read", "Read"]
  );

  // Read verbatim off the record that carries it — the assistant line's own
  // timestamp — so the provenance is direct, not derived.
  for (const call of calls) {
    assert.equal(call.provenance, "historical_direct");
    assert.equal(call.sessionRef, SESSION);
    assert.equal(call.repoRef, "/Users/example/Dev/some-repo");
  }
  // The parallel pair shares its line's instant; ordinals disambiguate them
  // at the wire, not here.
  const paired = calls.filter((e) => e.occurredAt === "2026-07-21T10:00:09.000Z");
  assert.equal(paired.length, 2);

  await fs.rm(dir, { recursive: true, force: true });
});

test("Claude Code's handoff carries the session's tool-call counts", async () => {
  const dir = await makeClaudeSnapshot();
  const events = await collect(extractClaudeCode(dir, "extract-1"));
  const handoff = buildHandoff(events, "extract-1", "2026-07-22T00:00:00.000Z");
  assert.equal(handoff.schema, HANDOFF_SCHEMA);
  assert.ok(HANDOFF_SCHEMA >= 3, "tool-call counts are a schema-3 addition");
  assert.equal(handoff.sessions.length, 1);
  assert.equal(handoff.sessions[0].toolCallCount, 4);
  assert.equal(handoff.sessions[0].subagentToolCallCount, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------ *
 * Cursor — `toolFormerData` on bubbles
 * ------------------------------------------------------------------------ */

const CC1 = "11111111-1111-1111-1111-111111111111";
const CUR_CREATED_MS = Date.UTC(2026, 6, 20, 10, 0, 0);
const CUR_UPDATED_MS = CUR_CREATED_MS + 4 * 60_000;

function sqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function makeCursorSnapshot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-toolcalls-"));
  const bubble = (bubbleId, value) =>
    `INSERT INTO cursorDiskKV (key, value) VALUES (${sqlString(
      `bubbleId:${CC1}:${bubbleId}`
    )}, ${sqlString(JSON.stringify(value))});`;

  const base = {
    _v: 3,
    type: 2,
    tokenCount: { inputTokens: 1, outputTokens: 1 },
    humanChanges: [],
    approximateLintErrors: [],
    modelInfo: { modelName: "claude-opus-5" }
  };
  const at = (h, m) => new Date(Date.UTC(2026, 6, 20, h, m, 0)).toISOString();

  const statements = [
    "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT);",
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, value) VALUES (${sqlString(
      CC1
    )}, 'workspace-1', ${CUR_CREATED_MS}, ${CUR_UPDATED_MS}, 0, ${sqlString(
      JSON.stringify({
        type: "head",
        composerId: CC1,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        filesChangedCount: 0,
        contextUsagePercent: 0,
        unifiedMode: "agent",
        workspaceIdentifier: { uri: { fsPath: "/Users/example/Dev/repo-a" } }
      })
    )});`,
    // A human prompt, so the composer is a session at all.
    bubble("b0", { ...base, type: 1, createdAt: at(10, 0) }),
    // tool-1: recorded twice — Cursor rewrites a bubble as the call moves
    // from loading to completed, and both copies keep the same toolCallId.
    bubble("b1", {
      ...base,
      createdAt: at(10, 1),
      toolFormerData: { toolCallId: "tool-1", name: "read_file_v2", status: "loading", toolIndex: 0 }
    }),
    bubble("b2", {
      ...base,
      createdAt: at(10, 2),
      toolFormerData: { toolCallId: "tool-1", name: "read_file_v2", status: "completed", toolIndex: 0 }
    }),
    // tool-2: a second, genuinely distinct call.
    bubble("b3", {
      ...base,
      createdAt: at(10, 3),
      toolFormerData: { toolCallId: "tool-2", name: "run_terminal_command_v2", status: "error", toolIndex: 1 }
    }),
    // tool-3: every copy undated. Real on a working store — as
    // carry `createdAt: ""` — and undatable, so it counts but cannot be
    // placed on an hourly rail.
    bubble("b4", {
      ...base,
      createdAt: "",
      toolFormerData: { toolCallId: "tool-3", name: "edit_file_v2", status: "completed", toolIndex: 2 }
    })
  ];

  const sqlPath = path.join(dir, "fixture.sql");
  await fs.writeFile(sqlPath, statements.join("\n"), "utf8");
  execFileSync("/usr/bin/sqlite3", [path.join(dir, "state.vscdb"), `.read ${sqlPath}`]);
  await fs.rm(sqlPath);
  return dir;
}

test("Cursor counts a tool call once however many bubbles record it", async () => {
  const dir = await makeCursorSnapshot();
  const events = await collect(extractCursor(dir, "extract-1"));
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.ok(session, "expected a create_focus_session event");
  // Three distinct toolCallIds across four tool bubbles.
  assert.equal(session.metrics.toolCallCount, 3);
  // The one nothing could date, reported rather than quietly dropped.
  assert.equal(session.metrics.toolCallsUndated, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("Cursor emits an event only for a tool call it can place in time", async () => {
  const dir = await makeCursorSnapshot();
  const events = await collect(extractCursor(dir, "extract-1"));
  const calls = events.filter((e) => e.eventKind === "ai_tool_call_started");
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((e) => e.metrics.toolName).sort(),
    ["read_file_v2", "run_terminal_command_v2"]
  );
  // The earliest bubble that recorded the call — a call starts once, and the
  // rewrite at 10:02 is the same call reaching a later state.
  const read = calls.find((e) => e.metrics.toolName === "read_file_v2");
  assert.equal(read.occurredAt, new Date(Date.UTC(2026, 6, 20, 10, 1, 0)).toISOString());
  assert.equal(read.provenance, "historical_direct");
  await fs.rm(dir, { recursive: true, force: true });
});

test("Cursor's handoff carries the session's tool-call count", async () => {
  const dir = await makeCursorSnapshot();
  const events = await collect(extractCursor(dir, "extract-1"));
  const handoff = buildCursorHandoff(events, "extract-1", "2026-07-22T00:00:00.000Z");
  assert.equal(handoff.sessions.length, 1);
  assert.equal(handoff.sessions[0].toolCallCount, 3);
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------ *
 * VS Code — `toolInvocationSerialized` response parts on Copilot requests
 * ------------------------------------------------------------------------ */

const VS_SESSION = "a9f90631-f436-44ef-9283-5b3dc3831ff0";
const VS_T1 = Date.UTC(2026, 0, 14, 11, 0, 0);
const VS_T2 = Date.UTC(2026, 0, 14, 11, 30, 0);

async function makeVsCodeSnapshot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-toolcalls-"));
  const wsDir = path.join(dir, "workspaceStorage", "ws-hash-1");
  await fs.mkdir(path.join(wsDir, "chatSessions"), { recursive: true });
  await fs.writeFile(
    path.join(wsDir, "workspace.json"),
    JSON.stringify({ folder: "file:///Users/example/Dev/repo-b" }),
    "utf8"
  );

  const toolPart = (toolId, toolCallId) => ({
    kind: "toolInvocationSerialized",
    toolId,
    toolCallId,
    isComplete: true,
    invocationMessage: { value: "Reading [](file:///Users/example/secret.txt)" }
  });

  await fs.writeFile(
    path.join(wsDir, "chatSessions", `${VS_SESSION}.json`),
    JSON.stringify({
      version: 3,
      sessionId: VS_SESSION,
      requests: [
        {
          requestId: "r1",
          timestamp: VS_T1,
          modelId: "gpt-5",
          message: { text: "redacted" },
          response: [
            { value: "redacted" },
            // `prepareToolInvocation` announces a call the model is about to
            // make; counting it too would double every invocation.
            { kind: "prepareToolInvocation", toolName: "copilot_readFile" },
            toolPart("copilot_readFile", "tc-1"),
            toolPart("run_in_terminal", "tc-2"),
            // The same call again inside the same request. Real, and the
            // dominant case: a `.jsonl` session is a delta log whose splices
            // append the streaming turn's parts repeatedly, so well over a
            // third of invocations in such a session repeat an id already
            // present in their own request.
            toolPart("copilot_readFile", "tc-1")
          ]
        },
        {
          requestId: "r2",
          timestamp: VS_T2,
          modelId: "gpt-5",
          message: { text: "redacted" },
          response: [
            toolPart("copilot_replaceString", "tc-3"),
            // The rarer cross-request repeat — a turn resumed minutes later,
            // carrying its earlier calls with it.
            toolPart("run_in_terminal", "tc-2")
          ]
        }
      ]
    }),
    "utf8"
  );
  return dir;
}

test("VS Code counts a tool call once, ignoring prepare announcements and repeats", async () => {
  const dir = await makeVsCodeSnapshot();
  const events = await collect(extractVsCode(dir, "extract-1"));
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.ok(session, "expected a create_focus_session event");
  // Five serialized parts, three distinct toolCallIds.
  assert.equal(session.metrics.toolCallCount, 3);
  await fs.rm(dir, { recursive: true, force: true });
});

test("VS Code places a tool call at its earliest request's instant, and says so", async () => {
  const dir = await makeVsCodeSnapshot();
  const events = await collect(extractVsCode(dir, "extract-1"));
  const calls = events.filter((e) => e.eventKind === "ai_tool_call_started");
  assert.equal(calls.length, 3);
  // tc-2 appears in both requests; a call starts once, so it belongs to the
  // first request that carried it, not the last.
  assert.deepEqual(
    calls.map((e) => e.occurredAt),
    [new Date(VS_T1).toISOString(), new Date(VS_T1).toISOString(), new Date(VS_T2).toISOString()]
  );
  assert.deepEqual(calls.map((e) => e.metrics.toolName), [
    "copilot_readFile",
    "run_in_terminal",
    "copilot_replaceString"
  ]);
  // A serialized invocation carries no instant of its own; the enclosing
  // request's is the nearest honest one, and borrowing it is a derivation.
  for (const call of calls) assert.equal(call.provenance, "historical_derived");
  await fs.rm(dir, { recursive: true, force: true });
});

test("VS Code's handoff carries the chat session's tool-call count", async () => {
  const dir = await makeVsCodeSnapshot();
  const events = await collect(extractVsCode(dir, "extract-1"));
  const handoff = buildVsCodeHandoff(events, "extract-1", "2026-01-15T00:00:00.000Z");
  assert.equal(handoff.chatSessions.length, 1);
  assert.equal(handoff.chatSessions[0].toolCallCount, 3);
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------ *
 * The wire the rail actually reads
 * ------------------------------------------------------------------------ */

test("a store big enough to be worth importing survives the run that imports it", async () => {
  // Counting tool calls one event apiece takes a working Claude Code store
  // past six figures of events, and `allEvents.push(...events)` — one
  // argument per element — overflowed the call stack at that size. It failed
  // AFTER the extraction finished and the per-source summary had printed, so
  // the whole run's work was lost with a message ("Maximum call stack size
  // exceeded") that named nothing leading back here.
  //
  // 200,000 is chosen to clear the threshold on any mainstream V8 rather than
  // to sit near it: the exact limit is a function of stack depth and varies
  // by engine build and platform, and a test pinned to the boundary would
  // pass or fail for reasons that have nothing to do with this code.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "asc-bigstore-"));
  const proj = path.join(home, ".claude", "projects", "-Users-x-proj");
  await fs.mkdir(proj, { recursive: true });

  const lines = [ccUser("2026-08-01T10:00:00.000Z")];
  const start = Date.UTC(2026, 7, 1, 10, 0, 0);
  for (let i = 0; i < 100_000; i++) {
    lines.push(ccAssistant(new Date(start + i * 1000).toISOString(), ["Bash", "Read"]));
  }
  await fs.writeFile(path.join(proj, "s1.jsonl"), lines.join("\n") + "\n", "utf8");

  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const { execFile } = await import("node:child_process");
  const run = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, "import"],
      { env: { ...process.env, HOME: home }, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
    );
  });

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(run.stderr, /Maximum call stack/);
  assert.match(run.stdout, /claude_code\s+200,00\d extracted/);

  // Extracted is not the same as staged. The crash was between the two.
  const stagingRoot = path.join(home, ".ascenda", "history-import", "staging");
  const runs = await fs.readdir(stagingRoot);
  assert.equal(runs.length, 1);
  const staged = await fs.readFile(path.join(stagingRoot, runs[0], "events.jsonl"), "utf8");
  const calls = staged
    .split("\n")
    .filter(Boolean)
    .filter((line) => JSON.parse(line).eventKind === "ai_tool_call_started");
  assert.equal(calls.length, 200_000);

  await fs.rm(home, { recursive: true, force: true });
});

test("tool-call events ship as ai_tool_call_started — the type the demand rail counts", async () => {
  const dir = await makeClaudeSnapshot();
  const events = await collect(extractClaudeCode(dir, "extract-1"));
  const { shippableEvents, toWirePayload, importOrdinals } = await import("../dist/ship.js");
  const shippable = shippableEvents(events);
  const calls = shippable.filter((e) => e.eventKind === "ai_tool_call_started");
  assert.equal(calls.length, 6, "tool-call events must survive the shipper's filter");

  const ordinals = importOrdinals(shippable);
  const payloads = shippable.map((e, i) => toWirePayload(e, ordinals[i], "claude_code:test"));
  const callPayloads = payloads.filter((p) => p.eventType === "ai_tool_call_started");
  assert.equal(callPayloads.length, 6);
  assert.ok(callPayloads.every((p) => typeof p.metadata.toolName === "string"));
  // Two calls share an instant; their import keys must still differ or the
  // backend dedups a real record away.
  const keys = new Set(callPayloads.map((p) => p.metadata.importKey));
  assert.equal(keys.size, 6);
  await fs.rm(dir, { recursive: true, force: true });
});
