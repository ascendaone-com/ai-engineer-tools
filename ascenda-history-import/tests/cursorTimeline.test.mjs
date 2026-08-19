import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { extractCursor, resolveTimeline } from "../dist/extractors/cursor.js";

// `composerHeaders.lastUpdatedAt` is nullable and Cursor really does leave it
// unset: 42 of 151 headers on the reference machine. The emit loop used to
// `continue` past every one of them without a counter, so a dropped
// conversation and one that never happened rendered identically.
//
// On that machine the 15 non-subagent casualties all had zero bubbles, so no
// prompt was actually lost — which is exactly why the bug survived a live run
// that reported success. Nothing in the schema ties a null `lastUpdatedAt` to
// emptiness, so these fixtures cover the case that machine happened not to
// have: an undated header with real messages under it.

const CREATED_AT_MS = Date.UTC(2026, 6, 20, 10, 0, 0);

function sqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function headerRow({ composerId, createdAtMs, lastUpdatedAtMs, recency, checkpointAt }) {
  const nullable = (v) => (v === null || v === undefined ? "NULL" : String(v));
  return `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, recency, checkpointAt, value) VALUES (${sqlString(
    composerId
  )}, 'workspace-1', ${createdAtMs}, ${nullable(lastUpdatedAtMs)}, 0, ${nullable(
    recency
  )}, ${nullable(checkpointAt)}, ${sqlString(
    JSON.stringify({
      type: "head",
      composerId,
      createdAt: createdAtMs,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      filesChangedCount: 0,
      contextUsagePercent: 0,
      unifiedMode: "agent"
    })
  )});`;
}

// A bubble with `createdAt` omitted: it proves the conversation is not empty
// without being able to date it — which is what forces the header fallbacks
// to be exercised now that empty conversations are excluded outright.
function bubbleRow({ composerId, bubbleId, type, createdAt }) {
  return `INSERT INTO cursorDiskKV (key, value) VALUES (${sqlString(
    `bubbleId:${composerId}:${bubbleId}`
  )}, ${sqlString(
    JSON.stringify({
      _v: 3,
      type,
      ...(createdAt === undefined ? {} : { createdAt }),
      tokenCount: { inputTokens: 10, outputTokens: 20 },
      modelInfo: { modelName: "claude-4-sonnet" }
    })
  )});`;
}

async function storeWith(statements) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-timeline-test-"));
  const sql = [
    "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT);",
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    ...statements
  ].join("\n");
  execFileSync("/usr/bin/sqlite3", [path.join(dir, "state.vscdb")], { input: sql });
  return dir;
}

async function collect(dir) {
  const events = [];
  for await (const event of extractCursor(dir, "extraction-1")) events.push(event);
  return events;
}

function epochOf(events) {
  return events.find((e) => e.eventKind === "extraction_epoch");
}

test("an undated header with bubbles keeps its session and its prompts", async () => {
  const composerId = "aaaaaaaa-0000-0000-0000-000000000001";
  const lastPrompt = new Date(CREATED_AT_MS + 6 * 60_000).toISOString();
  const dir = await storeWith([
    headerRow({ composerId, createdAtMs: CREATED_AT_MS, lastUpdatedAtMs: null }),
    bubbleRow({
      composerId,
      bubbleId: "b1",
      type: 1,
      createdAt: new Date(CREATED_AT_MS + 60_000).toISOString()
    }),
    bubbleRow({ composerId, bubbleId: "b2", type: 1, createdAt: lastPrompt })
  ]);

  const events = await collect(dir);

  // Pre-fix this store yielded nothing but an epoch marker.
  const prompts = events.filter((e) => e.eventKind === "ai_prompt_submitted");
  assert.equal(prompts.length, 2, "both human prompts survive an undated header");

  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.ok(session, "the session is emitted rather than skipped");
  assert.equal(session.occurredAt, lastPrompt, "the newest bubble dates the session's end");
  assert.equal(session.metrics.promptCount, 2);
  assert.equal(session.metrics.sessionMinutes, 6, "duration is measured, not guessed");

  const epoch = epochOf(events);
  assert.equal(epoch.metrics.sessionsFromBubbleTimeline, 1);
  assert.equal(epoch.metrics.sessionsWithoutTimeline, 0);
});

test("with no bubble able to date it, recency ends the session", async () => {
  const composerId = "aaaaaaaa-0000-0000-0000-000000000002";
  const recency = CREATED_AT_MS + 9 * 60_000;
  const dir = await storeWith([
    headerRow({ composerId, createdAtMs: CREATED_AT_MS, lastUpdatedAtMs: null, recency }),
    bubbleRow({ composerId, bubbleId: "b1", type: 1 })
  ]);

  const events = await collect(dir);
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.ok(session);
  assert.equal(session.occurredAt, new Date(recency).toISOString());

  const epoch = epochOf(events);
  assert.equal(epoch.metrics.sessionsFromRecencyTimeline, 1);
  assert.equal(epoch.metrics.sessionsFromBubbleTimeline, 0);
});

test("a bubble outranks recency, because a message is the better witness", async () => {
  const composerId = "aaaaaaaa-0000-0000-0000-000000000003";
  const bubbleAt = new Date(CREATED_AT_MS + 12 * 60_000).toISOString();
  const dir = await storeWith([
    headerRow({
      composerId,
      createdAtMs: CREATED_AT_MS,
      lastUpdatedAtMs: null,
      recency: CREATED_AT_MS + 30 * 60_000
    }),
    bubbleRow({ composerId, bubbleId: "b1", type: 1, createdAt: bubbleAt })
  ]);

  const events = await collect(dir);
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.equal(session.occurredAt, bubbleAt);
  assert.equal(epochOf(events).metrics.sessionsFromBubbleTimeline, 1);
});

