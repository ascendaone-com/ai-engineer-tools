import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { extractVsCode } from "../dist/extractors/vscode.js";
import { toWirePayload } from "../dist/ship.js";
import { buildVsCodeHandoff } from "../dist/localHandoff.js";

// Fixtures shaped like a real VS Code store: Timeline history self-labels
// `{"version":1,"resource","entries"}`, entries carry
// `source: "Chat Edit: '<prompt>'"` for AI-driven edits and no `source` at all
// for a manual save. Copilot chat sessions self-label `"version":3`, each
// `requests[]` item carries `message`/`response` (content, never read past
// existence checks here) plus `modelId`/`timestamp`/`isCanceled`/
// `result.errorDetails` (metrics). Workspace identity for both stores comes
// from `workspaceStorage/<hash>/workspace.json`'s real `folder` field.

const REPO_A = "/Users/example/Dev/repo-a";
const REPO_B = "/Users/example/Dev/repo-b";

function historyEntriesFile(resourcePath, entries) {
  return JSON.stringify({ version: 1, resource: pathToFileURL(resourcePath).toString(), entries });
}

async function makeSnapshot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-import-test-"));
  const historyDir = path.join(root, "history");
  const wsDir = path.join(root, "workspaceStorage");
  await fs.mkdir(historyDir, { recursive: true });
  await fs.mkdir(wsDir, { recursive: true });
  return { root, historyDir, wsDir };
}

async function writeWorkspaceFolder(wsDir, hash, folderPath) {
  const dir = path.join(wsDir, hash);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(folderPath).toString() })
  );
}

async function writeChatSession(wsDir, hash, sessionFile, session) {
  const dir = path.join(wsDir, hash, "chatSessions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, sessionFile), JSON.stringify(session));
}

async function writeHistoryFile(historyDir, hash, raw) {
  const dir = path.join(historyDir, hash);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "entries.json"), raw);
}

