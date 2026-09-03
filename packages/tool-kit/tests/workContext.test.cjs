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

// ── The dead-path fallback ──────────────────────────────────────────────
// A session's last hooks fire after Claude Code has removed its worktree,
// and the importer replays cwds of worktrees long gone. Without inference
// each of those froze into stored rows as its own project: on one real
// machine 77 of 86 Claude project labels were worktree names.

test("dead .claude/worktrees path folds into the parent repo, from any depth", () => {
  const live = makePrimaryCheckout("repo-e");
  const gone = path.join(root, "elsewhere", "repo-e", ".claude", "worktrees", "sweet-wiles-0f5525", "src", "deep");
  const context = deriveWorkContext(gone, saltFile);

  assert.equal(context.workspaceLabel, "sweet-wiles-0f5525");
  assert.equal(context.projectLabel, "repo-e");
  assert.equal(context.workspacePath, path.join(root, "elsewhere", "repo-e", ".claude", "worktrees", "sweet-wiles-0f5525"));
  assert.equal(context.projectPath, path.join(root, "elsewhere", "repo-e"));
  // The agreement that matters: the deleted worktree and the live repo carry
  // the same project digest, so the rows do not split.
  assert.equal(context.projectHash, deriveWorkContext(live, saltFile).projectHash);
  assert.notEqual(context.workspaceHash, context.projectHash);
});

test("dead <repo>-wt/<name> and <repo>-worktrees/<name> siblings fold into <repo>", () => {
  const wt = deriveWorkContext(path.join(root, "gone", "repo-f-wt", "metric-unit-split", "lib"), saltFile);
  assert.equal(wt.workspaceLabel, "metric-unit-split");
  assert.equal(wt.projectLabel, "repo-f");
  assert.equal(wt.projectPath, path.join(root, "gone", "repo-f"));
  assert.equal(wt.workspacePath, path.join(root, "gone", "repo-f-wt", "metric-unit-split"));

  const wts = deriveWorkContext(path.join(root, "gone", "repo-f-worktrees", "handoff-real-home"), saltFile);
  assert.equal(wts.projectLabel, "repo-f");
  assert.equal(wts.projectHash, wt.projectHash);
});

test("a live path still wins over its shape: the disk answer is authoritative", () => {
  // A primary checkout whose folder happens to be named like a worktree
  // sibling is its own project — inference is only for paths the disk
  // cannot answer for.
  const repo = makePrimaryCheckout("repo-g-wt");
  const context = deriveWorkContext(path.join(repo, "src"), saltFile);
  assert.equal(context.projectLabel, "repo-g-wt");
  assert.equal(context.projectPath, repo);
});

test("a dead path with no worktree convention still degrades to its basename", () => {
  const context = deriveWorkContext(path.join(root, "gone", "feature-x"), saltFile);
  assert.equal(context.workspaceLabel, "feature-x");
  assert.equal(context.projectLabel, "feature-x");
  assert.equal(context.projectPath, null);
});

test("the bare suffix is not a convention: '-wt' alone is a folder, not a parent", () => {
  const context = deriveWorkContext(path.join(root, "gone", "-wt", "name"), saltFile);
  assert.equal(context.projectLabel, "name");
  assert.equal(context.projectPath, null);
});

test("windows-style dead worktree path folds with its own separators", () => {
  const context = deriveWorkContext("C:\\Users\\x\\Dev\\repo-h\\.claude\\worktrees\\bold-ellis-d5c6fd\\src", saltFile);
  assert.equal(context.workspaceLabel, "bold-ellis-d5c6fd");
  assert.equal(context.projectLabel, "repo-h");
  assert.equal(context.projectPath, "C:\\Users\\x\\Dev\\repo-h");
});
