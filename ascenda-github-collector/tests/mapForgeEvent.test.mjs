import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mapForgeEvent } from "../dist/mapForgeEvent.js";
import { forgeBranchKey, forgeRepoKey } from "@ascenda-one/tool-kit";

const ME = "octocat";
const repo = { full_name: "acme/payments-service" };

function prPayload(action, extra = {}) {
  return { action, repository: repo, pull_request: { user: { login: ME }, number: 42, title: "Fix the auth path" }, ...extra };
}

// ── first-person only ─────────────────────────────────────────────────────
//
// The rule these defend: "who reviews for whom" is a map of a team, and a
// wellbeing rail that assembles one has become a management tool. Every event
// must describe the viewer's own activity or produce nothing.

test("a PR I opened is mine to record", () => {
  const events = mapForgeEvent("pull_request", prPayload("opened"), ME);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "pull_request_opened");
});

test("a PR someone else opened produces nothing", () => {
  const payload = prPayload("opened");
  payload.pull_request.user.login = "someone-else";
  assert.deepEqual(mapForgeEvent("pull_request", payload, ME), []);
});

test("a review requested of me is checking load arriving", () => {
  const events = mapForgeEvent(
    "pull_request",
    prPayload("review_requested", { requested_reviewer: { login: ME } }),
    ME
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "review_requested_of_me");
});

test("a review requested of someone else is not my business", () => {
  const events = mapForgeEvent(
    "pull_request",
    prPayload("review_requested", { requested_reviewer: { login: "another-dev" } }),
    ME
  );
  assert.deepEqual(events, []);
});

test("a review I submitted is recorded; one I did not is not", () => {
  const mine = mapForgeEvent("pull_request_review", {
    action: "submitted", repository: repo, review: { user: { login: ME }, state: "approved", body: "lgtm" }
  }, ME);
  assert.equal(mine[0].eventType, "review_given");
  assert.equal(mine[0].metadata.outcome, "success");

  const theirs = mapForgeEvent("pull_request_review", {
    action: "submitted", repository: repo, review: { user: { login: "another-dev" }, state: "approved" }
  }, ME);
  assert.deepEqual(theirs, []);
});

test("changes requested is not scored as a failure", () => {
  // Asking for more work is not the reviewer failing at anything, and
  // borrowing "failure" would read as blame once aggregated.
  const events = mapForgeEvent("pull_request_review", {
    action: "submitted", repository: repo, review: { user: { login: ME }, state: "changes_requested" }
  }, ME);
  assert.equal(events[0].metadata.outcome, "unknown");
});

test("login comparison ignores case", () => {
  const events = mapForgeEvent("pull_request", prPayload("opened"), "OctoCat");
  assert.equal(events.length, 1);
});

// ── the viewer is configured, never the run's actor ───────────────────────
//
// The installation secrets belong to one person, but the workflow runs for
// everyone who touches the repository. These are the runs a colleague
// triggers, mapped with the paired person's configured login. Wiring the
// login to `github.actor` would hand each of them a matching viewer.

const BOB = "bob-colleague";

test("a colleague's PR emits nothing under my configured login", () => {
  const payload = prPayload("opened", { sender: { login: BOB } });
  payload.pull_request.user.login = BOB;
  assert.deepEqual(mapForgeEvent("pull_request", payload, ME), []);
});

test("a colleague's review emits nothing under my configured login", () => {
  const payload = {
    action: "submitted", repository: repo, sender: { login: BOB },
    pull_request: { user: { login: ME } },
    review: { user: { login: BOB }, state: "approved" }
  };
  // Even on my own PR: the review is Bob's work.
  assert.deepEqual(mapForgeEvent("pull_request_review", payload, ME), []);
});

test("a review a colleague requests of me is mine, though they triggered the run", () => {
  // The actor on review_requested is the requester. Only a configured login
  // can match the requested reviewer here.
  const payload = prPayload("review_requested", {
    sender: { login: BOB }, requested_reviewer: { login: ME }
  });
  payload.pull_request.user.login = BOB;
  const events = mapForgeEvent("pull_request", payload, ME);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "review_requested_of_me");
  assert.deepEqual(mapForgeEvent("pull_request", payload, BOB), []);
});

// ── what must never travel ────────────────────────────────────────────────

test("no repository name, PR title, number, or other login is emitted", () => {
  const cases = [
    mapForgeEvent("pull_request", prPayload("opened"), ME),
    mapForgeEvent("pull_request", prPayload("review_requested", { requested_reviewer: { login: ME }, sender: { login: "the-asker" } }), ME),
    mapForgeEvent("pull_request_review", {
      action: "submitted", repository: repo,
      review: { user: { login: ME }, state: "commented", body: "this needs a test" }
    }, ME)
  ].flat();

  assert.ok(cases.length >= 3);
  for (const event of cases) {
    const serialised = JSON.stringify(event.metadata);
    for (const secret of ["payments-service", "acme", "Fix the auth path", "42", "the-asker", "lgtm", "this needs a test", ME]) {
      assert.ok(!serialised.includes(secret), `${secret} leaked into ${serialised}`);
    }
  }
});

