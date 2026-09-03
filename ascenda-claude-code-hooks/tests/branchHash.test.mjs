import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveBranchHash } from "@ascenda-one/tool-kit";
import { mapClaudeEvent } from "../dist/mapClaudeEvent.js";

// The join these assertions protect: a live row and an imported row from the
// same branch must carry the same digest, or the two corpora cannot be pooled.
// It is not testable end to end from one process — the machine salt differs
// per isolated test home, so a digest from this package and one from the
// importer's tests are unrelated by construction. What IS testable, and what
// the guarantee actually rests on, is that both sides call the one derivation
// in tool-kit rather than a second copy: this file pins the hook path to
// `deriveBranchHash`, and the importer's own `branchHash.test.mjs` pins its
// path to the same function. Equality follows from the shared anchor.

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-branch-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeCheckout(name, head) {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), head);
  return repo;
}

test("every mapped event carries the branch digest for the payload's own cwd", () => {
  const repo = makeCheckout("live-repo", "ref: refs/heads/feat/time-on-projects\n");
  const expected = deriveBranchHash("feat/time-on-projects");
  assert.match(expected, /^[0-9a-f]{16}$/);

  // Three different hooks, so the stamp is shown to be on the whole result
  // rather than on one mapping that happens to have been remembered.
  for (const [hook, payload] of [
    ["SessionStart", { source: "startup", cwd: repo }],
    ["UserPromptSubmit", { prompt: "do the thing", cwd: repo }],
    ["PreToolUse", { tool_name: "Bash", cwd: repo }]
  ]) {
    const events = mapClaudeEvent(hook, payload);
    assert.ok(events.length > 0, hook);
    for (const event of events) assert.equal(event.metadata.branchHash, expected, hook);
  }
});

test("a ref path in HEAD and the bare name are the same identity", () => {
  const repo = makeCheckout("ref-repo", "ref: refs/heads/main\n");
  const [event] = mapClaudeEvent("UserPromptSubmit", { prompt: "hi", cwd: repo });
  assert.equal(event.metadata.branchHash, deriveBranchHash("main"));
  assert.equal(event.metadata.branchHash, deriveBranchHash("refs/heads/main"));
});

test("a worktree reports its own branch, not the repository's", () => {
  const repo = makeCheckout("parent-repo", "ref: refs/heads/main\n");
  const gitDir = path.join(repo, ".git", "worktrees", "wt");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feat/x\n");
  const worktree = path.join(root, "wt");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);

  const [event] = mapClaudeEvent("UserPromptSubmit", { prompt: "hi", cwd: worktree });
  assert.equal(event.metadata.branchHash, deriveBranchHash("feat/x"));
});

test("a detached HEAD omits the key entirely — no blank, no placeholder", () => {
  const repo = makeCheckout("detached-repo", "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432\n");
  const [event] = mapClaudeEvent("UserPromptSubmit", { prompt: "hi", cwd: repo });
  assert.equal("branchHash" in event.metadata, false);
  // The rest of the metadata is unaffected — absence is a missing key, not a
  // suppressed event.
  assert.equal(event.metadata.host, "claude_code");
});

test("a cwd outside any checkout omits the key", () => {
  const plain = path.join(root, "not-a-repo");
  fs.mkdirSync(plain, { recursive: true });
  const [event] = mapClaudeEvent("UserPromptSubmit", { prompt: "hi", cwd: plain });
  assert.equal("branchHash" in event.metadata, false);
});

test("the branch name itself never reaches the mapped event", () => {
  const repo = makeCheckout("secret-repo", "ref: refs/heads/feat/acme-migration\n");
  const events = mapClaudeEvent("UserPromptSubmit", { prompt: "hi", cwd: repo });
  assert.equal(JSON.stringify(events).includes("acme-migration"), false);
});
