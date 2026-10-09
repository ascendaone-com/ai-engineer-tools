/**
 * The local live bus from Claude Code — in particular `awaiting`, the one
 * beat that is not work. Without it a permission dialog read as a running
 * tool call (PreToolUse fires before the dialog opens) until the app's stale
 * window ran out, and Away Mode held the Mac awake for a question nobody was
 * there to answer.
 *
 * Guarded in three layers, the order they can break in: the mapping; the
 * vocabulary against what the app's `LiveSignal.tryParse` accepts; and the
 * built CLI end to end on a real socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { liveEventFor, notificationAwaitsPerson } from "../dist/liveEvent.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../dist/cli.js");

/**
 * What `LiveSignal.tryParse` in `apps/macos/lib/src/flow/live_demand.dart`
 * accepts. Two-sided pin with the same list in every adapter's live-signal
 * test; turn them all around together.
 */
const APP_PARSES = ["prompt_submitted", "tool_call", "compaction", "tool_failure", "stop", "awaiting", "halted"];

const notification = (fields) => ({ hook_event_name: "Notification", session_id: "s1", ...fields });

test("the mapping, hook by hook", () => {
  assert.equal(liveEventFor("UserPromptSubmit", { prompt: "x" }), "prompt_submitted");
  assert.equal(liveEventFor("PreToolUse", { tool_name: "Bash" }), "tool_call");
  assert.equal(liveEventFor("PreCompact", {}), "compaction");
  assert.equal(liveEventFor("PostToolUseFailure", { error: "boom" }), "tool_failure");
  assert.equal(liveEventFor("Stop", {}), "stop");
  assert.equal(liveEventFor("StopFailure", { error: "rate_limit" }), "halted");
  // A session closed mid-turn sends no stop. Without this it stayed lit
  // until it went stale.
  assert.equal(liveEventFor("SessionEnd", { reason: "prompt_input_exit" }), "halted");
  for (const hook of ["SessionStart", "PostToolUse", "PostCompact"]) {
    assert.equal(liveEventFor(hook, {}), undefined, `${hook} must stay silent`);
  }
});

test("every event this adapter can emit is one the app parses", () => {
  const emitted = [
    liveEventFor("UserPromptSubmit", {}),
    liveEventFor("PreToolUse", { tool_name: "Bash" }),
    liveEventFor("PreToolUse", { tool_name: "AskUserQuestion" }),
    liveEventFor("PreCompact", {}),
    liveEventFor("PostToolUseFailure", {}),
    liveEventFor("Stop", {}),
    liveEventFor("StopFailure", {}),
    liveEventFor("Notification", notification({ notification_type: "permission_prompt" })),
    liveEventFor("Notification", notification({ notification_type: "idle_prompt" }))
  ];
  for (const event of emitted) assert.ok(APP_PARSES.includes(event), `${event} would be dropped by the app`);
});

test("AskUserQuestion is awaiting, in place of tool_call — the question is the person's move", () => {
  assert.equal(liveEventFor("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [] } }), "awaiting");
  // Only that tool. A name that merely contains it is not it.
  assert.equal(liveEventFor("PreToolUse", { tool_name: "mcp__x__AskUserQuestionLater" }), "tool_call");
});

test("a Notification is awaiting only when Claude Code says it is waiting on the person", () => {
  for (const kind of ["permission_prompt", "elicitation_dialog"]) {
    assert.equal(liveEventFor("Notification", notification({ notification_type: kind })), "awaiting", kind);
  }
  // Not every notification is a wait, and an unknown kind is not guessed into
  // one: a false awaiting tells Away Mode the work is parked.
  assert.equal(liveEventFor("Notification", notification({ notification_type: "auth_success" })), undefined);
  assert.equal(liveEventFor("Notification", notification({ notification_type: "something_new", message: "Claude needs your permission" })), undefined);
});

test("the idle prompt is halted, not awaiting: the turn is over and nothing is parked on the person", () => {
  assert.equal(liveEventFor("Notification", notification({ notification_type: "idle_prompt" })), "halted");
  assert.equal(liveEventFor("Notification", notification({ message: "Claude is waiting for your input" })), "halted");
  assert.equal(notificationAwaitsPerson(notification({ notification_type: "idle_prompt" })), false);
});

test("nothing this adapter maps emits stop_failure", () => {
  const hooks = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact", "Stop", "StopFailure", "Notification", "SessionEnd"];
  const inputs = [{}, { error: "rate_limit" }, { tool_name: "AskUserQuestion" }, ...["permission_prompt", "idle_prompt", "elicitation_dialog", "auth_success"].map((k) => notification({ notification_type: k }))];
  for (const hook of hooks) for (const input of inputs) {
    assert.notEqual(liveEventFor(hook, input), "stop_failure", `${hook} ${JSON.stringify(input)}`);
  }
});

test("older builds with no notification_type fall back to the same wording the cloud classifier reads", () => {
  assert.equal(notificationAwaitsPerson(notification({ message: "Claude needs your permission to use Bash" })), true);
  assert.equal(notificationAwaitsPerson(notification({ message: "Claude is waiting for your input" })), false);
  assert.equal(notificationAwaitsPerson(notification({ message: "Something entirely new" })), false);
  assert.equal(notificationAwaitsPerson(notification({})), false);
});

/** Reads newline-delimited JSON off a throwaway socket while the CLI runs. */
async function withListener(run) {
  // Short directory on purpose: sockaddr_un caps the path at ~104 bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asc"));
  const socketPath = path.join(dir, "l.sock");
  const lines = [];
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) lines.push(JSON.parse(line));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    return await run(socketPath, lines);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function settle(lines, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (lines.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function runHook(hook, input, socketPath) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-live-home-"));
  try {
    return spawnSync("node", [CLI, hook], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        ASCENDA_HOME: home,
        ASCENDA_STATE_DIR: path.join(home, "state"),
        ASCENDA_EVENT_LOG_FILE: path.join(home, "events.jsonl"),
        ASCENDA_TOOL_INSTALLATION_ID: "",
        ASCENDA_EVENT_WRITE_TOKEN: "",
        ASCENDA_LIVE_BUS_SOCKET: socketPath
      }
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("the built CLI puts exactly one awaiting on the socket for a permission prompt, and no words", async () => {
  await withListener(async (socketPath, lines) => {
    const result = runHook("Notification", notification({
      notification_type: "permission_prompt",
      message: "Claude needs your permission to deploy AcmeCorp"
    }), socketPath);
    assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
    await settle(lines);
    // `pid` is the one field that depends on where the test runs: under a
    // `claude` (this suite run from Claude Code) the hook finds it, and
    // anywhere else it doesn't. A number is not a word either way; that it is
    // the right number is liveSignalPid.test.mjs's job.
    const [{ pid, ...rest }] = lines;
    assert.ok(pid === undefined || Number.isInteger(pid), `pid must be absent or a pid, got ${pid}`);
    assert.equal(lines.length, 1);
    assert.deepEqual(rest, { tool: "claude_code", session: "s1", event: "awaiting" });
  });
});

test("the built CLI sends one beat for AskUserQuestion, not a tool_call and an awaiting racing", async () => {
  await withListener(async (socketPath, lines) => {
    const result = runHook("PreToolUse", { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "AskUserQuestion", tool_input: {} }, socketPath);
    assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
    await settle(lines);
    assert.deepEqual(lines.map((l) => l.event), ["awaiting"]);
  });
});
