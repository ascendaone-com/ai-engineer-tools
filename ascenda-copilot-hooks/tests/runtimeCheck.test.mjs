import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_EVENTS } from "../dist/setup.js";
import { copilotRuntimeLines, scanCopilotSessions } from "../dist/runtimeCheck.js";
import { readSessionRecord, recordSessionHook, sessionRecordPath } from "../dist/sessionRecord.js";

// doctor's runtime check joins our per-session record with Copilot's own
// session logs. Fixtures are session-state directories in Copilot's shape:
// events.jsonl lines of { type, data, id, timestamp }, and a workspace.yaml.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const BIN = "ascenda-copilot-hook";
// Planted in every field the check must not read. It must never reach output.
const SENTINEL = "SENTINEL-acme-payroll-secret";
const plain = { bold: (t) => t, dim: (t) => t, green: (t) => t, yellow: (t) => t, red: (t) => t, cyan: (t) => t, mark: (tone) => ({ ok: "✓", warn: "!", bad: "✗", info: "·" })[tone], tone: (_, t) => t, enabled: false };

function sandbox() {
  const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-rt-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-copilot-state-"));
  return { copilotHome, stateDir, root: path.join(copilotHome, "session-state") };
}

let seq = 0;
const line = (type, data) => JSON.stringify({ type, data, id: `e${++seq}`, timestamp: new Date().toISOString() });
const start = (hookType) => line("hook.start", { hookInvocationId: `h${seq}`, hookType, input: { sessionId: "x", prompt: SENTINEL, toolArgs: { command: SENTINEL } } });
const ok = (hookType) => line("hook.end", { hookInvocationId: `h${seq}`, hookType, success: true });
const fail = (hookType, message) => line("hook.end", { hookInvocationId: `h${seq}`, hookType, success: false, error: { message } });

function session(root, id, { clientName, lines }) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const all = [
    line("session.start", { sessionId: id, context: { cwd: `/work/${SENTINEL}` } }),
    line("user.message", { content: `${SENTINEL} "hook.start" "hook.end"` }),
    ...lines
  ];
  fs.writeFileSync(path.join(dir, "events.jsonl"), `${all.join("\n")}\n`);
  const yaml = [`name: ${SENTINEL}`, `cwd: /work/${SENTINEL}`];
  if (clientName) yaml.push(`client_name: ${clientName}`);
  fs.writeFileSync(path.join(dir, "workspace.yaml"), `${yaml.join("\n")}\n`);
}

function run(box, record) {
  process.env.ASCENDA_STATE_DIR = box.stateDir;
  return copilotRuntimeLines({ ui: plain, hookEvents: HOOK_EVENTS, binaryName: BIN, hooksFile: path.join(box.copilotHome, "hooks", "ascenda.json"), root: box.root, record }).join("\n");
}

const record = (...ids) => Object.fromEntries(ids.map((id) => [id, { firstAt: new Date().toISOString(), lastAt: new Date().toISOString(), events: { userPromptSubmitted: 1, postToolUse: 3 } }]));

test("a session where ours ran and succeeded, under VS Code's agent host", () => {
  const box = sandbox();
  session(box.root, "s-ours", { clientName: "vscode-agent-host", lines: [start("userPromptSubmitted"), ok("userPromptSubmitted"), start("postToolUse"), ok("postToolUse")] });
  const out = run(box, record("s-ours"));
  assert.match(out, /✓ vscode-agent-host +1 session, ours ran in 1 \(4 runs, 0 failed\) · the CLI logged 2 hook runs/);
  assert.doesNotMatch(out, /other hooks/);
});

test("a session with only another hook's exit 126 failures: ours ran in 0, and theirs aren't blamed on us", () => {
  const box = sandbox();
  const theirs = `Hook command failed with code 126\nStderr: /plugins/${SENTINEL}/hook.sh: Permission denied`;
  session(box.root, "s-theirs", { lines: Array.from({ length: 3 }, () => [start("postToolUse"), fail("postToolUse", theirs)]).flat() });
  const out = run(box, {});
  assert.match(out, /! standalone +1 session, ours ran in 0\. Is .*hooks\/ascenda\.json loaded\?/);
  assert.match(out, /· other hooks +3 failures from another hook, not ours/);
});

test("a session where ours failed names the failure, and only counts our binary's", () => {
  const box = sandbox();
  const ours = `Hook command failed with code 126\nStderr: /home/dev/.ascenda/bin/${BIN}: Permission denied`;
  session(box.root, "s-broken", { clientName: "vscode", lines: [start("sessionStart"), fail("sessionStart", ours), start("agentStop"), fail("agentStop", ours)] });
  const out = run(box, {});
  assert.match(out, /✗ vscode +1 session, ours ran in 0, and failed 2 times before it could record/);
  assert.doesNotMatch(out, /Permission denied|\.ascenda\/bin/, "the message never reaches output");
  assert.doesNotMatch(out, /other hooks/);
});

test("a session our record has that the CLI's log doesn't is likely VS Code chat", () => {
  const box = sandbox();
  fs.mkdirSync(box.root, { recursive: true });
  const out = run(box, record("chat-only"));
  assert.match(out, /· outside the CLI +1 session our hook saw that the CLI's log doesn't have, likely VS Code chat/);
});

test("no sessions at all says to run one", () => {
  const box = sandbox();
  const out = run(box, {});
  assert.match(out, /None in the last 7 days\. Run a short Copilot session, then run doctor again\./);
});

