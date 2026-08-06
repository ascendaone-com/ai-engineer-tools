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

test("mentioning a milestone is not reaching one", () => {
  // Observed live on 27 Jul 2026: a heredoc whose *content* said
  // "gh pr merge 412" fired the debrief invitation mid-session, for a
  // milestone that never happened. Only command position may classify.
  const heredoc = [
    "cat <<'EOF' > notes.md",
    "Next step: gh pr merge 412 once CI is green.",
    "Then gh issue close 88.",
    "EOF"
  ].join("\n");
  assert.equal(classifyWorkMilestone(heredoc), undefined);

  // Quoted strings are data too, in either quote style.
  assert.equal(classifyWorkMilestone("echo 'gh issue close 88'"), undefined);
  assert.equal(classifyWorkMilestone('echo "gh pr merge 412 --squash"'), undefined);
  assert.equal(
    classifyWorkMilestone("git commit -m 'ready for gh pr merge'"),
    undefined
  );
});

test("command position survives prefixes and separators", () => {
  // The anchor must not be so tight that real invocations stop counting.
  assert.equal(classifyWorkMilestone("cd x && gh pr merge 412 --squash"), "pr_merged");
  assert.equal(classifyWorkMilestone("GH_TOKEN=abc gh pr merge 412"), "pr_merged");
  assert.equal(classifyWorkMilestone("git push origin main; gh issue close 88"), "issue_closed");
  // And a genuine merge whose own arguments contain quotes still counts:
  // stripping the quoted region must not unseat the verb at the head.
  assert.equal(
    classifyWorkMilestone('gh pr merge 412 --subject "merge: the big one"'),
    "pr_merged"
  );
});

test("nothing in, nothing out", () => {
  assert.equal(classifyWorkMilestone(undefined), undefined);
  assert.equal(classifyWorkMilestone(null), undefined);
  assert.equal(classifyWorkMilestone(""), undefined);
});
