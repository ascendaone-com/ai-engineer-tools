/**
 * The local live bus — the socket the Ascenda Flow macOS app binds, and the
 * sole input to the waterline gauges, the Away Mode keep-awake assertion,
 * the settle bell and the screen saver's paired handoff. None of those are
 * served by the cloud path, so a mapping that drops a beat leaves four
 * features silently dead rather than merely under-reported.
 *
 * Three things are guarded here, in the order they can break:
 *   1. the mapping itself, hook by hook, including the hooks that must stay
 *      silent — a doubled beat is as wrong as a missing one;
 *   2. the vocabulary, against `LiveBusEvent` in tool-kit *and* against the
 *      list the app's `LiveSignal.tryParse` will actually accept. A signal
 *      the app drops is worse than none, because it looks like it works;
 *   3. the wire, end to end: the built CLI, a real socket, and the failure
 *      posture when nothing is listening.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { liveSignalFor } from "../dist/liveSignal.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../dist/cli.js");
const LIVE_BUS_SRC = path.resolve(HERE, "../../packages/tool-kit/src/liveBus.ts");

/**
 * What `LiveSignal.tryParse` in `apps/macos/lib/src/flow/live_demand.dart`
 * accepts. Two-sided pin: that switch and this list are the same fact seen
 * from either end of the socket, and the app drops anything else on the
 * floor. Turn both around together; never widen this one alone.
 */
const APP_PARSES = ["prompt_submitted", "tool_call", "compaction", "tool_failure", "stop"];

