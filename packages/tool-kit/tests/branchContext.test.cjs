const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  deriveBranchHash,
  deriveBranchHashForCwd,
  normalizeBranchName,
  readBranchName,
  hashWithMachineSalt
} = require("../out/index.js");

// The contract under test is the branch half of the one frozen in
// workContext.ts: WHAT STRING GETS HASHED. A collector that hashes a ref path
// where another hashes a bare name splits one branch into two identities in
// stored rows, permanently — the same failure the workspace assertions guard.

let root;
let saltFile;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-branch-"));
  saltFile = path.join(root, "salt");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A primary checkout whose HEAD says exactly what `headContents` says. */
function makeCheckout(name, headContents) {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), headContents);
  return repo;
}

test("a ref path and a bare name are one branch, not two identities", () => {
  const bare = deriveBranchHash("feat/time-on-projects", saltFile);
  assert.match(bare, /^[0-9a-f]{16}$/);
  assert.equal(deriveBranchHash("refs/heads/feat/time-on-projects", saltFile), bare);
  assert.equal(deriveBranchHash("  refs/heads/feat/time-on-projects  ", saltFile), bare);
  // The name, never the ref path — this is the assertion that pins it.
  assert.equal(bare, hashWithMachineSalt("feat/time-on-projects", saltFile));
  assert.notEqual(bare, hashWithMachineSalt("refs/heads/feat/time-on-projects", saltFile));
});

test("nothing that names no branch produces a value", () => {
  // Absent, never blank and never a placeholder: an empty string is a value a
  // reader can group on, asserting a branch that does not exist.
  for (const input of [undefined, null, "", "   ", "HEAD", "refs/heads/", "refs/heads/   "]) {
    assert.equal(normalizeBranchName(input), null, `normalize(${JSON.stringify(input)})`);
    assert.equal(deriveBranchHash(input, saltFile), null, `hash(${JSON.stringify(input)})`);
  }
});

test("no readable salt means no field, never an unsalted digest", () => {
  // A salt path that cannot exist: a regular file stands where the directory
  // would have to be, so creating the salt throws rather than falling back.
  const blocker = path.join(root, "not-a-directory");
  fs.writeFileSync(blocker, "x");
  const unreachable = path.join(blocker, "salt");

  assert.equal(deriveBranchHash("main", unreachable), null);
  const repo = makeCheckout("repo-saltless", "ref: refs/heads/main\n");
  assert.equal(deriveBranchHashForCwd(repo, unreachable), null);
});

test("a primary checkout reports its own branch, from any depth", () => {
  const repo = makeCheckout("repo-a", "ref: refs/heads/main\n");
  assert.equal(readBranchName(repo), "main");
  assert.equal(readBranchName(path.join(repo, "src", "deep")), "main");
  assert.equal(deriveBranchHashForCwd(repo, saltFile), deriveBranchHash("main", saltFile));
});

test("a linked worktree reports ITS branch, not the parent repository's", () => {
  // Unlike projectHash, a worktree must not fold into its parent here: each
  // worktree has its own HEAD, and its own branch is the honest answer.
  const repo = makeCheckout("repo-b", "ref: refs/heads/main\n");
  const worktreeGitDir = path.join(repo, ".git", "worktrees", "fancy-name");
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feat/x\n");

  const worktree = path.join(root, "fancy-name");
  fs.mkdirSync(path.join(worktree, "lib"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

  assert.equal(readBranchName(path.join(worktree, "lib")), "feat/x");
  assert.equal(deriveBranchHashForCwd(worktree, saltFile), deriveBranchHash("feat/x", saltFile));
  assert.notEqual(deriveBranchHashForCwd(worktree, saltFile), deriveBranchHashForCwd(repo, saltFile));
});

test("a detached HEAD names no branch, so no field is produced", () => {
  const repo = makeCheckout("repo-detached", "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432\n");
  assert.equal(readBranchName(repo), null);
  assert.equal(deriveBranchHashForCwd(repo, saltFile), null);

  // Same for a detached worktree, which is how a bisect or a CI checkout looks.
  const parent = makeCheckout("repo-c", "ref: refs/heads/main\n");
  const worktreeGitDir = path.join(parent, ".git", "worktrees", "detached-wt");
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  const worktree = path.join(root, "detached-wt");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

  assert.equal(deriveBranchHashForCwd(worktree, saltFile), null);
});

test("a HEAD pointing outside refs/heads is not treated as a branch", () => {
  // Nothing normal produces this, but a tag or note ref must not be hashed as
  // though it were a branch name.
  const repo = makeCheckout("repo-oddref", "ref: refs/tags/v1.2.3\n");
  assert.equal(readBranchName(repo), null);
  assert.equal(deriveBranchHashForCwd(repo, saltFile), null);
});

test("outside a checkout, and on an unreadable HEAD, there is no branch", () => {
  const plain = path.join(root, "not-a-repo");
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(readBranchName(plain), null);
  assert.equal(readBranchName(""), null);
  assert.equal(readBranchName(null), null);

  // A checkout whose HEAD is missing degrades the same way it would if the
  // directory were gone: absent, not guessed.
  const repo = path.join(root, "repo-headless");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  assert.equal(readBranchName(repo), null);
  assert.equal(deriveBranchHashForCwd(repo, saltFile), null);
});

test("the digest is salted, so it is not recoverable from a branch dictionary", () => {
  const other = path.join(root, "salt-two");
  const unsalted = require("node:crypto").createHash("sha256").update("main").digest("hex").slice(0, 16);
  assert.notEqual(deriveBranchHash("main", saltFile), unsalted);
  assert.notEqual(deriveBranchHash("main", other), deriveBranchHash("main", saltFile));
});
