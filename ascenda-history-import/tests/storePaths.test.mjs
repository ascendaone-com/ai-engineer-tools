/**
 * `CLAUDE_CONFIG_DIR` and `CODEX_HOME` move the stores this importer reads.
 * Claude Code's variable may list several dirs, comma-separated, and each
 * entry may name the config dir or its `projects/` dir. Unset or empty, the
 * defaults under the home dir apply.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { resolveStorePaths } from "../dist/stores.js";
import { scanClaudeCode, scanCodex } from "../dist/scan.js";
import { defaultArchiveSources } from "../dist/archive.js";

const HOME = path.join(os.tmpdir(), "store-paths-home");

test("unset or empty variables leave the defaults", () => {
  for (const env of [{}, { CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" }, { CLAUDE_CONFIG_DIR: " , " }]) {
    const paths = resolveStorePaths(HOME, env);
    assert.equal(paths.claudeRoot, path.join(HOME, ".claude"));
    assert.deepEqual(paths.claudeProjectsDirs, [path.join(HOME, ".claude", "projects")]);
    assert.equal(paths.codexRoot, path.join(HOME, ".codex"));
  }
});

test("CODEX_HOME moves both Codex roots", () => {
  const codex = path.join(os.tmpdir(), "codex-elsewhere");
  const paths = resolveStorePaths(HOME, { CODEX_HOME: codex });
  assert.equal(paths.codexRoot, codex);
  assert.equal(paths.codexSessions, path.join(codex, "sessions"));
  assert.equal(paths.codexArchivedSessions, path.join(codex, "archived_sessions"));
});

test("CLAUDE_CONFIG_DIR takes a list of config dirs or projects dirs, deduped, first one primary", () => {
  const work = path.join(os.tmpdir(), "claude-work");
  const personal = path.join(os.tmpdir(), "claude-personal");
  const paths = resolveStorePaths(HOME, {
    CLAUDE_CONFIG_DIR: ` ${work} ,${path.join(personal, "projects")},${work},~/claude-third`
  });
  assert.deepEqual(paths.claudeConfigDirs, [work, personal, path.join(HOME, "claude-third")]);
  assert.deepEqual(paths.claudeProjectsDirs, [
    path.join(work, "projects"),
    path.join(personal, "projects"),
    path.join(HOME, "claude-third", "projects")
  ]);
  assert.equal(paths.claudeRoot, work);
  assert.equal(paths.claudeProjects, path.join(work, "projects"));
  assert.equal(paths.claudeSettings, path.join(work, "settings.json"));

  const labels = defaultArchiveSources(paths)
    .filter((s) => s.store === "claude_code")
    .map((s) => s.label);
  assert.deepEqual(labels, ["projects", "projects-2", "projects-3"]);
});

test("scan reads every listed Claude Code dir and skips one that isn't there", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "claude-dirs-"));
  const a = path.join(base, "a");
  const b = path.join(base, "b");
  await fs.mkdir(path.join(a, "projects", "-work-repo-a"), { recursive: true });
  await fs.mkdir(path.join(b, "projects", "-work-repo-b"), { recursive: true });
  await fs.writeFile(path.join(a, "projects", "-work-repo-a", "s1.jsonl"), "{}\n");
  await fs.writeFile(path.join(b, "projects", "-work-repo-b", "s2.jsonl"), "{}\n");
  await fs.writeFile(path.join(b, "projects", "-work-repo-b", "s3.jsonl"), "{}\n");

  const paths = resolveStorePaths(HOME, {
    CLAUDE_CONFIG_DIR: [a, path.join(b, "projects"), path.join(base, "missing")].join(",")
  });
  const inv = await scanClaudeCode(paths);
  assert.equal(inv.present, true);
  assert.equal(inv.counts.projects, 2);
  assert.equal(inv.counts.transcripts, 3);

  const none = await scanClaudeCode(resolveStorePaths(HOME, { CLAUDE_CONFIG_DIR: path.join(base, "missing") }));
  assert.equal(none.present, false);
});

test("scan finds Codex rollouts under CODEX_HOME", async () => {
  const codex = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-env-"));
  const dir = path.join(codex, "sessions", "2026", "08", "03");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "rollout-a.jsonl"), "x\n");
  const inv = await scanCodex(resolveStorePaths(HOME, { CODEX_HOME: codex }));
  assert.equal(inv.present, true);
  assert.equal(inv.counts.rollouts, 1);
});
