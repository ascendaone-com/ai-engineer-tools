import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { extractVsCode } from "../dist/extractors/vscode.js";

/**
 * The `.jsonl` migration (Feb 2026).
 *
 * VS Code moved chat sessions from a whole-document `.json` to a keypath-delta
 * `.jsonl` log. Both the staging copier and the extractor globbed `*.json`, so
 * from Feb 2026 the sessions were never read — and because the filter excluded
 * them before any parse was attempted, `unparsedChatSessionFiles` stayed 0 and
 * the import reported clean. On the reference machine that hid 1,020 sessions
 * and 6,869 prompts behind a successful-looking run.
 *
 * Delta shape, as observed on the real store: line 1 is `{kind:0, v:<session>}`
 * and later lines are `{kind:1, k:[...path], v}` (set) or
 * `{kind:2, k:[...path], v:[...], i?}` (splice, appending when `i` is absent).
 */

const REPO_A = "/Users/example/Dev/repo-a";

async function makeSnapshot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-jsonl-test-"));
  await fs.mkdir(path.join(root, "history"), { recursive: true });
  const wsDir = path.join(root, "workspaceStorage");
  await fs.mkdir(wsDir, { recursive: true });
  return { root, wsDir };
}

async function writeWorkspaceFolder(wsDir, hash, folderPath) {
  const dir = path.join(wsDir, hash);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(folderPath).toString() })
  );
}

