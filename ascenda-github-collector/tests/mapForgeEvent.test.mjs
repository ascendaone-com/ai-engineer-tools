import { test } from "node:test";
import assert from "node:assert/strict";
import { mapForgeEvent } from "../dist/mapForgeEvent.js";

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

test("reopened, synchronize and labeled produce nothing, and closing is only ever my own PR's", () => {
  // Deliberately narrow. A merge is someone else's decision as often as it is
  // yours, so the merger is never read. What is recorded is that a pull request
  // of mine ended, and only when I opened it. Someone else's closing nothing.
  for (const action of ["reopened", "synchronize", "labeled"]) {
    assert.deepEqual(mapForgeEvent("pull_request", prPayload(action), ME), [], action);
  }
  const theirs = prPayload("closed");
  theirs.pull_request.user.login = "someone-else";
  assert.deepEqual(mapForgeEvent("pull_request", theirs, ME), []);
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

// ── matching a pull request to a session ───────────────────────────────────

import { forgeBranchKey, forgeRepoKey } from "@ascenda-one/tool-kit";

function ownPr(action, over = {}) {
  return {
    action,
    repository: repo,
    pull_request: {
      user: { login: ME },
      number: 42,
      title: "Fix the auth path",
      merged: false,
      created_at: "2026-10-10T01:00:00Z",
      closed_at: "2026-10-12T05:30:00Z",
      merged_at: null,
      head: { ref: "feat/auth", repo: { full_name: "acme/payments-service", default_branch: "main" } },
      base: { ref: "main", repo: { full_name: "acme/payments-service" } },
      ...over
    }
  };
}

test("an opened PR carries the keys a session on its branch carries", () => {
  const [event] = mapForgeEvent("pull_request", ownPr("opened"), ME);
  assert.equal(event.metadata.repoKey, forgeRepoKey("acme/payments-service"));
  assert.equal(event.metadata.branchKey, forgeBranchKey("acme/payments-service", "feat/auth"));
  assert.equal("headRepoKey" in event.metadata, false, "the head is the base repository");
});

test("a merged PR of mine is recorded with its times, whoever merged it", () => {
  const [event] = mapForgeEvent("pull_request", ownPr("closed", { merged: true, merged_at: "2026-10-12T05:30:00Z", merged_by: { login: "a-colleague" } }), ME);
  assert.equal(event.eventType, "pull_request_merged");
  assert.equal(event.metadata.prCreatedAt, "2026-10-10T01:00:00.000Z");
  assert.equal(event.metadata.prClosedAt, "2026-10-12T05:30:00.000Z");
  assert.equal(event.metadata.prMergedAt, "2026-10-12T05:30:00.000Z");
  assert.doesNotMatch(JSON.stringify(event), /a-colleague/);
});

test("a PR of mine closed without merging says so and has no merge time", () => {
  const [event] = mapForgeEvent("pull_request", ownPr("closed"), ME);
  assert.equal(event.eventType, "pull_request_closed");
  assert.equal("prMergedAt" in event.metadata, false);
  assert.equal(event.metadata.prClosedAt, "2026-10-12T05:30:00.000Z");
});

test("someone else's PR closing or merging produces nothing", () => {
  const theirs = ownPr("closed", { merged: true, user: { login: "someone-else" } });
  assert.deepEqual(mapForgeEvent("pull_request", theirs, ME), []);
});

test("a PR from a fork is keyed by the fork and names it", () => {
  const fork = { full_name: "octocat/payments-service", default_branch: "main" };
  const [event] = mapForgeEvent("pull_request", ownPr("opened", { head: { ref: "feat/auth", repo: fork } }), ME);
  assert.equal(event.metadata.repoKey, forgeRepoKey("acme/payments-service"));
  assert.equal(event.metadata.headRepoKey, forgeRepoKey("octocat/payments-service"));
  assert.equal(event.metadata.branchKey, forgeBranchKey("octocat/payments-service", "feat/auth"));
});

test("a deleted fork falls back to the base repository for the branch key", () => {
  const [event] = mapForgeEvent("pull_request", ownPr("opened", { head: { ref: "feat/auth", repo: null } }), ME);
  assert.equal(event.metadata.branchKey, forgeBranchKey("acme/payments-service", "feat/auth"));
  assert.equal("headRepoKey" in event.metadata, false);
});

test("no branch key from the head repository's default branch", () => {
  const [event] = mapForgeEvent("pull_request", ownPr("opened", { head: { ref: "main", repo: { full_name: "octocat/payments-service", default_branch: "main" } } }), ME);
  assert.equal("branchKey" in event.metadata, false);
  assert.equal(event.metadata.repoKey, forgeRepoKey("acme/payments-service"));
});

test("a time GitHub didn't send, or sent badly, is left off", () => {
  const [event] = mapForgeEvent("pull_request", ownPr("closed", { created_at: "yesterday", closed_at: undefined }), ME);
  assert.equal("prCreatedAt" in event.metadata, false);
  assert.equal("prClosedAt" in event.metadata, false);
});

test("neither the branch name nor the number nor the title is on what's sent", () => {
  for (const action of ["opened", "closed"]) {
    const sent = JSON.stringify(mapForgeEvent("pull_request", ownPr(action, { merged: true, merged_at: "2026-10-12T05:30:00Z" }), ME));
    for (const secret of ["feat/auth", "payments-service", "Fix the auth path", "42"]) {
      assert.equal(sent.includes(secret), false, `${secret} leaked in ${action}`);
    }
  }
});
