const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deriveWorkContext, hashWithMachineSalt } = require("../out/index.js");

// The contract under test is the one frozen in workContext.ts: what string
// gets hashed. These assertions are the collector-agreement guarantee — if
// one fails after a refactor, the same repo is about to start splitting into
// several identities in stored rows.

let root;
let saltFile;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-workcontext-"));
  saltFile = path.join(root, "salt");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makePrimaryCheckout(name) {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
  return repo;
}

test("primary checkout: workspace and project are both the checkout, from any depth", () => {
  const repo = makePrimaryCheckout("repo-a");
  const context = deriveWorkContext(path.join(repo, "src", "deep"), saltFile);

  assert.equal(context.workspaceLabel, "repo-a");
  assert.equal(context.projectLabel, "repo-a");
  assert.equal(context.workspacePath, repo);
  assert.equal(context.projectPath, repo);
  assert.equal(context.workspaceHash, hashWithMachineSalt("repo-a", saltFile));
  assert.equal(context.projectHash, context.workspaceHash);
});

test("linked worktree: workspace is the worktree folder, project folds into the parent repo", () => {
  const repo = makePrimaryCheckout("repo-b");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "fancy-name"), { recursive: true });
  const worktree = path.join(root, "fancy-name");
  fs.mkdirSync(path.join(worktree, "lib"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "fancy-name")}\n`);

  const context = deriveWorkContext(path.join(worktree, "lib"), saltFile);

  assert.equal(context.workspaceLabel, "fancy-name");
  assert.equal(context.projectLabel, "repo-b");
  assert.equal(context.projectPath, repo);
  assert.equal(context.projectHash, hashWithMachineSalt("repo-b", saltFile));
  assert.notEqual(context.workspaceHash, context.projectHash);
});

test("a worktree under .claude/worktrees inside the repo folds the same way", () => {
  const repo = makePrimaryCheckout("repo-c");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "quizzical-thompson"), { recursive: true });
  const worktree = path.join(repo, ".claude", "worktrees", "quizzical-thompson");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "quizzical-thompson")}\n`);

  const context = deriveWorkContext(worktree, saltFile);

  assert.equal(context.workspaceLabel, "quizzical-thompson");
  assert.equal(context.projectLabel, "repo-c");
});

test("a path that no longer exists degrades to basenames — the importer's dead-repo case", () => {
  const context = deriveWorkContext(path.join(root, "gone", "repo-a"), saltFile);

  assert.equal(context.workspaceLabel, "repo-a");
  assert.equal(context.projectLabel, "repo-a");
  assert.equal(context.projectPath, null);
  // The agreement that matters: a deleted checkout of repo-a and a live one
  // still carry the same project digest.
  assert.equal(context.projectHash, hashWithMachineSalt("repo-a", saltFile));
});

test("outside git entirely: the folder is its own workspace and project", () => {
  const plain = path.join(root, "not-a-repo");
  fs.mkdirSync(plain, { recursive: true });
  const context = deriveWorkContext(plain, saltFile);

  assert.equal(context.workspaceLabel, "not-a-repo");
  assert.equal(context.projectLabel, "not-a-repo");
});

test("empty input passes through as null", () => {
  assert.equal(deriveWorkContext(null, saltFile), null);
  assert.equal(deriveWorkContext("", saltFile), null);
  assert.equal(deriveWorkContext("   ", saltFile), null);
});

test("trailing separators do not change identity", () => {
  const repo = makePrimaryCheckout("repo-d");
  const bare = deriveWorkContext(repo, saltFile);
  const trailed = deriveWorkContext(`${repo}//`, saltFile);
  assert.equal(bare.workspaceHash, trailed.workspaceHash);
});
