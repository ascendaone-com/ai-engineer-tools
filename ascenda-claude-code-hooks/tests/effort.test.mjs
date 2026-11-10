import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapClaudeEvent, sentEffortLevel } from "../dist/mapClaudeEvent.js";

// Claude Code puts `effort: { level }` on every hook payload (see the captured
// fixtures in examples/). The mapper sends it on the session's opening event
// and again only when it changes, so a session that moves from medium to high
// shows exactly two values.

const examples = new URL("../examples/", import.meta.url);
const fixture = async (name) => JSON.parse(await readFile(new URL(name, examples), "utf8"));

const start = (level) => ({ hook_event_name: "SessionStart", session_id: "s-effort", source: "startup", model: "claude-opus-5-5", ...(level ? { effort: { level } } : {}) });
const prompt = (level) => ({ hook_event_name: "UserPromptSubmit", session_id: "s-effort", prompt: "go", ...(level ? { effort: { level } } : {}) });

test("SessionStart sends the level and its class beside the model pair", () => {
  const [event] = mapClaudeEvent("SessionStart", start("medium"));
  assert.equal(event.eventType, "create_focus_session");
  assert.equal(event.metadata.effortLevel, "medium");
  assert.equal(event.metadata.effortClass, "medium");
  assert.equal(event.metadata.modelClass, "anthropic:opus");
});

test("SessionStart sends even when the level matches the last one sent", () => {
  const [event] = mapClaudeEvent("SessionStart", start("high"), { lastSentEffortLevel: "high" });
  assert.equal(event.metadata.effortLevel, "high");
});

test("captured fixtures: effort.level is read off the real payload shape", async () => {
  const bash = await fixture("sample-post-tool-use-bash-test-ok.json");
  const [first] = mapClaudeEvent("PostToolUse", bash);
  assert.equal(first.metadata.effortLevel, "high");
  assert.equal(first.metadata.effortClass, "high");

  const failure = await fixture("sample-post-tool-use-failure.json");
  const failed = mapClaudeEvent("PostToolUseFailure", failure);
  assert.equal(failed[0].metadata.effortLevel, "high");
  // Only the first event of a batch carries it.
  for (const event of failed.slice(1)) assert.ok(!("effortLevel" in event.metadata), event.eventType);
});

test("an unchanged level after the session opened sends nothing", async () => {
  const bash = await fixture("sample-post-tool-use-bash-test-ok.json");
  const events = mapClaudeEvent("PostToolUse", bash, { lastSentEffortLevel: "high" });
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.ok(!("effortLevel" in event.metadata));
    assert.ok(!("effortClass" in event.metadata));
  }
  assert.equal(sentEffortLevel(events), undefined);
});

test("a mid-session change: medium at open, switched to high, two values in all", () => {
  // Plays a session through the mapper the way the CLI does, carrying the
  // last-sent level from one hook to the next.
  const hooks = [
    ["SessionStart", start("medium")],
    ["UserPromptSubmit", prompt("medium")],
    ["UserPromptSubmit", prompt("medium")],
    ["UserPromptSubmit", prompt("high")],
    ["UserPromptSubmit", prompt("high")]
  ];
  let lastSent;
  const sent = [];
  for (const [name, payload] of hooks) {
    const events = mapClaudeEvent(name, payload, { lastSentEffortLevel: lastSent });
    for (const event of events) {
      if ("effortLevel" in event.metadata) sent.push([event.eventType, event.metadata.effortLevel, event.metadata.effortClass]);
    }
    lastSent = sentEffortLevel(events) ?? lastSent;
  }
  assert.deepEqual(sent, [
    ["create_focus_session", "medium", "medium"],
    ["ai_prompt_submitted", "high", "high"]
  ]);
});

test("a first level seen after open goes out on the next event, with no prior value", () => {
  // A SessionStart without effort (or one the gate skipped) leaves nothing
  // recorded, so the first payload that carries a level sends it.
  const [opening] = mapClaudeEvent("SessionStart", start(undefined));
  assert.ok(!("effortLevel" in opening.metadata));
  const [event] = mapClaudeEvent("UserPromptSubmit", prompt("xhigh"));
  assert.equal(event.metadata.effortLevel, "xhigh");
  assert.equal(event.metadata.effortClass, "xhigh");
});

test("both keys or neither: absent, empty and blank effort send no keys", () => {
  for (const payload of [start(undefined), { ...start(undefined), effort: {} }, { ...start(undefined), effort: { level: "  " } }, { ...start(undefined), effort: null }]) {
    const [event] = mapClaudeEvent("SessionStart", payload);
    assert.ok(!("effortLevel" in event.metadata));
    assert.ok(!("effortClass" in event.metadata));
  }
});

test("an unmapped level keeps its raw string and reads unknown", () => {
  const [event] = mapClaudeEvent("SessionStart", start(" Ultra "));
  assert.equal(event.metadata.effortLevel, "Ultra");
  assert.equal(event.metadata.effortClass, "unknown");
});

test("the transcript's bare-string form is read too", () => {
  const [event] = mapClaudeEvent("SessionStart", { source: "startup", effort: "low" });
  assert.equal(event.metadata.effortLevel, "low");
  assert.equal(event.metadata.effortClass, "low");
});

test("a hook that maps to nothing carries no effort, so the change waits", () => {
  // StopFailure is live-signal only. The level it carried isn't recorded as
  // sent, so the next mapped event still sees it as a change.
  assert.deepEqual(mapClaudeEvent("StopFailure", { effort: { level: "high" } }), []);
  const [event] = mapClaudeEvent("UserPromptSubmit", prompt("high"), { lastSentEffortLevel: "medium" });
  assert.equal(event.metadata.effortLevel, "high");
});

// End to end through the built CLI on an unpaired install, so the last-sent
// level really goes through the state directory between hook processes.
test("cli: the state file carries the last-sent level between hooks, and SessionEnd clears it", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-effort-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const log = path.join(root, "events.jsonl");
  const env = { ...process.env, HOME: home, ASCENDA_HOME: path.join(home, ".ascenda"), ASCENDA_TOOL_INSTALLATION_ID: "", ASCENDA_EVENT_WRITE_TOKEN: "", ASCENDA_EVENT_LOG_FILE: log };
  const run = (args, input = "") => spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 30_000, input, cwd: root, env });
  try {
    assert.equal(run(["setup", "--no-pair", "--scope", "user", "--project-dir", project]).status, 0);
    const hook = (name, payload) => {
      const result = run([name], JSON.stringify({ session_id: "s-cli", cwd: project, hook_event_name: name, ...payload }));
      assert.equal(result.status, 0, result.stderr);
    };
    hook("SessionStart", { source: "startup", effort: { level: "medium" } });
    hook("UserPromptSubmit", { prompt: "one", effort: { level: "medium" } });
    hook("UserPromptSubmit", { prompt: "two", effort: { level: "high" } });
    hook("UserPromptSubmit", { prompt: "three", effort: { level: "high" } });

    const levels = fs.readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line))
      .map((entry) => entry.metadata?.effortLevel ?? entry.event?.metadata?.effortLevel ?? entry.payload?.metadata?.effortLevel)
      .filter(Boolean);
    assert.deepEqual(levels, ["medium", "high"]);

    const stateFile = path.join(home, ".ascenda", "state", "claude-effort-s-cli");
    assert.equal(fs.readFileSync(stateFile, "utf8"), "high");
    hook("SessionEnd", { reason: "prompt_input_exit", effort: { level: "high" } });
    assert.equal(fs.existsSync(stateFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
