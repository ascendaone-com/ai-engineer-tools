/**
 * The posture ladder, on the read side where it belongs.
 *
 * These tests exist to pin one property above all others: this band is
 * derived, and the wire is not. If anything ever emits an `AutonomyBand`, the
 * collapse of `auto` and `dont_ask` becomes permanent in an append-only
 * corpus, and the question "do those two differ?" becomes unanswerable for
 * every row already written. Derived here, it stays a query away.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { autonomyBand } = require("../out/index.js");

test("every wire token has a band, most supervised first", () => {
  assert.equal(autonomyBand("plan"), "planning");
  assert.equal(autonomyBand("default"), "supervised");
  assert.equal(autonomyBand("accept_edits"), "edits_auto");
  assert.equal(autonomyBand("auto"), "delegated");
  assert.equal(autonomyBand("dont_ask"), "delegated");
  assert.equal(autonomyBand("bypass_permissions"), "unsupervised");
});

/**
 * The pair the whole vocabulary change exists for. They share a band today —
 * that judgement is not wrong, it is simply a *reader's* — and because the
 * wire kept them apart, a query that disagrees can still separate them.
 */
test("auto and dont_ask share a band, and the tokens they came from do not", () => {
  assert.equal(autonomyBand("auto"), autonomyBand("dont_ask"));
  assert.notEqual("auto", "dont_ask");
});

test("the retired ladder's own words are not tokens, and do not band as if they were", () => {
  // The band names and the wire tokens are two vocabularies on purpose. A row
  // written by an older collector holding `supervised` in `autonomyMode` would
  // be a bug, and it must surface as `unknown` rather than round-trip and hide.
  for (const retired of ["supervised", "edits_auto", "delegated", "unsupervised", "planning"]) {
    assert.equal(autonomyBand(retired), "unknown", `retired rung ${retired}`);
  }
});

test("total: a future token, an absent key and a non-string all yield unknown", () => {
  assert.equal(autonomyBand("unknown"), "unknown");
  assert.equal(autonomyBand("someFutureMode"), "unknown");
  assert.equal(autonomyBand(undefined), "unknown");
  assert.equal(autonomyBand(null), "unknown");
  assert.equal(autonomyBand(7), "unknown");
  assert.equal(autonomyBand({}), "unknown");
});
