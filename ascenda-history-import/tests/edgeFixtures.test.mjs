import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { extractCodex } from "../dist/extractors/codex.js";

// One small named transcript per edge case, under `fixtures/edge/<store>/`.
// Each store's README lists the case, what it pins and the figures below.
// A case the extractor gets wrong today is a `todo` that links its plan.

const EDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "edge");
const PLAN = (n) => `https://github.com/ascendaone-com/ai-engineer-tools/pull/${n}`;

async function copyTree(from, to) {
  await fs.cp(from, to, { recursive: true });
}

/** A single-file fixture, placed where the store keeps it. */
async function snapshotOf(store, relFile) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edge-"));
  const source = path.join(EDGE, store, relFile);
  if ((await fs.stat(source)).isDirectory()) {
    await copyTree(source, root);
    return root;
  }
  const text = await fs.readFile(source, "utf8");
  const first = JSON.parse(text.split("\n")[0]);
  if (store === "claude_code") {
    const dir = path.join(root, "projects", "-Users-example-Dev-repo-1");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${first.sessionId}.jsonl`), text);
  } else {
    const id = first.payload.id;
    const dir = path.join(root, "sessions", "2026", "03", "02");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `rollout-2026-03-02T00-00-00-${id}.jsonl`), text);
  }
  return root;
}

async function sessionsOf(store, relFile) {
  const root = await snapshotOf(store, relFile);
  try {
    const run = store === "claude_code" ? extractClaudeCode : extractCodex;
    const sessions = [];
    for await (const event of run(root, "edge")) {
      if (event.eventKind === "create_focus_session") sessions.push(event.metrics);
    }
    return sessions;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const CASES = [
  // Claude Code
  {
    store: "claude_code",
    file: "resume-replay.jsonl",
    expect: { promptCount: 1, mainThreadToolCallCount: 3, toolResultErrorCount: 1, toolFailureCount: 1, assistantTurns: 3, inputTokens: 30, outputTokens: 300 }
  },
  {
    store: "claude_code",
    file: "fork-subagent",
    expect: { promptCount: 1, mainThreadToolCallCount: 1, assistantTurns: 2, subagentTranscripts: 1, subagentToolCallCount: 1, subagentAssistantTurns: 1, toolFailureCount: 0 }
  },
  {
    store: "claude_code",
    file: "incomplete-final-record.jsonl",
    expect: { promptCount: 1, mainThreadToolCallCount: 1, assistantTurns: 2, unparsedLines: 1 }
  },
  {
    store: "claude_code",
    file: "malformed-between-valid.jsonl",
    expect: { promptCount: 1, mainThreadToolCallCount: 1, assistantTurns: 2, unparsedLines: 1 }
  },
  {
    store: "claude_code",
    file: "compaction-continues-session.jsonl",
    expect: { promptCount: 2, syntheticPromptLines: 1, compactionCount: 1, compactionAutoCount: 1, compactionManualCount: 0, mainThreadToolCallCount: 1, assistantTurns: 2 }
  },
  // Codex
  {
    store: "codex",
    file: "token-usage-record-only.jsonl",
    expect: { promptCount: 1, unknownLines: 0, inputTokens: 1000, outputTokens: 50, tokensNotCollected: undefined }
  },
  {
    store: "codex",
    file: "token-usage-record-and-token-count.jsonl",
    expect: { promptCount: 1, unknownLines: 0, inputTokens: 1000, outputTokens: 50 }
  },
  {
    store: "codex",
    file: "archived-copy",
    expect: { promptCount: 1, mainThreadToolCallCount: 1, assistantTurns: 1, inputTokens: 1000, outputTokens: 50 }
  },
  {
    store: "codex",
    file: "fork-replay.jsonl",
    expect: { promptCount: 1, mainThreadToolCallCount: 1, assistantTurns: 1, inputTokens: 300, outputTokens: 40, unknownLines: 0 }
  }
];

for (const { store, file, expect, todo } of CASES) {
  test(`${store}/${file}`, { todo: todo ?? false }, async () => {
    const sessions = await sessionsOf(store, file);
    assert.equal(sessions.length, 1, "one session");
    const got = {};
    for (const key of Object.keys(expect)) got[key] = sessions[0][key];
    assert.deepEqual(got, expect);
  });
}

test("every fixture is under 40 lines", async () => {
  async function walk(dir) {
    const out = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.name.endsWith(".jsonl")) out.push(full);
    }
    return out;
  }
  for (const file of await walk(EDGE)) {
    const lines = (await fs.readFile(file, "utf8")).split("\n").length;
    assert.ok(lines < 40, `${path.relative(EDGE, file)} has ${lines} lines`);
  }
});

test("every fixture has no real-looking path", async () => {
  async function walk(dir) {
    const out = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    }
    return out;
  }
  for (const file of await walk(EDGE)) {
    if (file.endsWith(".md")) continue;
    const text = await fs.readFile(file, "utf8");
    for (const match of text.match(/\/Users\/[A-Za-z0-9_.-]+/g) ?? []) assert.equal(match, "/Users/example", file);
  }
});
