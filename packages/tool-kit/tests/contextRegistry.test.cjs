const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  deriveWorkContext,
  recordWorkContext,
  recordWorkContextAlias,
  readWorkContextRegistry
} = require("../out/index.js");

let root;
let saltFile;
let registryFile;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-registry-"));
  saltFile = path.join(root, "salt");
  registryFile = path.join(root, "work-contexts.json");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeWorktreeContext() {
  const repo = path.join(root, "repo-a");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "wt-one"), { recursive: true });
  const worktree = path.join(root, "wt-one");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "wt-one")}\n`);
  return deriveWorkContext(worktree, saltFile);
}

test("recording a context lands both hashes with their labels", () => {
  const context = makeWorktreeContext();
  const wrote = recordWorkContext(context, { registryFilePath: registryFile });
  assert.equal(wrote, true);

  const registry = readWorkContextRegistry(registryFile);
  assert.equal(registry.contexts[context.projectHash].label, "repo-a");
  assert.equal(registry.contexts[context.projectHash].kind, "project");
  assert.equal(registry.contexts[context.workspaceHash].label, "wt-one");
  assert.equal(registry.contexts[context.workspaceHash].kind, "workspace");
});

test("steady state is read-only: same context, same day, no write", () => {
  const context = makeWorktreeContext();
  recordWorkContext(context, { registryFilePath: registryFile });
  const wroteAgain = recordWorkContext(context, { registryFilePath: registryFile });
  assert.equal(wroteAgain, false);
});

test("a day boundary refreshes lastSeenAt", () => {
  const context = makeWorktreeContext();
  recordWorkContext(context, { registryFilePath: registryFile, now: new Date("2026-08-26T01:00:00Z") });
  const wrote = recordWorkContext(context, { registryFilePath: registryFile, now: new Date("2026-08-27T01:00:00Z") });
  assert.equal(wrote, true);
  const registry = readWorkContextRegistry(registryFile);
  assert.equal(registry.contexts[context.projectHash].lastSeenAt, "2026-08-27T01:00:00.000Z");
});

test("an alias records, and a later direct observation upgrades it without losing the path", () => {
  const wrote = recordWorkContextAlias("aaaa111122223333", "old-full-path-form", "/somewhere/repo-b", {
    registryFilePath: registryFile
  });
  assert.equal(wrote, true);
  assert.equal(readWorkContextRegistry(registryFile).contexts["aaaa111122223333"].kind, "alias");

  // A direct observation under the same digest (contrived, but the upgrade
  // rule is what's under test) takes over the kind and label.
  const context = {
    workspaceLabel: "repo-b",
    projectLabel: "repo-b",
    workspaceHash: "aaaa111122223333",
    projectHash: "aaaa111122223333",
    workspacePath: "/elsewhere/repo-b",
    projectPath: "/elsewhere/repo-b"
  };
  recordWorkContext(context, { registryFilePath: registryFile });
  const entry = readWorkContextRegistry(registryFile).contexts["aaaa111122223333"];
  assert.equal(entry.kind, "project");
  assert.equal(entry.label, "repo-b");
  assert.deepEqual(entry.paths.sort(), ["/elsewhere/repo-b", "/somewhere/repo-b"]);
});

test("an alias never overrides an observed label", () => {
  const context = makeWorktreeContext();
  recordWorkContext(context, { registryFilePath: registryFile });
  recordWorkContextAlias(context.projectHash, "misleading-name", null, { registryFilePath: registryFile });
  assert.equal(readWorkContextRegistry(registryFile).contexts[context.projectHash].label, "repo-a");
});

test("a corrupt registry file means a fresh start, not a crash", () => {
  const corrupt = path.join(root, "corrupt.json");
  fs.writeFileSync(corrupt, "{not json");
  const context = makeWorktreeContext();
  assert.equal(recordWorkContext(context, { registryFilePath: corrupt }), true);
  assert.equal(readWorkContextRegistry(corrupt).contexts[context.projectHash].label, "repo-a");
});

test("recording never throws on an unwritable path — hook hot path contract", () => {
  const context = makeWorktreeContext();
  const result = recordWorkContext(context, { registryFilePath: "/dev/null/impossible/registry.json" });
  assert.equal(result, false);
});
