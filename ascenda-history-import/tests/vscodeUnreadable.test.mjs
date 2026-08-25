import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractVsCode } from "../dist/extractors/vscode.js";

/**
 * A read that was attempted and failed must be counted.
 *
 * `foldChatSessions` used to do `catch { continue }` on the session read, with
 * no counter behind it. A session file that could not be read was therefore
 * not unparsed, not unrecognised, and absent from the extraction epoch — the
 * import reported clean while dropping it. That is the same shape as the
 * `.json`-only glob that hid seven months of sessions: the evidence of the
 * gap was destroyed before anything could report it.
 *
 * This is not hypothetical on the machine that prompted these tests: several
 * live chat sessions are 250–450 MB, close enough to V8's maximum string
 * length that `readFile(…, "utf8")` is one bad session away from throwing.
 */

async function makeStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-unread-"));
  const ws = path.join(root, "workspaceStorage", "hash-a");
  await fs.mkdir(path.join(ws, "chatSessions"), { recursive: true });
  await fs.mkdir(path.join(root, "history"), { recursive: true });
  await fs.writeFile(path.join(ws, "workspace.json"), JSON.stringify({ folder: "file:///Users/x/repo" }));
  await fs.writeFile(
    path.join(ws, "chatSessions", "good.json"),
    JSON.stringify({
      version: 3,
      sessionId: "good",
      requests: [{ message: { text: "a" }, response: [{ value: "b" }], modelId: "m", timestamp: 1754000000000 }]
    })
  );
  return { root, ws };
}

async function epochOf(root) {
  const events = [];
  for await (const event of extractVsCode(root, "e1")) events.push(event);
  return events.find((e) => e.eventKind === "extraction_epoch");
}

test("a chat session that cannot be read is counted, not silently dropped", async () => {
  const { root, ws } = await makeStore();
  const bad = path.join(ws, "chatSessions", "bad.json");
  await fs.writeFile(bad, "{}");
  await fs.chmod(bad, 0o000);
  try {
    const epoch = await epochOf(root);
    assert.equal(epoch.metrics.unreadableChatSessionFiles, 1, "the failure must reach the epoch");
    assert.equal(epoch.metrics.sessionCount, 1, "and must not be confused with the session that worked");
  } finally {
    await fs.chmod(bad, 0o644).catch(() => {});
  }
});

test("an unreadable session is distinct from an unparsable one", async () => {
  const { root, ws } = await makeStore();
  await fs.writeFile(path.join(ws, "chatSessions", "wrong-version.json"), JSON.stringify({ version: 99 }));
  const bad = path.join(ws, "chatSessions", "bad.json");
  await fs.writeFile(bad, "{}");
  await fs.chmod(bad, 0o000);
  try {
    const epoch = await epochOf(root);
    assert.equal(epoch.metrics.unreadableChatSessionFiles, 1, "could not read it");
    assert.equal(epoch.metrics.unparsedChatSessionFiles, 1, "read it fine, did not recognise it");
  } finally {
    await fs.chmod(bad, 0o644).catch(() => {});
  }
});

test("a Timeline-history file that cannot be read is counted; a missing one is not", async () => {
  const { root } = await makeStore();
  // An absence: a hash directory with no entries.json at all. Normal, and not
  // a read failure — counting it would cry wolf on every machine.
  await fs.mkdir(path.join(root, "history", "empty-hash"), { recursive: true });

  const unreadable = path.join(root, "history", "locked-hash");
  await fs.mkdir(unreadable, { recursive: true });
  const entries = path.join(unreadable, "entries.json");
  await fs.writeFile(entries, JSON.stringify({ version: 1, resource: "file:///Users/x/repo/a.ts", entries: [] }));
  await fs.chmod(entries, 0o000);
  try {
    const epoch = await epochOf(root);
    assert.equal(epoch.metrics.unreadableHistoryFiles, 1, "a locked entries.json is a real gap");
  } finally {
    await fs.chmod(entries, 0o644).catch(() => {});
  }
});

test("a store that reads cleanly still reports zero read failures, not silence", async () => {
  const { root } = await makeStore();
  const epoch = await epochOf(root);
  assert.equal(epoch.metrics.unreadableChatSessionFiles, 0);
  assert.equal(epoch.metrics.unreadableHistoryFiles, 0);
});