test("the repository is hashed, stable, and distinct per repo", () => {
  const a = mapForgeEvent("pull_request", prPayload("opened"), ME)[0].metadata.projectHash;
  const again = mapForgeEvent("pull_request", prPayload("opened"), ME)[0].metadata.projectHash;
  const other = mapForgeEvent("pull_request", {
    action: "opened", repository: { full_name: "acme/other-service" }, pull_request: { user: { login: ME } }
  }, ME)[0].metadata.projectHash;

  // Stable so "always the same repository" stays answerable; distinct so the
  // question is meaningful; opaque so it is answerable without naming it.
  assert.equal(a, again);
  assert.notEqual(a, other);
  assert.match(a, /^[0-9a-f]{8}$/);
});

// ── refusals and robustness ───────────────────────────────────────────────

test("without a viewer identity nothing is ever emitted", () => {
  // The collector cannot know whose activity it is looking at, so the only
  // safe output is none. Falling back to the payload's actor would silently
  // start recording other people.
  assert.deepEqual(mapForgeEvent("pull_request", prPayload("opened"), undefined), []);
  assert.deepEqual(mapForgeEvent("pull_request", prPayload("opened"), ""), []);
});

test("reopened, synchronize and labeled produce nothing", () => {
  // Deliberately narrow: none of these is the start or end of a pull request.
  for (const action of ["reopened", "synchronize", "labeled"]) {
    assert.deepEqual(mapForgeEvent("pull_request", prPayload(action), ME), [], action);
  }
});

test("withdrawal is not derivable — absence emits nothing", () => {
  // There is no "did not review" event and there must never be one: a quiet
  // week has too many innocent explanations to be machine-interpreted.
  assert.deepEqual(mapForgeEvent("schedule", { repository: repo }, ME), []);
  assert.deepEqual(mapForgeEvent("workflow_dispatch", {}, ME), []);
});

test("malformed payloads yield nothing rather than throwing", () => {
  // A telemetry mapper that crashes takes the user's CI step down with it.
  assert.deepEqual(mapForgeEvent("pull_request", {}, ME), []);
  assert.deepEqual(mapForgeEvent("pull_request", { action: "opened", pull_request: null }, ME), []);
  assert.deepEqual(mapForgeEvent("pull_request_review", { action: "submitted", review: "nonsense" }, ME), []);
  assert.deepEqual(mapForgeEvent(undefined, prPayload("opened"), ME), []);
});

test("a missing repository still emits, without a hash", () => {
  const events = mapForgeEvent("pull_request", { action: "opened", pull_request: { user: { login: ME } } }, ME);
  assert.equal(events.length, 1);
  // Absent, not an empty string: the field is omitted when unknown.
  assert.ok(!("projectHash" in events[0].metadata));
});

// ── the emitted project digest has not moved ──────────────────────────────
//
// The FNV-1a now lives in tool-kit, so a developer's own machine — which knows
// both this identity and its salted local one — can compute it and file the
// two together. That refactor is only safe if this step keeps emitting the
// exact strings it emitted before: rows already stored under them cannot be
// re-keyed. `shippedHash` is a verbatim copy of the implementation as it stood
// inside this file, kept here as the frozen witness.

function shippedHash(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

test("the emitted projectHash is byte-identical to what this step shipped before", () => {
  const fullNames = [
    "acme/payments-service",
    "ascendaone-com/ai-engineer-tools",
    "octocat/Hello-World",
    "a/b",
    "OWNER/REPO"
  ];
  for (const fullName of fullNames) {
    const events = mapForgeEvent(
      "pull_request",
      { action: "opened", repository: { full_name: fullName }, pull_request: { user: { login: ME } } },
      ME
    );
    assert.equal(events[0].metadata.projectHash, shippedHash(fullName), fullName);
  }
});

test("the digest for the default fixture is pinned to a literal", () => {
  const events = mapForgeEvent("pull_request", prPayload("opened"), ME);
  assert.equal(events[0].metadata.projectHash, "918128f5");
});

// ── closed and merged ─────────────────────────────────────────────────────

function joinPayload(action, pr = {}, repository = { ...repo, default_branch: "main" }) {
  return {
    action,
    repository,
    pull_request: {
      user: { login: ME },
      created_at: "2026-10-01T09:00:00Z",
      head: { ref: "feat/x", repo: repository },
      ...pr
    }
  };
}

test("my closed PR is a closed event with its window", () => {
  const events = mapForgeEvent("pull_request", joinPayload("closed", {
    merged: false, closed_at: "2026-10-03T10:30:00Z"
  }), ME);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "pull_request_closed");
  assert.equal(events[0].metadata.prCreatedAt, "2026-10-01T09:00:00.000Z");
  assert.equal(events[0].metadata.prClosedAt, "2026-10-03T10:30:00.000Z");
  assert.ok(!("prMergedAt" in events[0].metadata));
});

