import "./isolateHome.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAccountKey } from "@ascenda-one/tool-kit";
import { mapClaudeEvent } from "../dist/mapClaudeEvent.js";

// A live event carries the key tool-kit derives for the folder this process
// runs under, and a different CLAUDE_CONFIG_DIR gives a different key.
const input = { session_id: "s1", cwd: process.cwd(), prompt: "hello" };

function keyUnder(dir) {
  const prior = process.env.CLAUDE_CONFIG_DIR;
  if (dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const events = mapClaudeEvent("SessionStart", { ...input, source: "startup" });
    return { event: events[0]?.metadata?.accountKey, expected: deriveAccountKey() };
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
  }
}

test("events carry the account key for the running config folder", () => {
  const work = keyUnder("/tmp/ascenda-acct-work");
  assert.ok(work.event);
  assert.equal(work.event, work.expected);
});

test("two config folders give two keys on events", () => {
  assert.notEqual(keyUnder("/tmp/ascenda-acct-a").event, keyUnder("/tmp/ascenda-acct-b").event);
});