async function writeSessionFile(wsDir, hash, name, raw) {
  const dir = path.join(wsDir, hash, "chatSessions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), raw);
}

function jsonlSession(header, deltas) {
  return [JSON.stringify({ kind: 0, v: header }), ...deltas.map((d) => JSON.stringify(d))].join("\n");
}

async function collect(root) {
  const events = [];
  for await (const e of extractVsCode(root, "test-extraction")) events.push(e);
  return events;
}

const req = (ts, extra = {}) => ({
  timestamp: ts,
  modelId: "copilot/gpt-5",
  message: { text: "content that must never be read" },
  ...extra
});

test("a .jsonl session folds its deltas — reading only the header would undercount prompts", async () => {
  const { root, wsDir } = await makeSnapshot();
  const T1 = new Date(2026, 6, 20, 10, 0, 0).getTime();
  const T2 = new Date(2026, 6, 20, 10, 5, 0).getTime();
  const T3 = new Date(2026, 6, 20, 10, 9, 0).getTime();

  await writeWorkspaceFolder(wsDir, "hash-c", REPO_A);
  // The header carries ONE request and the other two arrive as appends, which
  // is the real distribution: headers alone held 579 of 6,869 requests on the
  // reference machine, so a header-only reader looks correct and is not.
  await writeSessionFile(
    wsDir,
    "hash-c",
    "s-jsonl.jsonl",
    jsonlSession({ version: 3, sessionId: "s-jsonl", requests: [req(T1)] }, [
      { kind: 2, k: ["requests"], v: [req(T2)] },
      { kind: 2, k: ["requests"], v: [req(T3)] },
      { kind: 1, k: ["requests", 2, "isCanceled"], v: true }
    ])
  );

  const events = await collect(root);
  assert.equal(
    events.filter((e) => e.eventKind === "ai_prompt_submitted").length,
    3,
    "all three requests must survive the fold, not just the header's one"
  );

  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.equal(session.metrics.requestCount, 3);
  assert.equal(
    session.metrics.canceledCount,
    1,
    "a kind:1 set against requests[2] must land on the appended element"
  );
  assert.equal(session.sessionRef, "s-jsonl");
  assert.equal(session.repoRef, REPO_A);
});

test("both store formats are read together, and the epoch reports no blind spot", async () => {
  const { root, wsDir } = await makeSnapshot();
  const T = new Date(2026, 6, 20, 11, 0, 0).getTime();
  await writeWorkspaceFolder(wsDir, "hash-d", REPO_A);
  await writeSessionFile(
    wsDir,
    "hash-d",
    "old.json",
    JSON.stringify({ version: 3, sessionId: "old", requests: [req(T)] })
  );
  await writeSessionFile(
    wsDir,
    "hash-d",
    "new.jsonl",
    jsonlSession({ version: 3, sessionId: "new", requests: [] }, [
      { kind: 2, k: ["requests"], v: [req(T)] }
    ])
  );

  const events = await collect(root);
  const ids = events
    .filter((e) => e.eventKind === "create_focus_session")
    .map((e) => e.sessionRef)
    .sort();
  assert.deepEqual(ids, ["new", "old"], "reading the new format must not drop the old one");

  const epoch = events.find((e) => e.eventKind === "extraction_epoch");
  assert.equal(epoch.metrics.unparsedChatSessionFiles, 0);
  assert.equal(epoch.metrics.unrecognisedChatSessionFiles, 0);
  assert.equal(epoch.metrics.malformedChatSessionLines, 0);
});

test("a store shape with no reader is counted, not silently skipped", async () => {
  const { root, wsDir } = await makeSnapshot();
  await writeWorkspaceFolder(wsDir, "hash-e", REPO_A);
  // Whatever the next migration is. The point of this counter is that a future
  // format change surfaces as a number rather than as quietly empty months.
  await writeSessionFile(wsDir, "hash-e", "session.sqlite3", "not json at all");
  await writeSessionFile(wsDir, "hash-e", "session.bin", " ");

  const events = await collect(root);
  const epoch = events.find((e) => e.eventKind === "extraction_epoch");
  assert.equal(epoch.metrics.unrecognisedChatSessionFiles, 2);
});

test("a truncated .jsonl tail counts the bad line and keeps the rest of the session", async () => {
  const { root, wsDir } = await makeSnapshot();
  const T = new Date(2026, 6, 20, 12, 0, 0).getTime();
  await writeWorkspaceFolder(wsDir, "hash-f", REPO_A);
  const whole = jsonlSession({ version: 3, sessionId: "trunc", requests: [req(T)] }, []);
  // VS Code was mid-write when the snapshot was taken: a half-written tail.
  const truncatedTail = "\n" + '{"kind":1,"k":["requ';
  await writeSessionFile(wsDir, "hash-f", "trunc.jsonl", whole + truncatedTail);

  const events = await collect(root);
  const epoch = events.find((e) => e.eventKind === "extraction_epoch");
  assert.equal(epoch.metrics.malformedChatSessionLines, 1);
  assert.equal(
    events.filter((e) => e.eventKind === "ai_prompt_submitted").length,
    1,
    "a bad tail must not void the session it belongs to"
  );
});

test("a .jsonl with no header record is unparsed, never half-read", async () => {
  const { root, wsDir } = await makeSnapshot();
  await writeWorkspaceFolder(wsDir, "hash-g", REPO_A);
  // Deltas with nothing to apply them to. Reconstructing a session from these
  // would be inference; this package counts UNPARSED instead of guessing.
  await writeSessionFile(
    wsDir,
    "hash-g",
    "headless.jsonl",
    JSON.stringify({ kind: 2, k: ["requests"], v: [req(1)] })
  );

  const events = await collect(root);
  const epoch = events.find((e) => e.eventKind === "extraction_epoch");
  assert.equal(epoch.metrics.unparsedChatSessionFiles, 1);
  assert.equal(events.filter((e) => e.eventKind === "create_focus_session").length, 0);
});

test("a delta against a path the header never had is dropped, not conjured", async () => {
  const { root, wsDir } = await makeSnapshot();
  const T = new Date(2026, 6, 20, 13, 0, 0).getTime();
  await writeWorkspaceFolder(wsDir, "hash-h", REPO_A);
  await writeSessionFile(
    wsDir,
    "hash-h",
    "stray.jsonl",
    jsonlSession({ version: 3, sessionId: "stray", requests: [req(T)] }, [
      { kind: 2, k: ["nonexistent", "deeper"], v: [req(T)] },
      { kind: 1, k: ["requests", 9, "isCanceled"], v: true }
    ])
  );

  const events = await collect(root);
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.equal(session.metrics.requestCount, 1, "a stray delta must not invent requests");
  assert.equal(session.metrics.canceledCount, 0);
});