test("my merged PR is a merged event with all three times", () => {
  const events = mapForgeEvent("pull_request", joinPayload("closed", {
    merged: true, closed_at: "2026-10-03T10:30:00Z", merged_at: "2026-10-03T10:30:00Z"
  }), ME);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "pull_request_merged");
  assert.equal(events[0].metadata.prCreatedAt, "2026-10-01T09:00:00.000Z");
  assert.equal(events[0].metadata.prClosedAt, "2026-10-03T10:30:00.000Z");
  assert.equal(events[0].metadata.prMergedAt, "2026-10-03T10:30:00.000Z");
});

test("someone else's closed or merged PR emits nothing", () => {
  const payload = joinPayload("closed", { merged: true, closed_at: "2026-10-03T10:30:00Z" });
  payload.pull_request.user.login = "someone-else";
  assert.deepEqual(mapForgeEvent("pull_request", payload, ME), []);
});

test("an opened PR carries its creation time and no end", () => {
  const [event] = mapForgeEvent("pull_request", joinPayload("opened"), ME);
  assert.equal(event.metadata.prCreatedAt, "2026-10-01T09:00:00.000Z");
  assert.ok(!("prClosedAt" in event.metadata));
});

test("an unreadable time is left off, not guessed", () => {
  const [event] = mapForgeEvent("pull_request", joinPayload("opened", { created_at: "yesterday" }), ME);
  assert.ok(!("prCreatedAt" in event.metadata));
});

// ── the join keys ─────────────────────────────────────────────────────────

test("a same-repository PR carries the repository and head branch keys", () => {
  const [event] = mapForgeEvent("pull_request", joinPayload("opened"), ME);
  assert.equal(event.metadata.repoKey, forgeRepoKey("acme/payments-service"));
  assert.equal(event.metadata.branchKey, forgeBranchKey("acme/payments-service", "feat/x"));
  assert.ok(!("headRepoKey" in event.metadata));
});

test("every PR event carries the keys, reviews included", () => {
  const closed = mapForgeEvent("pull_request", joinPayload("closed", { merged: true }), ME)[0];
  const requested = mapForgeEvent("pull_request", { ...joinPayload("review_requested"), requested_reviewer: { login: ME } }, ME)[0];
  const reviewed = mapForgeEvent("pull_request_review", {
    ...joinPayload("submitted"), review: { user: { login: ME }, state: "approved" }
  }, ME)[0];
  for (const event of [closed, requested, reviewed]) {
    assert.equal(event.metadata.repoKey, forgeRepoKey("acme/payments-service"));
    assert.equal(event.metadata.branchKey, forgeBranchKey("acme/payments-service", "feat/x"));
  }
});

test("a fork PR keys the branch by the fork, and adds the fork's repository key", () => {
  // A contributor's clone has the fork as `origin`, so that is the name its
  // sessions hash.
  const fork = { full_name: "octocat/payments-service", default_branch: "main" };
  const payload = joinPayload("opened", { head: { ref: "fix/auth", repo: fork } });
  const [event] = mapForgeEvent("pull_request", payload, ME);
  assert.equal(event.metadata.repoKey, forgeRepoKey("acme/payments-service"));
  assert.equal(event.metadata.headRepoKey, forgeRepoKey("octocat/payments-service"));
  assert.equal(event.metadata.branchKey, forgeBranchKey("octocat/payments-service", "fix/auth"));
});

test("a deleted fork leaves the branch key off", () => {
  const payload = joinPayload("closed", { merged: true, head: { ref: "fix/auth", repo: null } });
  const [event] = mapForgeEvent("pull_request", payload, ME);
  assert.equal(event.metadata.repoKey, forgeRepoKey("acme/payments-service"));
  assert.ok(!("branchKey" in event.metadata));
  assert.ok(!("headRepoKey" in event.metadata));
});

test("a reused branch name gives the same key, so the window has to separate the PRs", () => {
  const first = mapForgeEvent("pull_request", joinPayload("closed", {
    merged: true, head: { ref: "fix", repo: repo }, created_at: "2026-09-01T09:00:00Z",
    closed_at: "2026-09-02T09:00:00Z", merged_at: "2026-09-02T09:00:00Z"
  }), ME)[0].metadata;
  const second = mapForgeEvent("pull_request", joinPayload("closed", {
    merged: false, head: { ref: "fix", repo: repo }, created_at: "2026-10-05T09:00:00Z",
    closed_at: "2026-10-06T09:00:00Z"
  }), ME)[0].metadata;
  assert.equal(first.branchKey, second.branchKey);
  assert.equal(first.repoKey, second.repoKey);
  assert.ok(first.prClosedAt < second.prCreatedAt, "the two windows do not overlap");
});

