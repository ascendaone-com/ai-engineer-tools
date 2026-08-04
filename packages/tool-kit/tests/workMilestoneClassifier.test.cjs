const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyWorkMilestone, invitesDebrief } = require("../out/index.js");

// The classifier (H1). Its job is to know when a *piece of work* ended, as
// opposed to when a keystroke boundary happened — the distinction Hamada's
// §5.3 note turns on. The cases lean hardest on what it must NOT claim,
// because a false milestone spends the user's attention on a moment that
// wasn't one.

test("a merged PR and a closed issue are completions", () => {
  assert.equal(classifyWorkMilestone("gh pr merge 412 --squash"), "pr_merged");
  assert.equal(classifyWorkMilestone("gh issue close 88"), "issue_closed");
});

test("opening a PR is a handoff, recorded but not a completion", () => {
  assert.equal(classifyWorkMilestone("gh pr create --fill"), "pr_opened");
  assert.equal(invitesDebrief("pr_opened"), false);
  assert.equal(invitesDebrief("pr_merged"), true);
  assert.equal(invitesDebrief("issue_closed"), true);
  assert.equal(invitesDebrief(undefined), false);
});

test("a command that opens and merges has ended at the merge", () => {
  assert.equal(
    classifyWorkMilestone("gh pr create --fill && gh pr merge --auto --squash"),
    "pr_merged"
  );
});

test("ordinary git work is never a milestone", () => {
  // These are boundaries — classifyGitAction's job — and happen many times
  // inside one piece of work. Treating them as milestones would fire a
  // debrief invitation several times an hour.
  for (const command of [
    "git commit -m 'wip'",
    "git push origin feature",
    "git merge origin/main",
    "git status"
  ]) {
    assert.equal(classifyWorkMilestone(command), undefined, command);
  }
});

test("reading about work is not finishing it", () => {
  // The verbs matter: `gh pr view`/`list`/`checkout` are inspection, and
  // `gh issue create` opens work rather than ending it.
  for (const command of [
    "gh pr view 412",
    "gh pr list --state merged",
    "gh pr checkout 412",
    "gh issue create --title 'bug'",
    "gh repo clone ascendaone-com/asc-core-be"
  ]) {
    assert.equal(classifyWorkMilestone(command), undefined, command);
  }
});

test("nothing in, nothing out", () => {
  assert.equal(classifyWorkMilestone(undefined), undefined);
  assert.equal(classifyWorkMilestone(null), undefined);
  assert.equal(classifyWorkMilestone(""), undefined);
});
