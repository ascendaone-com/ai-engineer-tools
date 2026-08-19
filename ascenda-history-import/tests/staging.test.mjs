import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { snapshotVsCodeWorkspaceStorage } from "../dist/staging.js";

/**
 * The copier is the first of the two filters that hid the Feb-2026 `.jsonl`
 * migration, and the more consequential one: a file the snapshot never copies
 * cannot be read, cannot be counted as unparsed, and cannot appear in any
 * diagnostic. The extractor at least had the chance to report what it could
 * not parse; staging removed the evidence first.
 *
 * The copier stays deliberately narrow — `state.vscdb` and extension caches
 * next door run to gigabytes — so this pins both halves: the session formats
 * are copied, and the bulk artifacts still are not.
 */

async function makeSourceStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-src-"));
  const hash = path.join(root, "hash-a");
  const sessions = path.join(hash, "chatSessions");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(hash, "workspace.json"), JSON.stringify({ folder: "file:///Users/example/repo" }));
  await fs.writeFile(path.join(sessions, "old.json"), JSON.stringify({ version: 3, requests: [] }));
  await fs.writeFile(path.join(sessions, "new.jsonl"), JSON.stringify({ kind: 0, v: { version: 3 } }));
  // Must NOT be copied: the reason this copier is hand-rolled at all.
  await fs.writeFile(path.join(hash, "state.vscdb"), "x".repeat(1024));
  return root;
}

test("staging copies both chat-session formats, and still skips the bulk artifacts", async () => {
  const source = await makeSourceStore();
  const areaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-stage-"));
  const area = { extractionId: "test-extraction", root: areaRoot };

  await snapshotVsCodeWorkspaceStorage(area, source, "workspaceStorage");

  const staged = await fs.readdir(path.join(areaRoot, "workspaceStorage", "hash-a", "chatSessions"));
  assert.deepEqual(
    staged.sort(),
    ["new.jsonl", "old.json"],
    "a session format the copier drops is invisible to every downstream diagnostic"
  );

  const hashDir = await fs.readdir(path.join(areaRoot, "workspaceStorage", "hash-a"));
  assert.ok(hashDir.includes("workspace.json"), "workspace identity must still be staged");
  assert.ok(!hashDir.includes("state.vscdb"), "the copier must stay narrow — state.vscdb can be gigabytes");
});