test("extractVsCode aggregates Chat-Edit entries into per-day, per-workspace counts — never per entry", async () => {
  const { root, historyDir, wsDir } = await makeSnapshot();
  try {
    await writeWorkspaceFolder(wsDir, "hash-a", REPO_A);

    // File 1 in repo-a: two Chat Edits same day, one manual save (no source).
    await writeHistoryFile(
      historyDir,
      "file1",
      historyEntriesFile(path.join(REPO_A, "src", "a.ts"), [
        { id: "e1", source: "Chat Edit: 'SECRET_PROMPT_MARKER do the thing'", timestamp: Date.UTC(2026, 6, 20, 10, 0) },
        { id: "e2", timestamp: Date.UTC(2026, 6, 20, 11, 0) }, // manual save — no source field
        { id: "e3", source: "Chat Edit: 'another prompt'", timestamp: Date.UTC(2026, 6, 20, 12, 0) }
      ])
    );
    // File 2, same repo, same day — folds into the same (date, workspace) bucket.
    await writeHistoryFile(
      historyDir,
      "file2",
      historyEntriesFile(path.join(REPO_A, "src", "b.ts"), [
        { id: "e4", source: "Chat Edit: 'yet another'", timestamp: Date.UTC(2026, 6, 20, 13, 0) }
      ])
    );
    // File 3, same repo, a different day — separate bucket.
    await writeHistoryFile(
      historyDir,
      "file3",
      historyEntriesFile(path.join(REPO_A, "src", "c.ts"), [
        { id: "e5", source: "Chat Edit: 'day two'", timestamp: Date.UTC(2026, 6, 21, 9, 0) }
      ])
    );
    // Non-AI-attributed sources (renamed/moved/etc.) count toward the
    // denominator but never chatEditCount.
    await writeHistoryFile(
      historyDir,
      "file4",
      historyEntriesFile(path.join(REPO_A, "src", "d.ts"), [
        { id: "e6", source: "renamed.source", timestamp: Date.UTC(2026, 6, 20, 14, 0) }
      ])
    );

    const events = [];
    for await (const e of extractVsCode(root, "test-extraction")) events.push(e);
    const editDays = events.filter((e) => e.eventKind === "editor_activity");

    assert.equal(editDays.length, 2); // 2026-07-20 and 2026-07-21, both repo-a
    const day1 = editDays.find((d) => d.metrics.date === "2026-07-20");
    assert.ok(day1);
    assert.equal(day1.metrics.chatEditCount, 3); // e1, e3, e4
    assert.equal(day1.metrics.totalEntryCount, 5); // e1..e4 + renamed.source
    assert.equal(day1.repoRef, REPO_A);
    assert.equal(day1.sessionRef, null);
    assert.equal(day1.sourceVersion, "1");
    assert.equal(day1.provenance, "historical_derived");

    const day2 = editDays.find((d) => d.metrics.date === "2026-07-21");
    assert.ok(day2);
    assert.equal(day2.metrics.chatEditCount, 1);
    assert.equal(day2.metrics.totalEntryCount, 1);

    // No metric anywhere may carry the prompt text.
    for (const e of events) {
      const values = Object.values(e.metrics).join(" ");
      assert.ok(!values.includes("SECRET_PROMPT_MARKER"), `content leaked into metrics: ${values}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("extractVsCode resolves workspace identity via workspace.json, falling back to the file's own directory", async () => {
  const { root, historyDir, wsDir } = await makeSnapshot();
  try {
    await writeWorkspaceFolder(wsDir, "hash-a", REPO_A);
    // A file nested well inside repo-a resolves to the workspace root, not
    // its own containing directory.
    await writeHistoryFile(
      historyDir,
      "nested",
      historyEntriesFile(path.join(REPO_A, "lib", "deep", "nested.ts"), [
        { id: "e1", source: "Chat Edit: 'x'", timestamp: Date.UTC(2026, 6, 20, 10, 0) }
      ])
    );
    // A file outside any known workspace.json folder — falls back to its own
    // containing directory rather than a fabricated workspace name.
    await writeHistoryFile(
      historyDir,
      "scratch",
      historyEntriesFile("/tmp/scratch/temp.py", [
        { id: "e2", source: "Chat Edit: 'y'", timestamp: Date.UTC(2026, 6, 20, 10, 0) }
      ])
    );

    const events = [];
    for await (const e of extractVsCode(root, "test-extraction")) events.push(e);
    const editDays = events.filter((e) => e.eventKind === "editor_activity");

    assert.ok(editDays.some((d) => d.repoRef === REPO_A));
    assert.ok(editDays.some((d) => d.repoRef === "/tmp/scratch"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("extractVsCode treats an unrecognised Timeline-history version as unparsed, never half-read", async () => {
  const { root, historyDir } = await makeSnapshot();
  try {
    await writeHistoryFile(
      historyDir,
      "future",
      JSON.stringify({
        version: 2, // not the known version 1
        resource: pathToFileURL(path.join(REPO_A, "x.ts")).toString(),
        entries: [{ source: "Chat Edit: 'x'", timestamp: Date.UTC(2026, 6, 20, 10, 0) }]
      })
    );
    await writeHistoryFile(historyDir, "garbage", "not json at all");

    const events = [];
    for await (const e of extractVsCode(root, "test-extraction")) events.push(e);
    assert.equal(events.filter((e) => e.eventKind === "editor_activity").length, 0);
    // The epoch is emitted precisely BECAUSE nothing parsed. It used to be
    // suppressed here — no window, no marker — which meant a store the
    // extractor could not read produced no diagnostic at all. That is how the
    // Feb-2026 `.jsonl` migration stayed invisible: silence read as success.
    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.ok(epoch, "an unreadable store must still declare itself");
    assert.equal(epoch.metrics.unparsedHistoryFiles, 2);
    assert.equal(epoch.metrics.windowOldest, undefined, "nothing datable was read, so no window is claimed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("extractVsCode folds Copilot chat sessions: prompts, session metrics, after-hours, errors", async () => {
  const { root, wsDir } = await makeSnapshot();
  try {
    // Constructed from LOCAL field values (not a fixed UTC string) so the
    // after-hours assertion holds regardless of the machine/CI running the
    // test — the same technique cursor.test.mjs and isAfterHours itself use.
    const IN_HOURS_MS_1 = new Date(2026, 6, 20, 10, 0, 0).getTime();
    const IN_HOURS_MS_2 = new Date(2026, 6, 20, 10, 5, 0).getTime();
    const AFTER_HOURS_MS = new Date(2026, 6, 20, 23, 30, 0).getTime();

    await writeWorkspaceFolder(wsDir, "hash-b", REPO_B);
    await writeChatSession(wsDir, "hash-b", "session-1.json", {
      version: 3,
      sessionId: "session-1",
      requests: [
        {
          timestamp: IN_HOURS_MS_1,
          modelId: "copilot/claude-sonnet-4.5",
          message: { text: "SECRET_PROMPT_MARKER first message" },
          response: [{ kind: "text", value: "SECRET_RESPONSE_MARKER reply" }]
        },
        {
          timestamp: IN_HOURS_MS_2,
          modelId: "copilot/claude-sonnet-4.5",
          isCanceled: true,
          message: { text: "canceled one" },
          response: []
        },
        {
          timestamp: AFTER_HOURS_MS,
          modelId: "copilot/gpt-5",
          message: { text: "late one" },
          response: [],
          result: { errorDetails: { message: "boom" } }
        }
      ]
    });
    // A draft session with no requests — must be skipped entirely.
    await writeChatSession(wsDir, "hash-b", "draft.json", {
      version: 3,
      sessionId: "draft",
      requests: []
    });

    const events = [];
    for await (const e of extractVsCode(root, "test-extraction")) events.push(e);

    const prompts = events.filter((e) => e.eventKind === "ai_prompt_submitted");
    const sessions = events.filter((e) => e.eventKind === "create_focus_session");
    const afterHours = events.filter((e) => e.eventKind === "after_hours_ai_session");
    const failures = events.filter((e) => e.eventKind === "tool_failure");
    const epochs = events.filter((e) => e.eventKind === "extraction_epoch");

    assert.equal(prompts.length, 3);
    assert.ok(prompts.every((p) => p.sessionRef === "session-1"));
    assert.ok(prompts.every((p) => p.repoRef === REPO_B));
    assert.ok(prompts.every((p) => p.provenance === "historical_direct"));
    assert.ok(prompts.every((p) => Object.keys(p.metrics).length === 0));

    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.sessionRef, "session-1");
    assert.equal(s.store, "vscode");
    assert.equal(s.sourceVersion, "3");
    assert.equal(s.provenance, "historical_derived");
    assert.equal(s.metrics.requestCount, 3);
    assert.equal(s.metrics.canceledCount, 1);
    assert.equal(s.metrics.errorCount, 1);
    assert.equal(s.metrics.afterHoursRequests, 1);
    assert.equal(s.metrics.primaryModel, "copilot/claude-sonnet-4.5"); // 2 of 3 requests
    assert.equal(s.metrics.modelCount, 2);

    assert.equal(afterHours.length, 1);
    assert.equal(afterHours[0].metrics.afterHoursPrompts, 1);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].metrics.toolFailureCount, 1);

    assert.equal(epochs.length, 1);
    assert.equal(epochs[0].metrics.sessionCount, 1);

    for (const e of events) {
      const values = Object.values(e.metrics).join(" ");
      assert.ok(!values.includes("SECRET_PROMPT_MARKER"), `content leaked into metrics: ${values}`);
      assert.ok(!values.includes("SECRET_RESPONSE_MARKER"), `content leaked into metrics: ${values}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("extractVsCode treats an unrecognised chat-session version as unparsed", async () => {
  const { root, wsDir } = await makeSnapshot();
  try {
    await writeWorkspaceFolder(wsDir, "hash-b", REPO_B);
    await writeChatSession(wsDir, "hash-b", "future.json", {
      version: 99,
      sessionId: "future",
      requests: [{ timestamp: Date.UTC(2026, 6, 20, 10, 0), modelId: "x", message: {}, response: [] }]
    });

    const events = [];
    for await (const e of extractVsCode(root, "test-extraction")) events.push(e);
    assert.equal(events.filter((e) => e.eventKind === "create_focus_session").length, 0);

    // Same rule as the Timeline case above: unreadable is a finding, not a
    // reason to stay quiet.
    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.ok(epoch, "an unreadable store must still declare itself");
    assert.equal(epoch.metrics.unparsedChatSessionFiles, 1); // Nothing usable parsed at all in this fixture.
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("wire payload for an edit-day event hashes the workspace path and carries only counts", async () => {
  const { root, historyDir, wsDir } = await makeSnapshot();
  try {
    await writeWorkspaceFolder(wsDir, "hash-a", REPO_A);
    await writeHistoryFile(
      historyDir,
      "file1",
      historyEntriesFile(path.join(REPO_A, "a.ts"), [
        { source: "Chat Edit: 'SECRET_PROMPT_MARKER'", timestamp: Date.UTC(2026, 6, 20, 10, 0) }
      ])
    );

    const events = [];
    for await (const e of extractVsCode(root, "test-extraction")) events.push(e);
    const day = events.find((e) => e.eventKind === "editor_activity");
    const payload = toWirePayload(day, 0, "claude_code:test-install");

    assert.equal(payload.source, "vscode_extension");
    assert.equal(payload.consentScope, "historical_import");
    assert.equal(payload.privacyMode, "metadata_only");
    assert.match(payload.workspaceHash, /^[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(payload).includes(REPO_A), false);
    assert.equal(JSON.stringify(payload).includes("SECRET_PROMPT_MARKER"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildVsCodeHandoff splits edit-days and chat sessions, both derived provenance", async () => {
  const { root, historyDir, wsDir } = await makeSnapshot();
  try {
    await writeWorkspaceFolder(wsDir, "hash-a", REPO_A);
    await writeHistoryFile(
      historyDir,
      "file1",
      historyEntriesFile(path.join(REPO_A, "a.ts"), [
        { source: "Chat Edit: 'x'", timestamp: Date.UTC(2026, 6, 20, 10, 0) }
      ])
    );
    await writeChatSession(wsDir, "hash-a", "session-1.json", {
      version: 3,
      sessionId: "session-1",
      requests: [{ timestamp: Date.UTC(2026, 6, 20, 11, 0), modelId: "copilot/auto", message: {}, response: [] }]
    });

    const events = [];
    for await (const e of extractVsCode(root, "test-extraction")) events.push(e);
    const handoff = buildVsCodeHandoff(events, "test-extraction", "2026-08-18T00:00:00.000Z");

    assert.equal(handoff.store, "vscode");
    assert.equal(handoff.editDays.length, 1);
    assert.equal(handoff.editDays[0].projectLabel, "repo-a");
    assert.equal(handoff.chatSessions.length, 1);
    assert.equal(handoff.chatSessions[0].projectLabel, "repo-a");
    assert.ok(handoff.editDays.every((d) => d.provenance === "historical_derived"));
    assert.ok(handoff.chatSessions.every((s) => s.provenance === "historical_derived"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("extractVsCode yields nothing for a snapshot with neither store present", async () => {
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-import-empty-"));
  try {
    const events = [];
    for await (const e of extractVsCode(emptyDir, "test-extraction")) events.push(e);
    assert.deepEqual(events, []);
  } finally {
    await fs.rm(emptyDir, { recursive: true, force: true });
  }
});
