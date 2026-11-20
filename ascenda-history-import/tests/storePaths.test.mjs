/**
 * `CLAUDE_CONFIG_DIR` and `CODEX_HOME` move the stores this importer reads.
 * Claude Code's variable may list several dirs, comma-separated, and each
 * entry may name the config dir or its `projects/` dir. Unset or empty, the
 * defaults under the home dir apply.
 */
import "./isolateHome.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { coworkProjectsDirsOf, resolveStorePaths } from "../dist/stores.js";
import { createStagingArea, snapshotPath } from "../dist/staging.js";
import { COWORK_SNAPSHOT_DIR, extractClaudeCode } from "../dist/extractors/claudeCode.js";
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

async function coworkHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-home-"));
  const root = path.join(home, "Library", "Application Support", "Claude", "local-agent-mode-sessions");
  const transcript = (id, cwd) =>
    [
      { type: "user", timestamp: "2026-07-20T10:00:00.000Z", sessionId: id, cwd, uuid: `${id}-u1`, message: { role: "user", content: "hello" } },
      { type: "assistant", timestamp: "2026-07-20T10:00:05.000Z", sessionId: id, cwd, uuid: `${id}-a1`, message: { id: `${id}-m1`, role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } } }
    ].map((l) => JSON.stringify(l)).join("\n") + "\n";
  const put = async (file, text) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const plain = path.join(root, "acct-1", "org-1", "local_one", ".claude", "projects", "-work-one", "cow00000-0000-0000-0000-000000000001.jsonl");
  const ditto = path.join(root, "acct-1", "org-1", "agent", "local_ditto_two", ".claude", "projects", "-work-two", "cow00000-0000-0000-0000-000000000002.jsonl");
  await put(plain, transcript("cow00000-0000-0000-0000-000000000001", "/work/one"));
  await put(ditto, transcript("cow00000-0000-0000-0000-000000000002", "/work/two"));
  await put(path.join(root, "acct-1", "org-1", "local_one", "audit.jsonl"), "{}\n");
  await put(path.join(root, "acct-1", "org-1", "local_one", "audit", ".claude", "projects", "-x", "z.jsonl"), "{}\n");
  await put(path.join(root, "claude-code-sessions", "acct-1", "org-1", "local_code.json"), "{}\n");
  await put(
    path.join(home, ".claude", "projects", "-work-main", "main0000-0000-0000-0000-000000000003.jsonl"),
    transcript("main0000-0000-0000-0000-000000000003", "/work/main")
  );
  return { home, root, plain, ditto };
}

test("Cowork projects dirs: both shapes, sorted, after ~/.claude, audit and manifests left out", async () => {
  const { home, root, plain, ditto } = await coworkHome();
  const expected = [path.dirname(path.dirname(ditto)), path.dirname(path.dirname(plain))].sort();
  const paths = resolveStorePaths(home, {}, "darwin");
  assert.equal(paths.claudeDesktopSessionsRoot, root);
  assert.deepEqual(paths.claudeCoworkProjectsDirs, expected);
  assert.deepEqual(paths.claudeProjectsDirs, [path.join(home, ".claude", "projects"), ...expected]);
  assert.deepEqual(paths.claudeConfigDirs, [path.join(home, ".claude")]);
  assert.ok(paths.claudeProjectsDirs.every((d) => !d.includes("audit")));
});

test("Cowork projects dirs are resolved on macOS only, and a missing root gives none", async () => {
  const { home, root } = await coworkHome();
  assert.deepEqual(coworkProjectsDirsOf(root, "linux"), []);
  assert.deepEqual(resolveStorePaths(home, {}, "win32").claudeProjectsDirs, [path.join(home, ".claude", "projects")]);
  assert.deepEqual(coworkProjectsDirsOf(path.join(home, "nowhere"), "darwin"), []);
});

test("Cowork walk stops at five levels", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-depth-"));
  const shallow = path.join(root, "a", "b", "c", ".claude", "projects");
  const deep = path.join(root, "a", "b", "c", "d", "e", ".claude", "projects");
  await fs.mkdir(shallow, { recursive: true });
  await fs.mkdir(deep, { recursive: true });
  assert.deepEqual(coworkProjectsDirsOf(root, "darwin"), [shallow]);
});

test("an extract over a home with Cowork sessions ships two with clientName", async () => {
  const { home } = await coworkHome();
  const paths = resolveStorePaths(home, {}, "darwin");
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-staging-"));
  const area = await createStagingArea(stagingRoot);
  for (const dir of paths.claudeProjectsDirs) {
    const cowork = paths.claudeCoworkProjectsDirs.includes(dir);
    await snapshotPath(area, dir, path.join("claude_code", cowork ? COWORK_SNAPSHOT_DIR : "projects"));
  }
  const events = [];
  for await (const e of extractClaudeCode(path.join(area.root, "claude_code"), area.extractionId)) events.push(e);
  const sessions = events.filter((e) => e.eventKind === "create_focus_session");
  assert.equal(sessions.length, 3);
  const cowork = sessions.filter((s) => s.metrics.clientName === "claude-desktop-cowork");
  assert.deepEqual(
    cowork.map((s) => s.sessionRef).sort(),
    ["cow00000-0000-0000-0000-000000000001", "cow00000-0000-0000-0000-000000000002"]
  );
  const main = sessions.find((s) => s.sessionRef === "main0000-0000-0000-0000-000000000003");
  assert.equal(main.metrics.clientName, undefined);
});
