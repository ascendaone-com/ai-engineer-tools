import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { forgeBranchKey, forgeRepoKey } from "@ascenda-one/tool-kit";
import { mapClaudeEvent, readPromptId } from "../dist/mapClaudeEvent.js";

// What a pull request is matched on: the same pair of keys the code-forge
// collector computes, stamped on every event from the payload's own cwd.

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-forge-"));
  process.env.ASCENDA_REPO_KEYS = "on";
});
after(() => {
  process.env.ASCENDA_REPO_KEYS = "off";
  fs.rmSync(root, { recursive: true, force: true });
});

function makeCheckout(name, branch, remote) {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(repo, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
  fs.writeFileSync(path.join(repo, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/main\n");
  return repo;
}

test("every event carries both keys for a feature branch", () => {
  const repo = makeCheckout("payments", "feat/x", "git@github.com:acme/payments.git");
  for (const hook of ["PreToolUse", "Stop", "Notification"]) {
    const [event] = mapClaudeEvent(hook, { cwd: repo, session_id: "s1" });
    assert.equal(event.metadata.repoKey, forgeRepoKey("acme/payments"), hook);
    assert.equal(event.metadata.branchKey, forgeBranchKey("acme/payments", "feat/x"), hook);
  }
});

test("the same session on another branch carries that branch's key", () => {
  const repo = makeCheckout("payments-two", "feat/y", "git@github.com:acme/payments.git");
  const [event] = mapClaudeEvent("PreToolUse", { cwd: repo });
  assert.equal(event.metadata.branchKey, forgeBranchKey("acme/payments", "feat/y"));
});

test("the default branch carries the repository key and no branch key", () => {
  const repo = makeCheckout("payments-main", "main", "git@github.com:acme/payments.git");
  const [event] = mapClaudeEvent("PreToolUse", { cwd: repo });
  assert.equal(event.metadata.repoKey, forgeRepoKey("acme/payments"));
  assert.equal("branchKey" in event.metadata, false);
});

test("another forge, or no remote, carries neither key", () => {
  const [elsewhere] = mapClaudeEvent("PreToolUse", { cwd: makeCheckout("gl", "feat/x", "https://gitlab.com/acme/payments.git") });
  assert.equal("repoKey" in elsewhere.metadata, false);
  assert.equal("branchKey" in elsewhere.metadata, false);
});

test("the prompt id is passed on when it looks like an id and dropped when it doesn't", () => {
  const repo = makeCheckout("prompts", "feat/x", "git@github.com:acme/payments.git");
  const [event] = mapClaudeEvent("PreToolUse", { cwd: repo, prompt_id: "4b1f6a52-0c47-49d3-a2c9-ad2f7c7a10aa" });
  assert.equal(event.metadata.promptId, "4b1f6a52-0c47-49d3-a2c9-ad2f7c7a10aa");
  assert.equal(readPromptId({ prompt_id: "has spaces and /slashes" }), undefined);
  assert.equal(readPromptId({ prompt_id: "x".repeat(129) }), undefined);
  assert.equal(readPromptId({ prompt_id: 7 }), undefined);
  assert.equal(readPromptId({}), undefined);
});

test("the switch turns them off", () => {
  const repo = makeCheckout("switched-off", "feat/x", "git@github.com:acme/payments.git");
  process.env.ASCENDA_REPO_KEYS = "off";
  try {
    const [event] = mapClaudeEvent("PreToolUse", { cwd: repo });
    assert.equal("repoKey" in event.metadata, false);
    assert.equal("branchKey" in event.metadata, false);
  } finally {
    process.env.ASCENDA_REPO_KEYS = "on";
  }
});

test("the permission events carry the keys too", () => {
  const repo = makeCheckout("permissions", "feat/x", "git@github.com:acme/payments.git");
  for (const hook of ["PermissionRequest", "PermissionDenied"]) {
    const [event] = mapClaudeEvent(hook, { cwd: repo, tool_name: "Bash" });
    assert.equal(event.metadata.repoKey, forgeRepoKey("acme/payments"), hook);
    assert.equal(event.metadata.branchKey, forgeBranchKey("acme/payments", "feat/x"), hook);
  }
});
