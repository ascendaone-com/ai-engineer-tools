import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  extractClaudeCode,
  isHeadlessEntrypoint,
  probeTopLevelTranscript,
  readMessageUsage
} from "../dist/extractors/claudeCode.js";
import { extractCodex } from "../dist/extractors/codex.js";
import { extractCursor } from "../dist/extractors/cursor.js";
import { extractVsCode } from "../dist/extractors/vscode.js";
import { resolveStorePaths } from "../dist/stores.js";
import { scanVsCode } from "../dist/scan.js";
import { defaultArchiveSources } from "../dist/archive.js";
import { toWirePayload } from "../dist/ship.js";

// Synthetic fixtures for the stores' older and less common shapes: flat
// subagent transcripts, SDK-written prompts, cache-write and advisor tokens,
// Cursor sessions whose header date is far from their messages, stores that
// recorded no tokens, and VS Code chats with no folder open.

const J = (obj) => JSON.stringify(obj);
const collect = async (iterable) => {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
};

/* ------------------------------------------------------------------------ *
 * Claude Code
 * ------------------------------------------------------------------------ */

const S1 = "11111111-aaaa-bbbb-cccc-000000000001";
const S2 = "11111111-aaaa-bbbb-cccc-000000000002";
const V = "2.0.30";

async function claudeStore(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-gaps-"));
  const project = path.join(root, "projects", "-Users-example-Dev-repo-a");
  await fs.mkdir(project, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    const file = path.join(project, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, lines.map(J).join("\n") + "\n");
  }
  return root;
}

const typed = (sessionId, uuid, timestamp, extra = {}) => ({
  type: "user",
  uuid,
  timestamp,
  sessionId,
  version: V,
  cwd: "/Users/example/Dev/repo-a",
  message: { role: "user", content: "a typed prompt (redacted)" },
  ...extra
});

const reply = (sessionId, uuid, timestamp, message, extra = {}) => ({
  type: "assistant",
  uuid,
  timestamp,
  sessionId,
  version: V,
  message: { role: "assistant", model: "claude-opus-5", ...message },
  ...extra
});

