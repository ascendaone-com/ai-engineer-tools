import { test } from "node:test";
import assert from "node:assert/strict";
import { inferOutcome, looksLikeCorrection, getString, getNestedString } from "../dist/safeExtract.js";

test("inferOutcome: exit codes across payload shapes", () => {
  assert.equal(inferOutcome({ exitCode: 0 }), "success");
  assert.equal(inferOutcome({ exit_code: 1 }), "failure");
  assert.equal(inferOutcome({ tool_response: { exitCode: 0 } }), "success");
  assert.equal(inferOutcome({ result: { exit_code: 3 } }), "failure");
});

test("inferOutcome: error strings and unknowns", () => {
  assert.equal(inferOutcome({ error: "boom" }), "failure");
  assert.equal(inferOutcome({ tool_response: { error: "nope" } }), "failure");
  assert.equal(inferOutcome({}), "unknown");
});

test("looksLikeCorrection: positive and negative phrases", () => {
  for (const t of ["that's wrong", "incorrect output", "try again please", "fix the import", "redo this", "it doesn't work"]) {
    assert.equal(looksLikeCorrection(t), true, t);
  }
  for (const t of ["add a new endpoint", "looks great, continue", "write tests for the parser", undefined, ""]) {
    assert.equal(looksLikeCorrection(t), false, String(t));
  }
});

test("getString / getNestedString: first non-empty wins", () => {
  assert.equal(getString({ a: "", b: "x" }, ["a", "b"]), "x");
  assert.equal(getString({}, ["a"]), undefined);
  assert.equal(getNestedString({ p: { q: "deep" } }, [["missing", "x"], ["p", "q"]]), "deep");
});
