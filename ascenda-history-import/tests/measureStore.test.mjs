import "./isolateHome.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateCorpus } from "./support/corpus.mjs";
import { writeCorpus } from "./support/corpusRun.mjs";
import { resolveStorePaths } from "../dist/stores.js";
import { measureStore, formatMeasurements } from "../scripts/measure-store.mjs";

// The measuring script reads a developer's own stores. Here it reads a
// generated one, where the answers are known, and its output is checked for
// anything that isn't a count.

async function homeWith(store, options) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "measure-"));
  const { files } = generateCorpus({ seed: 5, sessions: 6, store, ...options });
  await writeCorpus(files, path.join(home, store === "claude_code" ? ".claude" : ".codex"));
  return home;
}

test("measures repeated lines, fork sidecars and lines per message on a Claude store", async () => {
  const plain = await homeWith("claude_code", { shape: [] });
  const shaped = await homeWith("claude_code", { shape: ["resumeReplay", "forkedSubagent", "multiLineMessages"] });
  try {
    const before = await measureStore(resolveStorePaths(plain, {}));
    const after = await measureStore(resolveStorePaths(shaped, {}));
    assert.equal(before.claude.repeatedUuids.repeatedLines, 0);
    assert.equal(before.claude.forkSidecars.isFork, 0);
    assert.equal(before.claude.linesPerMessage.ratio, 1);
    assert.ok(after.claude.repeatedUuids.repeatedLines > 0);
    assert.equal(after.claude.repeatedUuids.transcriptsAffected, 6);
    assert.equal(after.claude.forkSidecars.isFork, 6);
    assert.ok(after.claude.forkSidecars.sidecars >= 6);
    assert.ok(after.claude.linesPerMessage.ratio > 1);
  } finally {
    await fs.rm(plain, { recursive: true, force: true });
    await fs.rm(shaped, { recursive: true, force: true });
  }
});

test("counts ids two transcripts claim, on a resumed copy that rewrote its sessionId", async () => {
  const home = await homeWith("claude_code", { shape: ["resumeCopy"] });
  try {
    const { claude } = await measureStore(resolveStorePaths(home, {}));
    assert.ok(claude.contestedIds.contestedIds > 0);
    assert.equal(claude.contestedIds.transcriptsHoldingOne, 6, "three parents and their three copies");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("counts rollouts present in both Codex roots", async () => {
  const home = await homeWith("codex", { shape: ["archivedCopy"] });
  try {
    const { codex } = await measureStore(resolveStorePaths(home, {}));
    assert.equal(codex.inBothRoots, 2, "sessions 0 and 3 of 6");
    assert.equal(codex.archived, 2);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("prints counts and nothing else", async () => {
  const home = await homeWith("claude_code", { shape: ["resumeReplay", "resumeCopy", "forkedSubagent"] });
  try {
    const text = formatMeasurements(await measureStore(resolveStorePaths(home, {})), "2026-03-02");
    assert.equal(text.split("\n").length, 7);
    assert.ok(!text.includes("/"), "no path");
    assert.ok(!text.includes(home));
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(text), "no id");
    assert.ok(!text.includes("lorem"), "no content");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