/** The union tool-kit actually declares, read from its source. */
function toolKitVocabulary() {
  const text = fs.readFileSync(LIVE_BUS_SRC, "utf8");
  const block = text.match(/export type LiveBusEvent =([^;]+);/);
  assert.ok(block, "could not find LiveBusEvent in tool-kit — did the scan path break?");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function signals() {
  return FIXTURES.map(([hook, input]) => liveSignalFor(hook, input)).filter(Boolean);
}

test("tool-kit's vocabulary is exactly what the app will parse", () => {
  assert.deepEqual([...toolKitVocabulary()].sort(), [...APP_PARSES].sort());
});

test("every event this adapter emits is one the app parses", () => {
  const emitted = signals();
  assert.ok(emitted.length > 0, "the fixtures no longer reach the mapper");
  for (const signal of emitted) {
    assert.ok(APP_PARSES.includes(signal.event), `${signal.event} would be dropped by the app`);
  }
});

test("only prompt_submitted carries a size bucket, and only ever a bucket", () => {
  for (const signal of signals()) {
    if (signal.sizeBucket === undefined) continue;
    assert.equal(signal.event, "prompt_submitted", "sizeBucket is meaningless off prompt_submitted");
    assert.ok(["s", "m", "l", "xl"].includes(signal.sizeBucket), `${signal.sizeBucket} is not a bucket`);
  }
});

test("no signal claims to know whether a turn was queued", () => {
  // Tri-state on purpose: this host's payloads cannot answer, and absent
  // must never be read as "not queued". Only Claude Code can answer at all.
  for (const signal of signals()) assert.equal("queued" in signal, false);
});

test("prompt text never crosses the socket, only its bucket", () => {
  const secret = "refactor the CashSettlement reconciler";
  const signal = liveSignalFor(PROMPT_HOOK, promptPayload(`${secret} `.repeat(40)));
  assert.equal(signal.event, "prompt_submitted");
  assert.equal(signal.sizeBucket, "m");
  assert.ok(!JSON.stringify(signal).includes("CashSettlement"), "prompt text reached the wire");
});

/**
 * Reads newline-delimited JSON off a throwaway socket while the CLI runs.
 *
 * Async by necessity, twice over: the socket file does not exist until
 * `listen` fires, and the connection's `data` callbacks cannot run while
 * `spawnSync` holds the event loop — so a synchronous read after it returns
 * always sees nothing.
 */
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
    return await run(socketPath, lines, () => drain(lines));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Lets the event loop deliver whatever the child wrote. Bounded and then
 * given up on: the assertion that follows is what reports the failure, and a
 * test that hangs waiting for a signal that will never come says nothing.
 */
async function drain(lines, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (lines.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // One more turn, so a second signal in the same batch is not missed and a
  // test expecting silence still gives the socket a chance to speak.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Runs the built CLI against an isolated home so no real state is touched. */
function runHook(hook, input, socketPath) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-live-home-"));
  try {
    return spawnSync("node", [CLI, ...ARGV(hook)], {
      input: JSON.stringify({ ...HOOK_NAME_ON_STDIN(hook), ...SESSION_ON_STDIN, ...input }),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        ASCENDA_HOME: home,
        ASCENDA_STATE_DIR: path.join(home, "state"),
        ASCENDA_EVENT_LOG_FILE: path.join(home, "events.jsonl"),
        ASCENDA_TOOL_INSTALLATION_ID: "",
        ASCENDA_EVENT_WRITE_TOKEN: "",
        ASCENDA_LIVE_BUS_SOCKET: socketPath ?? path.join(home, "nothing-listening.sock")
      }
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("the built CLI puts a parseable signal on the socket, under this host's own name", async () => {
  await withListener(async (socketPath, lines, settle) => {
    const result = runHook(PROMPT_HOOK, promptPayload("add pagination"), socketPath);
    assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
    await settle();
    assert.equal(lines.length, 1, `expected one signal, got ${JSON.stringify(lines)}`);
    const [signal] = lines;
    assert.equal(signal.tool, HOST, "this host must not report as another collector");
    assert.notEqual(signal.tool, "claude_code");
    assert.equal(signal.event, "prompt_submitted");
    assert.equal(signal.session, SESSION_ID, "the payload's own session id identifies the stream");
    assert.equal(signal.sizeBucket, "s");
  });
});

test("a hook with no live counterpart says nothing", async () => {
  await withListener(async (socketPath, lines, settle) => {
    const result = runHook(SILENT_HOOK[0], SILENT_HOOK[1], socketPath);
    assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
    await settle();
    assert.deepEqual(lines, [], "a hook the gauges do not render must stay silent");
  });
});

test("no listener is the ordinary case, not a failure: the hook still exits 0 and still delivers", () => {
  // Nobody runs the desktop app on CI, and most users never will. Emission
  // is additive and best-effort: a missing socket must be indistinguishable
  // from before this existed, cloud send included.
  const result = runHook(PROMPT_HOOK, promptPayload("add pagination"), undefined);
  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
  assert.equal(result.stderr.trim(), "", "a silent gauge must never reach the user's transcript");
});

const HOST = "codex";
const ARGV = (hook) => [hook];
const HOOK_NAME_ON_STDIN = () => ({});
const SESSION_ID = "cdx-1";
const SESSION_ON_STDIN = { session_id: SESSION_ID };
const PROMPT_HOOK = "UserPromptSubmit";
const promptPayload = (prompt) => ({ prompt });
const SILENT_HOOK = ["PermissionRequest", {}];

const FIXTURES = [
  ["SessionStart", { source: "startup" }],
  ["UserPromptSubmit", { prompt: "add pagination" }],
  ["PreToolUse", { tool_name: "shell" }],
  ["PostToolUse", { tool_name: "shell", tool_response: { exit_code: 0 } }],
  ["PostToolUse", { tool_name: "shell", tool_response: { exit_code: 1 } }],
  ["PreCompact", {}],
  ["PostCompact", {}],
  ["PermissionRequest", {}],
  ["SubagentStart", {}],
  ["SubagentStop", {}],
  ["Stop", {}]
];

test("the mapping, hook by hook", () => {
  assert.equal(liveSignalFor("UserPromptSubmit", { prompt: "x" }).event, "prompt_submitted");
  // The leading edge carries the cadence, so the gauge rises as the agent
  // starts rather than after it finishes.
  assert.equal(liveSignalFor("PreToolUse", { tool_name: "shell" }).event, "tool_call");
  assert.equal(liveSignalFor("PreCompact", {}).event, "compaction");
  assert.equal(liveSignalFor("Stop", {}).event, "stop");
});

test("PostToolUse speaks only for a failure — Codex has no separate failure hook", () => {
  assert.equal(liveSignalFor("PostToolUse", { tool_response: { exit_code: 1 } }).event, "tool_failure");
  assert.equal(liveSignalFor("PostToolUse", { error: "boom" }).event, "tool_failure");
  // A success here would double-count the call PreToolUse already reported.
  assert.equal(liveSignalFor("PostToolUse", { tool_response: { exit_code: 0 } }), undefined);
  // Unknown is not failure: guessing would ring the failure impulse for work
  // that succeeded.
  assert.equal(liveSignalFor("PostToolUse", { tool_name: "shell" }), undefined);
});

test("hooks with no gauge counterpart stay silent", () => {
  // PostCompact is the compaction PreCompact already rang; the rest have
  // nothing the gauges render.
  for (const hook of ["SessionStart", "PostCompact", "PermissionRequest", "SubagentStart", "SubagentStop"]) {
    assert.equal(liveSignalFor(hook, {}), undefined, `${hook} must stay silent`);
  }
});

test("a prompt-less UserPromptSubmit omits the bucket rather than inventing one", () => {
  assert.deepEqual(liveSignalFor("UserPromptSubmit", {}), { event: "prompt_submitted" });
});
