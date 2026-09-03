import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveBranchHash } from "@ascenda-one/tool-kit";
import { mapCodexEvent } from "../dist/mapCodexEvent.js";

// Same anchor as the Claude adapter's branchHash test: this adapter must call
// the one derivation in tool-kit, not a second copy of the rule, so a Codex
// row joins a Claude Code row and an imported row on the same digest.

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-codex-branch-"));
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

  for (const [hook, payload] of [
    ["SessionStart", { source: "startup", cwd: repo }],
    ["UserPromptSubmit", { prompt: "do the thing", cwd: repo }],
    ["PreToolUse", { tool_name: "Bash", cwd: repo }]
  ]) {
    const events = mapCodexEvent(hook, payload);
    assert.ok(events.length > 0, hook);
    for (const event of events) assert.equal(event.metadata.branchHash, expected, hook);
  }
  // The host tag the adapter already stamped is still there — the branch
  // stamp adds to the metadata rather than replacing it.
  assert.equal(mapCodexEvent("UserPromptSubmit", { prompt: "x", cwd: repo })[0].metadata.host, "codex");
});

test("a worktree reports its own branch, and a detached HEAD reports none", () => {
  const repo = makeCheckout("parent-repo", "ref: refs/heads/main\n");
  const gitDir = path.join(repo, ".git", "worktrees", "wt");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feat/x\n");
  const worktree = path.join(root, "wt");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  assert.equal(
    mapCodexEvent("UserPromptSubmit", { prompt: "hi", cwd: worktree })[0].metadata.branchHash,
    deriveBranchHash("feat/x")
  );

  const detached = makeCheckout("detached-repo", "0123456789abcdef0123456789abcdef01234567\n");
  const [event] = mapCodexEvent("UserPromptSubmit", { prompt: "hi", cwd: detached });
  assert.equal("branchHash" in event.metadata, false);
});
