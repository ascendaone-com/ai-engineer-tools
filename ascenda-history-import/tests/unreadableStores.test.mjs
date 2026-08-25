import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { extractCursor } from "../dist/extractors/cursor.js";

/**
 * Unreadable-store diagnostics for the Claude Code and Cursor extractors.
 *
 * Both had the blind spot the VS Code extractor did: a store whose format the
 * extractor no longer understands produced NO events and NO epoch marker, so
 * it rendered as "this person did no work" rather than "nobody can read this
 * store any more". VS Code's Feb-2026 `.json` -> `.jsonl` migration sat behind
 * that silence for seven months.
 *
 * It matters more here. Claude Code's store is on a 30-day rolling purge:
 * months are deleted while the importer reports success, and unlike VS Code's
 * stable store there is nothing left to re-read once anyone notices.
 *
 * The counter is deliberately shape-based ("a project with files but no
 * readable transcript") rather than an extension denylist. Counting every
 * non-`.jsonl` file read 449 on a healthy reference store — memory notes,
 * agent metadata, cached tool output, fetched PDFs — and a permanently
 * non-zero counter is one nobody reads.
 */

async function collect(iter) {
  const events = [];
  for await (const e of iter) events.push(e);
  return events;
}

const claudeLine = (ts) =>
  JSON.stringify({
    version: "1.0.0",
    type: "user",
    timestamp: ts,
    sessionId: "s1",
    cwd: "/Users/example/repo",
    message: { role: "user", content: "content that must never be read" }
  });

async function projectStore(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-store-"));
  const projectDir = path.join(dir, "projects", "testproj");
  await fs.mkdir(projectDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(projectDir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  return dir;
}

test("Claude Code declares a project whose transcripts it cannot read", async () => {
  // Every transcript in a format this extractor has no reader for: the shape
  // of a store migration. Previously this yielded nothing at all —
  // indistinguishable from an unused machine.
  const dir = await projectStore({ "a.jsonl.zst": "x", "b.jsonl.zst": "y" });
  try {
    const events = await collect(extractClaudeCode(dir, "test-extraction"));
    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.ok(epoch, "an unreadable store must still declare itself");
    assert.equal(epoch.metrics.projectsWithNoReadableTranscript, 1);
    assert.equal(epoch.metrics.sessionCount, 0);
    assert.equal(epoch.metrics.windowOldest, undefined, "nothing datable was read, so no window is claimed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a session whose transcript the purge took, but whose sidecars survived, is declared", async () => {
  // Observed on a real store: `tool-results/*.txt` outliving the
  // `.jsonl` the 30-day purge deleted. The work happened; the record of it is
  // gone. That is worth surfacing, not rounding to zero.
  const dir = await projectStore({
    "9308225c/tool-results/b382nnrnm.txt": "cached output",
    "9308225c/tool-results/bz7qur31g.txt": "cached output"
  });
  try {
    const events = await collect(extractClaudeCode(dir, "test-extraction"));
    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.ok(epoch);
    assert.equal(epoch.metrics.projectsWithNoReadableTranscript, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ordinary sidecars alongside a readable transcript are NOT a finding", async () => {
  // The anti-noise case, and the reason this counter is shape-based. All of
  // these sit in a real store permanently; if they registered, the counter
  // would be non-zero forever and would signal nothing.
  const dir = await projectStore({
    "session1.jsonl": claudeLine("2026-07-21T03:00:00.000Z") + "\n",
    "memory/MEMORY.md": "# notes",
    "memory/some-fact.md": "a fact",
    "agent-aff4f0ef8aae6b733.meta.json": "{}",
    "toolu_01K5H2KsV8pS9966aH6omGq7.txt": "cached output",
    "webfetch-1785101199582-07sg3b.pdf": "%PDF-1.4"
  });
  try {
    const events = await collect(extractClaudeCode(dir, "test-extraction"));
    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.ok(epoch);
    assert.equal(epoch.metrics.projectsWithNoReadableTranscript, 0, "sidecars must not read as a broken store");
    assert.ok(epoch.metrics.windowOldest, "the readable transcript still sets the window");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Cursor declares an unreadable schema instead of returning silently", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-schema-"));
  try {
    // A db that opens fine but has no `composerHeaders` — what a Cursor
    // storage migration looks like from here.
    execFileSync("sqlite3", [path.join(dir, "state.vscdb")], {
      input: "CREATE TABLE somethingElse (id TEXT);\n"
    });

    const events = await collect(extractCursor(dir, "test-extraction"));
    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.ok(epoch, "a store present but unreadable must declare itself");
    assert.equal(epoch.metrics.schemaUnreadable, 1);
    assert.equal(epoch.metrics.sessionCount, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an absent store stays silent — nothing to report is not a read failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "absent-"));
  try {
    // Cursor and Claude Code simply are not installed. Neither may produce a
    // diagnostic: a counter that fires on every machine without the tool is
    // noise, and noise is what stops anyone reading the real signal.
    assert.deepEqual(await collect(extractCursor(dir, "test-extraction")), []);
    assert.deepEqual(await collect(extractClaudeCode(dir, "test-extraction")), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
