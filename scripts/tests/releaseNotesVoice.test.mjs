import { test } from "node:test";
import assert from "node:assert/strict";

import { voiceFindings, reportFindings } from "../release-notes-voice.mjs";

const rules = (body) => voiceFindings(body).map((f) => f.rule);
const errors = (body) => voiceFindings(body).filter((f) => f.level === "error").map((f) => f.rule);

const CLEAN = `- **Handoffs carry a gap rule.** Each one names the idle gap that cut
  its minutes, so two figures can be compared before they are added. Run
  \`history-import import\` to get it.
- **Cursor and VS Code are unaffected.** Neither hands over a timeline, so
  neither carries the key. Nothing you have already imported changes.
- **The schema is the same otherwise.** Every existing key means what it
  meant. Older readers skip the new one.`;

test("prose that varies its shape has nothing to report", () => {
  assert.deepEqual(voiceFindings(CLEAN), []);
});

test("a budget, not a ban: one contrast frame is how anyone writes", () => {
  const one = `${CLEAN}\n- The union is taken once rather than added afterwards.`;
  assert.ok(!errors(one).includes("contrast-frames"));
});

test("contrast frames past the budget fail the release", () => {
  const body = Array.from(
    { length: 6 },
    (_, i) => `- Point ${i} now unions the figures rather than adding them.`
  ).join("\n");
  assert.ok(errors(body).includes("contrast-frames"));
});

test("em dashes are counted against the section's length", () => {
  const body = "- One — two — three — four, in a section this short.";
  assert.ok(errors(body).includes("em-dashes"));
});

test("three bullets opening the same way read as a filled template", () => {
  const body = [
    "- Your week now names what it could not see, and says so plainly.",
    "- Your week now counts a session on each day that it worked.",
    "- Your week now opens as one report. Short and readable.",
  ].join("\n");
  assert.ok(errors(body).includes("repeated-opener"));
});

test("a section with no short sentence is flagged; one rescues it", () => {
  const long = Array.from(
    { length: 4 },
    () => "- This sentence carries eleven or more words so that the rule has something to catch."
  ).join("\n");
  assert.ok(errors(long).includes("no-short-sentence"));
  assert.ok(!errors(`${long}\n- Nothing else moved.`).includes("no-short-sentence"));
});

test("code fences and inline code are not prose", () => {
  const body = "- A rule.\n\n```\nrather than rather than rather than rather than\n```\n\n- Short one.";
  assert.deepEqual(errors(body), []);
});

test("AI vocabulary warns without stopping a release", () => {
  const found = voiceFindings(`${CLEAN}\n- It leverages a robust, seamless path.`);
  const vocab = found.find((f) => f.rule === "ai-vocabulary");
  assert.equal(vocab.level, "warn");
  assert.match(vocab.message, /leverages, robust, seamless/);
});

test("reportFindings stops on an error and passes on warnings alone", () => {
  const said = [];
  const log = (line) => said.push(line);
  assert.equal(reportFindings([{ level: "warn", rule: "r", message: "m" }], { tag: "v1", log }), true);
  assert.equal(reportFindings([{ level: "error", rule: "r", message: "m" }], { tag: "v1", log }), false);
  assert.match(said.at(-1), /1 voice rule failed for v1/);
});