test("no branch key when the head branch is the default branch", () => {
  const payload = joinPayload("opened", { head: { ref: "main", repo: { ...repo, default_branch: "main" } } });
  const [event] = mapForgeEvent("pull_request", payload, ME);
  assert.equal(event.metadata.repoKey, forgeRepoKey("acme/payments-service"));
  assert.ok(!("branchKey" in event.metadata));
});

test("a fork's own default branch is its default, not the upstream's", () => {
  const upstream = { ...repo, default_branch: "main" };
  const fork = { full_name: "octocat/payments-service", default_branch: "trunk" };
  const onTrunk = mapForgeEvent("pull_request", joinPayload("opened", { head: { ref: "trunk", repo: fork } }, upstream), ME)[0];
  assert.ok(!("branchKey" in onTrunk.metadata));
  // `main` is an ordinary branch on that fork, and its clone's sessions send a key for it.
  const onMain = mapForgeEvent("pull_request", joinPayload("opened", { head: { ref: "main", repo: fork } }, upstream), ME)[0];
  assert.equal(onMain.metadata.branchKey, forgeBranchKey("octocat/payments-service", "main"));
});

test("only github.com gets keys", () => {
  const enterprise = { ...repo, html_url: "https://git.example.com/acme/payments-service", default_branch: "main" };
  const [event] = mapForgeEvent("pull_request", joinPayload("opened", { head: { ref: "feat/x", repo: enterprise } }, enterprise), ME);
  assert.ok(!("repoKey" in event.metadata));
  assert.ok(!("branchKey" in event.metadata));
  const github = { ...repo, html_url: "https://github.com/acme/payments-service", default_branch: "main" };
  const [onGithub] = mapForgeEvent("pull_request", joinPayload("opened", { head: { ref: "feat/x", repo: github } }, github), ME);
  assert.equal(onGithub.metadata.repoKey, forgeRepoKey("acme/payments-service"));
});

test("the opt-out drops every new key and keeps the times", () => {
  const fork = { full_name: "octocat/payments-service", default_branch: "main" };
  const events = [
    mapForgeEvent("pull_request", joinPayload("opened", { head: { ref: "fix/auth", repo: fork } }), ME, { repoKeys: false })[0],
    mapForgeEvent("pull_request", joinPayload("closed", { merged: true, merged_at: "2026-10-03T10:30:00Z", head: { ref: "fix/auth", repo: fork } }), ME, { repoKeys: false })[0]
  ];
  for (const event of events) {
    for (const key of ["repoKey", "branchKey", "headRepoKey"]) assert.ok(!(key in event.metadata), key);
    assert.match(event.metadata.projectHash, /^[0-9a-f]{8}$/);
  }
  assert.equal(events[1].metadata.prMergedAt, "2026-10-03T10:30:00.000Z");
});

test("no branch name or fork name travels as text", () => {
  const fork = { full_name: "octocat/payments-service", default_branch: "main" };
  const [event] = mapForgeEvent("pull_request", joinPayload("opened", { head: { ref: "fix/auth", repo: fork } }), ME);
  const serialised = JSON.stringify(event.metadata);
  for (const secret of ["fix/auth", "octocat", "payments-service", "acme"]) {
    assert.ok(!serialised.includes(secret), `${secret} leaked into ${serialised}`);
  }
});

// ── the hooks' side of the join ───────────────────────────────────────────
//
// A session and a pull request only join if both sides hash the same strings.
// This builds the clone a contributor would have and asks the hooks' own
// derivation what it sends.

test("a session in a fork clone sends the keys the fork PR carries", async () => {
  process.env.ASCENDA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-collector-home-"));
  const { deriveForgeKeysForCwd } = await import("@ascenda-one/tool-kit");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-fork-clone-"));
  fs.mkdirSync(path.join(root, ".git", "refs", "remotes", "origin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/fix/auth\n");
  fs.writeFileSync(
    path.join(root, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:octocat/payments-service.git\n[remote "upstream"]\n\turl = git@github.com:acme/payments-service.git\n'
  );
  fs.writeFileSync(path.join(root, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/main\n");
  const session = deriveForgeKeysForCwd(root);

  const fork = { full_name: "octocat/payments-service", default_branch: "main" };
  const [pr] = mapForgeEvent("pull_request", joinPayload("opened", { head: { ref: "fix/auth", repo: fork } }), ME);
  assert.equal(session.branchKey, pr.metadata.branchKey);
  assert.equal(session.repoKey, pr.metadata.headRepoKey);
});
