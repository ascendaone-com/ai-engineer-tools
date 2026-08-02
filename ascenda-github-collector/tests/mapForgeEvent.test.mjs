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

test("closed, merged and reopened produce nothing", () => {
  // Deliberately narrow. A merge is someone else's decision as often as it is
  // yours, and none of these is the checking load this family is about.
  for (const action of ["closed", "reopened", "synchronize", "labeled"]) {
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
