const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  defaultStateFilePath,
  readCollectorState,
  recordSendOutcome,
  shouldAnnounceFailure,
  markFailureNotified
} = require("../out/index.js");

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-state-"));
  return { dir, file: path.join(dir, "nested", "claude_code_abc.json") };
}

const ID = "claude_code:abc-123";

test("a success is recorded, not just a failure", () => {
  // The whole point of the journal. If only failures were written, an absent
  // file would mean both "healthy" and "never ran" — the ambiguity that made
  // the original outage undebuggable.
  const { dir, file } = scratch();
  const state = recordSendOutcome(file, ID, "accepted", { httpStatus: 200 });

  assert.equal(state.lastOutcome, "accepted");
  assert.equal(state.consecutiveFailures, 0);
  assert.ok(state.lastSuccessAt, "a success must stamp lastSuccessAt");
  assert.equal(state.lastAttemptAt, state.lastSuccessAt);
  assert.deepEqual(readCollectorState(file), state, "must round-trip through disk");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("failures accumulate and keep the last success", () => {
  const { dir, file } = scratch();
  const ok = recordSendOutcome(file, ID, "accepted");
  const first = recordSendOutcome(file, ID, "auth_failed", { httpStatus: 401, errorCode: "invalid_token" });
  const second = recordSendOutcome(file, ID, "auth_failed", { httpStatus: 401 });

  assert.equal(first.consecutiveFailures, 1);
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(second.lastSuccessAt, ok.lastSuccessAt, "'when did it last work' must survive failures");
  assert.equal(second.httpStatus, 401);
  assert.equal(first.errorCode, "invalid_token");
  assert.equal(first.failingSince, second.failingSince, "one episode, one start time");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a success closes the episode and clears the failure marks", () => {
  const { dir, file } = scratch();
  recordSendOutcome(file, ID, "transport_error", { httpStatus: 503 });
  const recovered = recordSendOutcome(file, ID, "accepted", { httpStatus: 200 });

  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.failingSince, undefined);
  assert.equal(recovered.notifiedFailingSince, undefined);
  assert.equal(shouldAnnounceFailure(recovered), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the notice fires once per episode, not once per call", () => {
  // Several hundred failing tool calls must not produce several hundred lines.
  const { dir, file } = scratch();
  recordSendOutcome(file, ID, "accepted");

  const first = recordSendOutcome(file, ID, "consent_missing", { httpStatus: 403 });
  assert.equal(shouldAnnounceFailure(first), true, "the first failure of an episode announces");

  markFailureNotified(file, first);
  assert.equal(shouldAnnounceFailure(readCollectorState(file)), false, "already announced");

  const later = recordSendOutcome(file, ID, "consent_missing", { httpStatus: 403 });
  assert.equal(later.consecutiveFailures, 2);
  assert.equal(shouldAnnounceFailure(later), false, "same episode must stay quiet");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a new episode after a recovery announces again", () => {
  const { dir, file } = scratch();
  const first = recordSendOutcome(file, ID, "auth_failed");
  markFailureNotified(file, first);
  recordSendOutcome(file, ID, "accepted");

  const fresh = recordSendOutcome(file, ID, "auth_failed");
  assert.equal(shouldAnnounceFailure(fresh), true, "a genuinely new outage is worth one new line");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("shouldAnnounceFailure tolerates a missing journal", () => {
  assert.equal(shouldAnnounceFailure(undefined), false);
});

test("a corrupt journal reads as no journal rather than throwing", () => {
  const { dir, file } = scratch();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{not json");
  assert.equal(readCollectorState(file), undefined);

  // And it must be recoverable: the next send overwrites it cleanly.
  const state = recordSendOutcome(file, ID, "accepted");
  assert.equal(state.lastOutcome, "accepted");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writes are atomic and leave no temp file behind", () => {
  const { dir, file } = scratch();
  recordSendOutcome(file, ID, "accepted");
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, [], "a half-written journal would read back as no journal at all");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unwritable journal path costs the record, not the caller", () => {
  // The hook path must survive a read-only home directory.
  const state = recordSendOutcome(path.join(os.devNull, "nope", "state.json"), ID, "accepted");
  assert.equal(state.lastOutcome, "accepted", "the outcome is still returned to the caller");
});

test("detail is collapsed and bounded", () => {
  const { dir, file } = scratch();
  const state = recordSendOutcome(file, ID, "transport_error", { detail: `a\n\n  b${"x".repeat(500)}` });
  assert.ok(state.detail.length <= 200, "a verbose upstream must not bloat the journal");
  assert.ok(!state.detail.includes("\n"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("defaultStateFilePath lives under ~/.ascenda/state and sanitises the id", () => {
  const p = defaultStateFilePath("claude_code:abc-123");
  assert.ok(p.includes(path.join(".ascenda", "state")));
  assert.equal(path.basename(p), "claude_code_abc-123.json");
});
