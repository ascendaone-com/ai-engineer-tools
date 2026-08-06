const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classifyGitAction, isReworkGitAction } = require("../out/index.js");

test("classifyGitAction: the two boundary actions", () => {
  assert.equal(classifyGitAction("git commit -m 'fix the thing'"), "commit");
  assert.equal(classifyGitAction("git push origin main"), "push");
  assert.equal(classifyGitAction("git push"), "push");
});

test("classifyGitAction: amend is a rewrite, not a fresh boundary", () => {
  // Ordered ahead of plain commit deliberately. The reverse order would count
  // every amend as new progress, so the same work would be counted twice.
  assert.equal(classifyGitAction("git commit --amend --no-edit"), "amend");
  assert.equal(classifyGitAction("git commit --amend -m 'reword'"), "amend");
});

test("classifyGitAction: the reversion family", () => {
  assert.equal(classifyGitAction("git revert abc1234"), "revert");
  assert.equal(classifyGitAction("git reset --hard HEAD~1"), "reset_hard");
  assert.equal(classifyGitAction("git restore src/app.ts"), "restore");
  assert.equal(classifyGitAction("git checkout -- src/app.ts"), "restore");
});

test("classifyGitAction: resets that discard nothing are not rework", () => {
  // Soft and mixed resets move a pointer and leave the tree alone. Counting
  // them as reversions would report ordinary history tidying as lost work.
  assert.equal(classifyGitAction("git reset --soft HEAD~1"), undefined);
  assert.equal(classifyGitAction("git reset HEAD~1"), undefined);
  assert.equal(classifyGitAction("git reset"), undefined);
});

test("classifyGitAction: unstaging is not discarding", () => {
  // `git restore --staged` unstages; the changes survive.
  assert.equal(classifyGitAction("git restore --staged src/app.ts"), undefined);
});

test("classifyGitAction: switching branches is not a restore", () => {
  // Only the `--` form throws work away. A bare checkout moves between
  // branches, which is navigation.
  assert.equal(classifyGitAction("git checkout main"), undefined);
  assert.equal(classifyGitAction("git checkout -b feature/x"), undefined);
});

test("classifyGitAction: reading the repository says nothing", () => {
  for (const cmd of ["git status", "git log --oneline", "git diff", "git add .", "git fetch origin", "git stash list"]) {
    assert.equal(classifyGitAction(cmd), undefined, cmd);
  }
});

test("classifyGitAction: mentioning a command is not running it", () => {
  // The defect class fixed live in the milestone classifier (27 Jul 2026):
  // pattern-matching anywhere in the string classifies heredoc bodies and
  // quoted strings — data, not commands — as the command itself.
  const heredoc = [
    "cat <<'EOF' > notes.md",
    "Remember to git commit -m 'fix' and git push origin main.",
    "EOF"
  ].join("\n");
  assert.equal(classifyGitAction(heredoc), undefined);
  assert.equal(classifyGitAction("echo 'git push origin main'"), undefined);
  assert.equal(classifyGitAction('echo "git reset --hard HEAD~1"'), undefined);
});

test("classifyGitAction: a commit message naming another verb is still a commit", () => {
  assert.equal(classifyGitAction("git commit -m 'then git push'"), "commit");
  assert.equal(classifyGitAction("git commit -m 'not an --amend'"), "commit");
});

test("classifyGitAction: command position survives prefixes and separators", () => {
  assert.equal(classifyGitAction("cd x && git push origin main"), "push");
  assert.equal(classifyGitAction("GIT_DIR=/tmp/r git commit -m 'wip'"), "commit");
  assert.equal(classifyGitAction("git add . ; git commit --amend --no-edit"), "amend");
});

test("classifyGitAction: flags cannot cross segments to their verb", () => {
  // The reset here has no --hard of its own; the --hard belongs to a grep
  // argument in the next segment. Whole-string matching would upgrade it.
  assert.equal(classifyGitAction("git reset HEAD~1 && grep -r --hard docs"), undefined);
});

test("classifyGitAction: non-git and empty input", () => {
  assert.equal(classifyGitAction("npm test"), undefined);
  assert.equal(classifyGitAction(""), undefined);
  assert.equal(classifyGitAction(null), undefined);
  assert.equal(classifyGitAction(undefined), undefined);
});

test("isReworkGitAction: only the three that undo work", () => {
  assert.equal(isReworkGitAction("revert"), true);
  assert.equal(isReworkGitAction("reset_hard"), true);
  assert.equal(isReworkGitAction("restore"), true);

  assert.equal(isReworkGitAction("commit"), false);
  assert.equal(isReworkGitAction("push"), false);
  // Amend rewrites work rather than undoing it — it is neither a boundary
  // nor a reversion.
  assert.equal(isReworkGitAction("amend"), false);
  assert.equal(isReworkGitAction(undefined), false);
});