test("a flat agent-*.jsonl folds into its parent session instead of becoming one", async () => {
  const root = await claudeStore({
    [`${S1}.jsonl`]: [
      typed(S1, "u1", "2026-07-20T10:00:00.000Z"),
      reply(S1, "a1", "2026-07-20T10:00:05.000Z", { id: "m1", usage: { input_tokens: 5, output_tokens: 5 } })
    ],
    // Marks itself with isSidechain and agentId, as older runtimes did.
    "agent-1a2b3c4d.jsonl": [
      typed(S1, "s1", "2026-07-20T10:00:10.000Z", { isSidechain: true, agentId: "1a2b3c4d" }),
      reply(
        S1,
        "s2",
        "2026-07-20T10:00:12.000Z",
        { id: "m2", usage: { input_tokens: 3, output_tokens: 7, cache_creation_input_tokens: 4 } },
        { isSidechain: true, agentId: "1a2b3c4d" }
      )
    ],
    // Only the agentId, and a name that doesn't start with agent-.
    "worker-9.jsonl": [
      typed(S1, "w1", "2026-07-20T10:00:20.000Z", { agentId: "9" }),
      reply(S1, "w2", "2026-07-20T10:00:21.000Z", { id: "m3", usage: { input_tokens: 1, output_tokens: 1 } }, { agentId: "9" })
    ]
  });
  try {
    const events = await collect(extractClaudeCode(root, "x1"));
    const sessions = events.filter((e) => e.eventKind === "create_focus_session");
    assert.deepEqual(sessions.map((s) => s.sessionRef), [S1]);
    const m = sessions[0].metrics;
    assert.equal(m.promptCount, 1, "the orchestrator's task text is not a prompt");
    assert.equal(m.subagentTranscripts, 2);
    assert.equal(m.subagentPrompts, 2);
    assert.equal(m.subagentAssistantTurns, 2);
    assert.equal(m.subagentTokensTotal, 3 + 7 + 4 + 1 + 1);
    assert.equal(m.assistantTurns, 1, "the main thread is untouched");
    assert.equal(
      events.filter((e) => e.eventKind === "ai_prompt_submitted").length,
      1
    );
    assert.ok(!events.some((e) => String(e.sessionRef ?? "").startsWith("agent-")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a flat subagent file whose parent transcript is gone still folds into the parent's id", async () => {
  const root = await claudeStore({
    "agent-orphan.jsonl": [
      typed(S2, "o1", "2026-07-21T10:00:00.000Z", { isSidechain: true, agentId: "orphan" }),
      reply(S2, "o2", "2026-07-21T10:00:01.000Z", { id: "m1", usage: { input_tokens: 2, output_tokens: 2 } }, { isSidechain: true, agentId: "orphan" })
    ]
  });
  try {
    const events = await collect(extractClaudeCode(root, "x1"));
    const sessions = events.filter((e) => e.eventKind === "create_focus_session");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionRef, S2);
    assert.equal(sessions[0].metrics.promptCount, 0);
    assert.equal(sessions[0].metrics.subagentTranscripts, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a flat subagent file that names no parent is counted, not made into a session", async () => {
  const root = await claudeStore({
    "agent-lost.jsonl": [
      { type: "user", uuid: "l1", timestamp: "2026-07-21T10:00:00.000Z", isSidechain: true, agentId: "lost", message: { role: "user", content: "x" } }
    ]
  });
  try {
    const events = await collect(extractClaudeCode(root, "x1"));
    assert.equal(events.filter((e) => e.eventKind === "create_focus_session").length, 0);
    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.equal(epoch.metrics.unattributedSubagentTranscripts, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a main-thread transcript is not mistaken for a sidechain", async () => {
  const root = await claudeStore({ [`${S1}.jsonl`]: [typed(S1, "u1", "2026-07-20T10:00:00.000Z")] });
  try {
    const probe = await probeTopLevelTranscript(path.join(root, "projects", "-Users-example-Dev-repo-a", `${S1}.jsonl`));
    assert.deepEqual(probe, { sidechain: false, parentSessionId: null });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("prompts written by the Agent SDK are counted apart from typed ones", async () => {
  const root = await claudeStore({
    [`${S1}.jsonl`]: [
      typed(S1, "u1", "2026-07-20T10:00:00.000Z", { entrypoint: "sdk-ts", userType: "external" }),
      reply(S1, "a1", "2026-07-20T10:00:05.000Z", { id: "m1", usage: { input_tokens: 1, output_tokens: 1 } }),
      typed(S1, "u2", "2026-07-20T10:01:00.000Z", { entrypoint: "sdk-cli", userType: "external" }),
      reply(S1, "a2", "2026-07-20T10:01:05.000Z", { id: "m2", usage: { input_tokens: 1, output_tokens: 1 } })
    ],
    [`${S2}.jsonl`]: [
      // An ordinary terminal session is also userType external.
      typed(S2, "t1", "2026-07-20T11:00:00.000Z", { entrypoint: "cli", userType: "external" }),
      reply(S2, "t2", "2026-07-20T11:00:05.000Z", { id: "m3", usage: { input_tokens: 1, output_tokens: 1 } })
    ]
  });
  try {
    const events = await collect(extractClaudeCode(root, "x1"));
    const byRef = Object.fromEntries(
      events.filter((e) => e.eventKind === "create_focus_session").map((e) => [e.sessionRef, e.metrics])
    );
    assert.equal(byRef[S1].promptCount, 0);
    assert.equal(byRef[S1].headlessPromptLines, 2);
    assert.equal(byRef[S2].promptCount, 1);
    assert.equal(byRef[S2].headlessPromptLines, 0);
    assert.deepEqual(
      events.filter((e) => e.eventKind === "ai_prompt_submitted").map((e) => e.sessionRef),
      [S2]
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isHeadlessEntrypoint reads the entrypoint, not userType", () => {
  assert.equal(isHeadlessEntrypoint({ entrypoint: "sdk-ts" }), true);
  assert.equal(isHeadlessEntrypoint({ entrypoint: "sdk-py" }), true);
  assert.equal(isHeadlessEntrypoint({ entrypoint: "cli" }), false);
  assert.equal(isHeadlessEntrypoint({ userType: "external" }), false);
  assert.equal(isHeadlessEntrypoint({ entrypoint: 7 }), false);
});

test("cache writes, their 5m/1h split and advisor calls reach the totals once per message", async () => {
  const usage = {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
    iterations: [
      { type: "message", input_tokens: 10, output_tokens: 20 },
      {
        type: "advisor_message",
        model: "claude-opus-advisor",
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1
      },
      // A null model and a missing token field must not throw or invent a model.
      { type: "advisor_message", model: null, input_tokens: 1, output_tokens: 1 },
      null,
      5,
      { type: "compaction", input_tokens: 999 }
    ]
  };
  const root = await claudeStore({
    [`${S1}.jsonl`]: [
      typed(S1, "u1", "2026-07-20T10:00:00.000Z"),
      reply(S1, "a1", "2026-07-20T10:00:05.000Z", { id: "m1", usage }),
      // The same message again, as the runtime writes it once per content block.
      reply(S1, "a2", "2026-07-20T10:00:06.000Z", { id: "m1", usage })
    ],
    // An older transcript: no cache-write figure at all.
    [`${S2}.jsonl`]: [
      typed(S2, "t1", "2026-07-20T11:00:00.000Z"),
      reply(S2, "t2", "2026-07-20T11:00:05.000Z", { id: "m9", usage: { input_tokens: 4, output_tokens: 4 } })
    ]
  });
  try {
    const events = await collect(extractClaudeCode(root, "x1"));
    const byRef = Object.fromEntries(
      events.filter((e) => e.eventKind === "create_focus_session").map((e) => [e.sessionRef, e.metrics])
    );
    const m = byRef[S1];
    assert.equal(m.inputTokens, 10 + 7 + 1);
    assert.equal(m.outputTokens, 20 + 3 + 1);
    assert.equal(m.cacheReadTokens, 30 + 2);
    assert.equal(m.cacheCreationTokens, 100 + 1);
    assert.equal(m.cacheCreation5mTokens, 60);
    assert.equal(m.cacheCreation1hTokens, 40);
    assert.equal(m.advisorMessageCount, 2);
    assert.equal(m.advisorTokensTotal, 7 + 3 + 2 + 1 + 1 + 1);
    // The main model plus the one named advisor model. The null-model advisor
    // adds no model, and the advisor is not a model switch.
    assert.equal(m.modelCount, 2);
    assert.equal(m.modelSwitchCount, 0);
    assert.equal(m.primaryModel, "claude-opus-5");
    assert.equal(m.assistantTurns, 1);

    const older = byRef[S2];
    assert.equal("cacheCreationTokens" in older, false, "never written is not zero written");
    assert.equal("cacheCreation5mTokens" in older, false);
    assert.equal("advisorMessageCount" in older, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cache writes follow the per-message key: one request counted once, a reused id with another request counted again", async () => {
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 10 };
  const root = await claudeStore({
    [`${S1}.jsonl`]: [
      typed(S1, "u1", "2026-07-20T10:00:00.000Z"),
      reply(S1, "a1", "2026-07-20T10:00:05.000Z", { id: "placeholder", usage }, { requestId: "req-1" }),
      reply(S1, "a2", "2026-07-20T10:00:06.000Z", { id: "placeholder", usage }, { requestId: "req-1" }),
      reply(S1, "a3", "2026-07-20T10:00:07.000Z", { id: "placeholder", usage }, { requestId: "req-2" })
    ]
  });
  try {
    const events = await collect(extractClaudeCode(root, "x1"));
    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.equal(session.metrics.cacheCreationTokens, 20);
    assert.equal(session.metrics.assistantTurns, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("subagent cache writes count toward the subagent token total", async () => {
  const root = await claudeStore({
    [`${S1}.jsonl`]: [typed(S1, "u1", "2026-07-20T10:00:00.000Z")],
    "agent-x.jsonl": [
      reply(
        S1,
        "s1",
        "2026-07-20T10:00:10.000Z",
        { id: "m1", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
        { isSidechain: true, agentId: "x" }
      )
    ]
  });
  try {
    const events = await collect(extractClaudeCode(root, "x1"));
    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.equal(session.metrics.subagentTokensTotal, 1 + 2 + 3 + 4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readMessageUsage reads a malformed usage block without throwing", () => {
  for (const usage of [undefined, {}, { iterations: "nope" }, { cache_creation: [] }, { iterations: [{ type: "advisor_message" }] }]) {
    const read = readMessageUsage(usage);
    assert.equal(read.usage.input, 0);
  }
  assert.equal(readMessageUsage({ iterations: [{ type: "advisor_message" }] }).usage.advisor.count, 1);
});

/* ------------------------------------------------------------------------ *
 * Cursor
 * ------------------------------------------------------------------------ */

const sql = (value) => `'${value.replace(/'/g, "''")}'`;

function cursorHeader(composerId, createdAtMs, lastUpdatedAtMs) {
  return `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, value) VALUES (${sql(
    composerId
  )}, 'w1', ${createdAtMs}, ${lastUpdatedAtMs}, 0, ${sql(J({ type: "head", composerId, createdAt: createdAtMs }))});`;
}

function cursorBubble(composerId, bubbleId, type, createdAt, tokenCount) {
  return `INSERT INTO cursorDiskKV (key, value) VALUES (${sql(`bubbleId:${composerId}:${bubbleId}`)}, ${sql(
    J({ _v: 3, type, createdAt, tokenCount, modelInfo: { modelName: "m" } })
  )});`;
}

async function cursorStore(statements) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-gaps-"));
  execFileSync("/usr/bin/sqlite3", [path.join(dir, "state.vscdb")], {
    input: [
      "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT);",
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
      ...statements
    ].join("\n")
  });
  return dir;
}

test("a Cursor session starts at its earliest message, not at a header date months earlier", async () => {
  const id = "cccccccc-0000-0000-0000-000000000001";
  const created = Date.UTC(2026, 3, 1, 9, 0, 0);
  const first = Date.UTC(2026, 6, 20, 10, 0, 0);
  const last = Date.UTC(2026, 6, 20, 10, 30, 0);
  const dir = await cursorStore([
    cursorHeader(id, created, last),
    cursorBubble(id, "b2", 2, new Date(first + 60_000).toISOString(), { inputTokens: 5, outputTokens: 5 }),
    cursorBubble(id, "b1", 1, new Date(first).toISOString(), { inputTokens: 0, outputTokens: 0 })
  ]);
  try {
    const events = await collect(extractCursor(dir, "x1"));
    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.equal(session.metrics.sessionStartedAt, new Date(first).toISOString());
    assert.equal(session.metrics.sessionMinutes, 30, "not the ~110 days the header implies");
    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.equal(epoch.metrics.windowOldest, new Date(first).toISOString());
    assert.equal(epoch.metrics.sessionsStartedFromBubble, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a Cursor header with no createdAt is dated by its messages", async () => {
  const id = "cccccccc-0000-0000-0000-000000000002";
  const first = Date.UTC(2026, 6, 20, 10, 0, 0);
  const dir = await cursorStore([
    `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, value) VALUES (${sql(
      id
    )}, 'w1', NULL, ${first + 120_000}, 0, ${sql(J({ type: "head", composerId: id }))});`,
    cursorBubble(id, "b1", 1, new Date(first).toISOString(), { inputTokens: 1, outputTokens: 1 })
  ]);
  try {
    const events = await collect(extractCursor(dir, "x1"));
    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.ok(session, "dated from the bubble instead of dropped");
    assert.equal(session.metrics.sessionStartedAt, new Date(first).toISOString());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Cursor tokenCount of {0, 0} everywhere ships as not collected, not as zero", async () => {
  const id = "cccccccc-0000-0000-0000-000000000003";
  const t0 = Date.UTC(2026, 6, 20, 10, 0, 0);
  const dir = await cursorStore([
    cursorHeader(id, t0, t0 + 60_000),
    cursorBubble(id, "b1", 1, new Date(t0).toISOString(), { inputTokens: 0, outputTokens: 0 }),
    cursorBubble(id, "b2", 2, new Date(t0 + 1000).toISOString(), { inputTokens: 0, outputTokens: 0 })
  ]);
  try {
    const events = await collect(extractCursor(dir, "x1"));
    const session = events.find((e) => e.eventKind === "create_focus_session");
    for (const key of ["inputTokens", "outputTokens", "subagentTokensTotal"]) {
      assert.equal(key in session.metrics, false, `${key} is absent`);
    }
    assert.equal(session.metrics.tokensNotCollected, true);
    const wire = toWirePayload(session, 0, "cursor_mcp:test-install");
    assert.equal(wire.metadata.inputTokens, undefined);
    assert.equal(wire.metadata.tokensNotCollected, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a Cursor session with any nonzero token figure keeps its sums", async () => {
  const id = "cccccccc-0000-0000-0000-000000000004";
  const t0 = Date.UTC(2026, 6, 20, 10, 0, 0);
  const dir = await cursorStore([
    cursorHeader(id, t0, t0 + 60_000),
    cursorBubble(id, "b1", 1, new Date(t0).toISOString(), { inputTokens: 0, outputTokens: 0 }),
    cursorBubble(id, "b2", 2, new Date(t0 + 1000).toISOString(), { inputTokens: 12, outputTokens: 34 })
  ]);
  try {
    const events = await collect(extractCursor(dir, "x1"));
    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.equal(session.metrics.inputTokens, 12);
    assert.equal(session.metrics.outputTokens, 34);
    assert.equal("tokensNotCollected" in session.metrics, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------ *
 * Codex
 * ------------------------------------------------------------------------ */

const codexLine = (timestamp, type, payload) => J({ timestamp, type, payload });

async function codexStore(lines) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-gaps-"));
  const dir = path.join(root, "sessions", "2026", "07", "20");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "rollout-2026-07-20T10-00-00-00000000-0000-0000-0000-000000000009.jsonl"),
    lines.join("\n") + "\n"
  );
  return root;
}

const codexBase = [
  codexLine("2026-07-20T10:00:00.000Z", "session_meta", {
    id: "00000000-0000-0000-0000-000000000009",
    cwd: "/Users/example/Dev/repo-a",
    cli_version: "0.30.0"
  }),
  codexLine("2026-07-20T10:00:01.000Z", "event_msg", { type: "user_message", message: "redacted", images: [] }),
  codexLine("2026-07-20T10:00:02.000Z", "turn_context", { turn_id: "t1", model: "gpt-5" })
];

test("a Codex rollout from before token_count events has no token keys, and says why", async () => {
  const root = await codexStore(codexBase);
  try {
    const events = await collect(extractCodex(root, "x1"));
    const session = events.find((e) => e.eventKind === "create_focus_session");
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens"]) {
      assert.equal(key in session.metrics, false, `${key} is absent`);
    }
    assert.equal(session.metrics.tokensNotCollected, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a Codex rollout with token_count events keeps its totals, including a true zero", async () => {
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  const root = await codexStore([
    ...codexBase,
    codexLine("2026-07-20T10:00:03.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: total, model_context_window: 1000 }
    })
  ]);
  try {
    const events = await collect(extractCodex(root, "x1"));
    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.equal(session.metrics.inputTokens, 0);
    assert.equal("tokensNotCollected" in session.metrics, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------ *
 * VS Code
 * ------------------------------------------------------------------------ */

const REPO = "/Users/example/Dev/repo-a";
const AT = Date.UTC(2026, 6, 20, 10, 0, 0);
const chatSession = (sessionId, timestamp) => ({
  version: 3,
  sessionId,
  requests: [{ timestamp, modelId: "copilot/auto", message: {}, response: [] }]
});

async function vscodeInstall(root, name) {
  const user = path.join(root, name, "User");
  const dirs = {
    historyDir: path.join(user, "History"),
    workspaceStorageDir: path.join(user, "workspaceStorage"),
    empty: path.join(user, "globalStorage", "emptyWindowChatSessions"),
    transferred: path.join(user, "globalStorage", "transferredChatSessions")
  };
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true });
  return dirs;
}

async function writeWorkspace(dirs, hash, sessionId, timestamp) {
  const ws = path.join(dirs.workspaceStorageDir, hash);
  await fs.mkdir(path.join(ws, "chatSessions"), { recursive: true });
  await fs.writeFile(path.join(ws, "workspace.json"), J({ folder: pathToFileURL(REPO).toString() }));
  await fs.writeFile(path.join(ws, "chatSessions", `${sessionId}.json`), J(chatSession(sessionId, timestamp)));
}

test("chats with no folder open, and other VS Code installs, are read alongside Code's workspaces", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-gaps-"));
  try {
    const code = await vscodeInstall(root, "Code");
    const insiders = await vscodeInstall(root, "Code - Insiders");

    await writeWorkspace(code, "h1", "in-workspace", AT);
    await fs.writeFile(path.join(code.empty, "empty-1.json"), J(chatSession("empty-1", AT + 60_000)));
    // JSONL delta log: a header record is the whole session.
    await fs.writeFile(
      path.join(code.transferred, "moved-1.jsonl"),
      J({ kind: 0, v: chatSession("moved-1", AT + 120_000) }) + "\n"
    );
    // The same session as the workspace one, transferred: counted once.
    await fs.writeFile(path.join(code.transferred, "dup.json"), J(chatSession("in-workspace", AT)));
    await writeWorkspace(insiders, "h2", "insiders-1", AT + 180_000);
    await fs.writeFile(path.join(insiders.empty, "ins-empty.json"), J(chatSession("ins-empty", AT + 240_000)));

    const roots = [code, insiders].map((d) => ({
      historyDir: d.historyDir,
      workspaceStorageDir: d.workspaceStorageDir,
      looseChatDirs: [d.empty, d.transferred]
    }));
    const events = await collect(extractVsCode(roots, "x1"));
    const sessions = events.filter((e) => e.eventKind === "create_focus_session");
    const byRef = Object.fromEntries(sessions.map((s) => [s.sessionRef, s]));

    assert.deepEqual(Object.keys(byRef).sort(), ["empty-1", "in-workspace", "ins-empty", "insiders-1", "moved-1"]);
    assert.equal(byRef["in-workspace"].repoRef, REPO, "the copy that knows its folder wins");
    assert.equal(byRef["empty-1"].repoRef, null, "no folder open");
    assert.equal(byRef["moved-1"].repoRef, null);
    assert.equal(byRef["insiders-1"].repoRef, REPO);
    assert.equal(events.filter((e) => e.eventKind === "ai_prompt_submitted").length, 5);

    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.equal(epoch.metrics.sessionCount, 5);
    assert.equal(epoch.metrics.duplicateChatSessions, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a staging root with the loose chat directories beside history is read too", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-gaps-staged-"));
  try {
    await fs.mkdir(path.join(root, "history"), { recursive: true });
    await fs.mkdir(path.join(root, "emptyWindowChatSessions"), { recursive: true });
    await fs.writeFile(path.join(root, "emptyWindowChatSessions", "e.json"), J(chatSession("e", AT)));
    const events = await collect(extractVsCode(root, "x1"));
    assert.equal(events.filter((e) => e.eventKind === "create_focus_session").length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("store paths name all three VS Code installs, and the scan sees one that is not Code", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-gaps-home-"));
  try {
    const paths = resolveStorePaths(home);
    assert.deepEqual(paths.vscodeVariants.map((v) => v.name), ["Code", "Code - Insiders", "VSCodium"]);
    assert.equal(paths.vscodeVariants[0].history, paths.vscodeHistory);
    assert.equal(paths.vscodeVariants[0].workspaceStorage, paths.vscodeWorkspaceStorage);

    assert.equal((await scanVsCode(paths)).present, false);
    const vscodium = paths.vscodeVariants[2];
    await fs.mkdir(vscodium.emptyWindowChatSessions, { recursive: true });
    await fs.writeFile(path.join(vscodium.emptyWindowChatSessions, "x.jsonl"), "");
    const inventory = await scanVsCode(paths);
    assert.equal(inventory.present, true);
    assert.equal(inventory.counts.looseChatSessions, 1);
    assert.ok(inventory.notes.some((n) => n.includes("VSCodium")));

    const labels = defaultArchiveSources(paths).map((s) => s.label);
    assert.ok(labels.includes("emptyWindowChatSessions-vscodium"));
    assert.ok(!labels.some((l) => l.includes("insiders")), "installs that are not there add no source");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