test("checkpointAt is the last resort, behind recency", async () => {
  const composerId = "aaaaaaaa-0000-0000-0000-000000000004";
  const checkpointAt = CREATED_AT_MS + 3 * 60_000;
  const dir = await storeWith([
    headerRow({ composerId, createdAtMs: CREATED_AT_MS, lastUpdatedAtMs: null, checkpointAt }),
    bubbleRow({ composerId, bubbleId: "b1", type: 1 })
  ]);

  const events = await collect(dir);
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.equal(session.occurredAt, new Date(checkpointAt).toISOString());
  assert.equal(epochOf(events).metrics.sessionsFromCheckpointTimeline, 1);
});

test("a composer nothing can date is declared, not dropped in silence", async () => {
  const composerId = "aaaaaaaa-0000-0000-0000-000000000005";
  const dir = await storeWith([
    headerRow({ composerId, createdAtMs: CREATED_AT_MS, lastUpdatedAtMs: null }),
    bubbleRow({ composerId, bubbleId: "b1", type: 1 })
  ]);

  const events = await collect(dir);
  assert.equal(
    events.filter((e) => e.eventKind === "create_focus_session").length,
    0,
    "an undatable composer still yields no session"
  );

  const epoch = epochOf(events);
  assert.ok(epoch, "but the marker emits anyway, so the drop is visible");
  assert.equal(epoch.metrics.sessionsWithoutTimeline, 1);
  assert.equal(epoch.metrics.sessionCount, 0);
});

test("a fallback earlier than createdAt is refused, never a negative duration", async () => {
  const composerId = "aaaaaaaa-0000-0000-0000-000000000006";
  const dir = await storeWith([
    headerRow({
      composerId,
      createdAtMs: CREATED_AT_MS,
      lastUpdatedAtMs: null,
      recency: CREATED_AT_MS - 60_000,
      checkpointAt: CREATED_AT_MS - 120_000
    }),
    bubbleRow({ composerId, bubbleId: "b1", type: 1 })
  ]);

  const events = await collect(dir);
  assert.equal(events.filter((e) => e.eventKind === "create_focus_session").length, 0);
  assert.equal(epochOf(events).metrics.sessionsWithoutTimeline, 1);
});

test("a real lastUpdatedAt is never displaced by a fallback", async () => {
  const composerId = "aaaaaaaa-0000-0000-0000-000000000007";
  const lastUpdatedAtMs = CREATED_AT_MS + 5 * 60_000;
  const dir = await storeWith([
    headerRow({
      composerId,
      createdAtMs: CREATED_AT_MS,
      lastUpdatedAtMs,
      recency: CREATED_AT_MS + 90 * 60_000
    }),
    bubbleRow({
      composerId,
      bubbleId: "b1",
      type: 1,
      createdAt: new Date(CREATED_AT_MS + 80 * 60_000).toISOString()
    })
  ]);

  const events = await collect(dir);
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.equal(session.occurredAt, new Date(lastUpdatedAtMs).toISOString());

  const epoch = epochOf(events);
  assert.equal(epoch.metrics.sessionsFromBubbleTimeline, 0);
  assert.equal(epoch.metrics.sessionsFromRecencyTimeline, 0);
});

test("resolveTimeline reports which field ended the session", () => {
  const base = {
    createdAtMs: CREATED_AT_MS,
    lastUpdatedAtMs: null,
    recencyMs: null,
    checkpointAtMs: null,
    lastBubbleMs: null
  };
  assert.equal(resolveTimeline({ ...base, lastUpdatedAtMs: CREATED_AT_MS + 1 }).source, "header");
  assert.equal(resolveTimeline({ ...base, lastBubbleMs: CREATED_AT_MS + 1 }).source, "bubbles");
  assert.equal(resolveTimeline({ ...base, recencyMs: CREATED_AT_MS + 1 }).source, "recency");
  assert.equal(resolveTimeline({ ...base, checkpointAtMs: CREATED_AT_MS + 1 }).source, "checkpoint");
  assert.equal(resolveTimeline(base), null);
  assert.equal(resolveTimeline({ ...base, createdAtMs: null, recencyMs: 1 }), null);
});

test("a conversation nobody typed into is excluded, and counted as excluded", async () => {
  const empty = "bbbbbbbb-0000-0000-0000-000000000001";
  const used = "bbbbbbbb-0000-0000-0000-000000000002";
  const dir = await storeWith([
    // Datable, but nothing ever happened in it — the 48 of these the
    // extractor used to emit are why the rule needed stating.
    headerRow({
      composerId: empty,
      createdAtMs: CREATED_AT_MS,
      lastUpdatedAtMs: CREATED_AT_MS + 60_000
    }),
    headerRow({
      composerId: used,
      createdAtMs: CREATED_AT_MS,
      lastUpdatedAtMs: CREATED_AT_MS + 60_000
    }),
    bubbleRow({
      composerId: used,
      bubbleId: "b1",
      type: 1,
      createdAt: new Date(CREATED_AT_MS + 30_000).toISOString()
    })
  ]);

  const events = await collect(dir);
  const sessions = events.filter((e) => e.eventKind === "create_focus_session");
  assert.equal(sessions.length, 1, "only the conversation with a message counts");
  assert.equal(sessions[0].sessionRef, used);

  const epoch = epochOf(events);
  assert.equal(epoch.metrics.emptyComposers, 1, "the exclusion is reported, not inferred");
  assert.equal(
    epoch.metrics.sessionsWithoutTimeline,
    0,
    "an empty conversation is not miscounted as one nothing could date"
  );
});