test("old sessions and unregistered hook types are left out", () => {
  const box = sandbox();
  session(box.root, "s-old", { lines: [start("postToolUse"), ok("postToolUse")] });
  const old = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(box.root, "s-old", "events.jsonl"), old, old);
  session(box.root, "s-new", { lines: [start("userPromptTransformed"), ok("userPromptTransformed"), start("notification"), fail("notification", "x")] });
  const scans = scanCopilotSessions({ hookEvents: HOOK_EVENTS, binaryName: BIN, root: box.root });
  assert.deepEqual(scans.map((scan) => [scan.sessionId, scan.hookRuns, scan.othersFailed]), [["s-new", 0, 0]]);
});

test("nothing from a hook's input, a message, a prompt or workspace.yaml's name reaches the output", () => {
  const box = sandbox();
  session(box.root, "s-a", { clientName: "vscode-agent-host", lines: [start("postToolUse"), fail("postToolUse", `boom ${SENTINEL}`), start("postToolUse"), fail("postToolUse", `${BIN} ${SENTINEL}`)] });
  session(box.root, "s-b", { clientName: SENTINEL.repeat(3), lines: [start("sessionStart"), ok("sessionStart")] });
  const out = run(box, record("s-a", "s-gone"));
  assert.ok(!out.includes(SENTINEL), out);
  assert.ok(!out.includes("acme"), out);
});

test("the hook keeps a per-session record: counts per hook, nothing else, mode 0600, the latest 50 sessions", { skip: process.platform === "win32" }, () => {
  const box = sandbox();
  process.env.ASCENDA_STATE_DIR = box.stateDir;
  const base = Date.parse("2026-10-20T00:00:00Z");
  for (let i = 0; i < 55; i++) recordSessionHook(`s-${i}`, "userPromptSubmitted", HOOK_EVENTS, new Date(base + i * 1000));
  recordSessionHook("s-54", "postToolUse", HOOK_EVENTS, new Date(base + 60_000));
  recordSessionHook("s-54", "notification", HOOK_EVENTS);
  recordSessionHook(`bad id ${SENTINEL}`, "postToolUse", HOOK_EVENTS);
  recordSessionHook(undefined, "postToolUse", HOOK_EVENTS);

  const kept = readSessionRecord();
  assert.equal(Object.keys(kept).length, 50);
  assert.ok(!kept["s-0"] && kept["s-5"], "the oldest five went");
  assert.deepEqual(kept["s-54"].events, { userPromptSubmitted: 1, postToolUse: 1 });
  assert.equal(kept["s-54"].firstAt, new Date(base + 54_000).toISOString());
  assert.equal(kept["s-54"].lastAt, new Date(base + 60_000).toISOString());
  assert.equal(fs.statSync(sessionRecordPath()).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(sessionRecordPath(), "utf8").includes(SENTINEL));
});

test("the built hook records its session, and a broken record file never breaks the hook", { skip: process.platform === "win32" }, () => {
  const box = sandbox();
  const env = { ...process.env, HOME: box.copilotHome, ASCENDA_HOME: box.copilotHome, ASCENDA_STATE_DIR: box.stateDir, ASCENDA_TOOL_INSTALLATION_ID: "", ASCENDA_EVENT_LOG_FILE: "off", ASCENDA_LIVE_BUS_SOCKET: path.join(box.stateDir, "none.sock") };
  const hook = (name, input) => spawnSync("node", [CLI, name], { input: JSON.stringify(input), encoding: "utf8", env, timeout: 15_000 });
  assert.equal(hook("userPromptSubmitted", { sessionId: "cli-1", cwd: "/tmp", prompt: SENTINEL }).status, 0);
  assert.equal(hook("preToolUse", { sessionId: "cli-1", cwd: "/tmp", toolCalls: [{ id: "a", name: "view", args: {} }] }).status, 0);
  const file = path.join(box.stateDir, "copilot_cli-sessions.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved["cli-1"].events, { userPromptSubmitted: 1, preToolUse: 1 });
  assert.ok(!fs.readFileSync(file, "utf8").includes(SENTINEL));

  fs.writeFileSync(file, "{ torn");
  assert.equal(hook("agentStop", { sessionId: "cli-2", cwd: "/tmp" }).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8"))["cli-2"].events, { agentStop: 1 });
});

test("doctor prints the runtime section from COPILOT_HOME and our state dir", { skip: process.platform === "win32" }, () => {
  const box = sandbox();
  session(box.root, "d-1", { clientName: "vscode-agent-host", lines: [start("postToolUse"), ok("postToolUse")] });
  fs.writeFileSync(path.join(box.stateDir, "copilot_cli-sessions.json"), JSON.stringify(record("d-1")));
  const result = spawnSync("node", [CLI, "doctor"], {
    encoding: "utf8", input: "", timeout: 15_000,
    env: { ...process.env, HOME: box.copilotHome, ASCENDA_HOME: box.copilotHome, COPILOT_HOME: box.copilotHome, ASCENDA_STATE_DIR: box.stateDir, ASCENDA_TOOL_INSTALLATION_ID: "", NO_COLOR: "1", ASCENDA_LIVE_BUS_SOCKET: path.join(box.stateDir, "none.sock") }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Copilot runtimes +last 7 days/);
  assert.match(result.stdout, /vscode-agent-host +1 session, ours ran in 1 \(4 runs, 0 failed\)/);
  assert.ok(!result.stdout.includes(SENTINEL));
});
