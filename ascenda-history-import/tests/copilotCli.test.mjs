/**
 * Copilot CLI session-log extractor, against `fixtures/copilot-cli-store`.
 *
 * The fixture copies the field names and shapes of real `events.jsonl`,
 * `workspace.yaml` and flat `<id>.jsonl` logs. Every content field (prompts,
 * replies, reasoning, tool arguments and results, the workspace's `name` and
 * `summary`) holds the same sentinel string, and the first test asserts it
 * never reaches an event, a handoff or a wire payload.
 *
 *  - `…0a`: a current build, directory shape, `selectedModel: "auto"`,
 *    a shutdown with tokens and line counts, hooks, a repeated call id, a
 *    subagent call and the task message that started it, a compaction and an
 *    event type nobody has classified.
 *  - `…0b`: an older build, flat file beside a directory holding only
 *    `workspace.yaml`, models only from `selectedModel` and `model_change`,
 *    one malformed line, no shutdown.
 *  - `…0c`: `version: 2`. `…0d`: no `session.start`. Neither is read.
 *  - `…0e`: the same log as a directory and as a flat file. Read once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  copilotAutonomyModeOf,
  extractCopilotCli,
  isReadableCopilotLog,
  readCopilotWorkspace,
  shutdownFiguresOf,
  sniffCopilotLine
} from "../dist/extractors/copilotCli.js";
import { HISTORY_STORES, STORE_SOURCE, STORE_HOST } from "../dist/types.js";
import { toWirePayload } from "../dist/ship.js";
import { buildCopilotCliHandoff, HANDOFF_SCHEMA } from "../dist/localHandoff.js";
import { scanCopilotCli } from "../dist/scan.js";
import { resolveStorePaths } from "../dist/stores.js";
import { snapshotCopilotSessionState } from "../dist/staging.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "copilot-cli-store");
const SENTINEL = "CONTENT-SENTINEL";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const E = "00000000-0000-4000-8000-00000000000e";

async function extractAll(dir = FIXTURE) {
  const events = [];
  for await (const event of extractCopilotCli(dir, "x-test")) events.push(event);
  return events;
}

function sessionOf(events, ref) {
  return events.find((e) => e.eventKind === "create_focus_session" && e.sessionRef === ref);
}

test("no content field reaches an event, the handoff or the wire", async () => {
  const events = await extractAll();
  assert.ok(events.length > 0);
  assert.ok(!JSON.stringify(events).includes(SENTINEL), "an extracted event carries content");
  const handoff = buildCopilotCliHandoff(events, "x-test", "2026-10-25T00:00:00.000Z");
  assert.ok(!JSON.stringify(handoff).includes(SENTINEL), "the handoff carries content");
  const wire = events
    .filter((e) => e.eventKind !== "extraction_epoch")
    .map((e, i) => toWirePayload(e, i, "install-test"));
  assert.ok(!JSON.stringify(wire).includes(SENTINEL), "a wire payload carries content");
});

test("current build: counts, model, tokens, lines, posture and workspace", async () => {
  const events = await extractAll();
  const session = sessionOf(events, A);
  assert.ok(session);
  const m = session.metrics;
  assert.equal(session.store, "copilot_cli");
  assert.equal(session.sourceVersion, "1.0.0-test");
  assert.equal(session.repoRef, "/work/repo-a", "git_root from workspace.yaml");
  assert.equal(m.gitBranch, "main");
  assert.equal(m.clientName, "vscode-agent-host");
  // The subagent's task message is the parent agent's, not a person's.
  assert.equal(m.promptCount, 2);
  assert.equal(m.subagentPrompts, 1);
  assert.equal(m.assistantTurns, 2);
  // c1, c2 (once, though started twice) and c3, the subagent's.
  assert.equal(m.toolCallCount, 3);
  assert.equal(m.subagentToolCallCount, 1);
  assert.equal(m.toolResultCount, 3);
  assert.equal(m.toolResultErrorCount, 1);
  assert.equal(m.toolFailureCount, 1);
  assert.equal(m.compactionCount, 1);
  assert.equal(m.unknownLines, 1, "session.something_new");
  // The two hook lines are skipped whole, not counted as meta.
  assert.equal(m.metaLines, 5);
  assert.equal(m.primaryModel, "gpt-test-5");
  assert.equal(m.modelCount, 1);
  assert.equal(m.selectedModel, "auto");
  assert.equal(m.selectedModelClass, "router:auto");
  assert.equal(m.inputTokens, 15);
  assert.equal(m.outputTokens, 30);
  assert.equal(m.cacheReadTokens, 200);
  assert.equal(m.cacheCreationTokens, 50);
  assert.equal(m.tokensNotCollected, undefined);
  assert.equal(m.linesAdded, 12);
  assert.equal(m.linesRemoved, 3);
  assert.equal(m.filesChangedCount, 2);
  assert.equal(m.totalApiDurationMs, 4200);
  assert.equal(m.sessionStartedAt, "2026-10-21T02:00:00.000Z");
  assert.equal(session.occurredAt, "2026-10-21T02:21:00.000Z");
  // Posture from the first permission request on: manual is supervised.
  assert.ok((session.autonomySplit.supervised ?? 0) > 0);
  assert.ok(m.handsOnMinutes + m.agentSupervisingMinutes === m.activeMinutes);

  const calls = events.filter((e) => e.eventKind === "ai_tool_call_started" && e.sessionRef === A);
  assert.deepEqual(calls.map((c) => c.metrics.toolName), ["view", "bash", "rg"]);
  assert.ok(calls.every((c) => c.provenance === "historical_direct"));
  const prompts = events.filter((e) => e.eventKind === "ai_prompt_submitted" && e.sessionRef === A);
  assert.deepEqual(prompts.map((p) => p.occurredAt), ["2026-10-21T02:00:03.000Z", "2026-10-21T02:20:00.000Z"]);
  const failure = events.find((e) => e.eventKind === "tool_failure" && e.sessionRef === A);
  assert.equal(failure?.metrics.toolFailureCount, 1);
});

test("hooks put no instant on the timeline", async () => {
  const events = await extractAll();
  const session = sessionOf(events, A);
  // 25 lines, 2 of them hooks: 23 instants, every one dated.
  assert.equal(session.metrics.activeSplitInstants, 23);
  assert.equal(session.metrics.activeSplitUndatedLines, 0);
});

test("older flat log: models from start and model_change, no shutdown means no tokens", async () => {
  const events = await extractAll();
  const session = sessionOf(events, B);
  assert.ok(session);
  const m = session.metrics;
  assert.equal(session.sourceVersion, null, "copilotVersion: unknown is not a version");
  assert.equal(session.repoRef, "/work/repo-b", "quoted cwd from the directory's workspace.yaml");
  assert.equal(m.gitBranch, undefined);
  assert.equal(m.clientName, undefined);
  assert.equal(m.promptCount, 2);
  assert.equal(m.toolCallCount, 1);
  assert.equal(m.primaryModel, "claude-sonnet-test", "the model_change took effect before the first message");
  assert.equal(m.selectedModel, "claude-opus-test");
  assert.equal(m.selectedModelClass, "anthropic:opus");
  assert.equal(m.unparsedLines, 1);
  assert.equal(m.tokensNotCollected, true);
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "linesAdded", "linesRemoved", "totalApiDurationMs"]) {
    assert.equal(key in m, false, `${key} is absent, not 0`);
  }
  assert.deepEqual(Object.keys(session.autonomySplit).filter((k) => k !== "unknown"), [], "no posture was ever declared");
});

test("epoch: unknown version and missing start are counted, a twice-written session once", async () => {
  const events = await extractAll();
  const epochs = events.filter((e) => e.eventKind === "extraction_epoch");
  assert.equal(epochs.length, 1);
  const m = epochs[0].metrics;
  assert.equal(m.sessionCount, 3);
  assert.equal(m.unparsedChatSessionFiles, 2);
  assert.equal(m.unreadableChatSessionFiles, 0);
  assert.equal(m.malformedChatSessionLines, 1);
  assert.equal(m.duplicateChatSessions, 1);
  assert.equal(m.windowOldest, "2025-12-19T00:00:00.000Z");
  assert.equal(m.windowNewest, "2026-10-21T02:21:00.000Z");
  const sessions = events.filter((e) => e.eventKind === "create_focus_session");
  assert.deepEqual(sessions.map((s) => s.sessionRef).sort(), [A, B, E]);
  assert.equal(sessionOf(events, E).metrics.promptCount, 1, "read once");
});

test("version dispatch reads only version 1", () => {
  assert.equal(isReadableCopilotLog({ version: 1 }), true);
  assert.equal(isReadableCopilotLog({ version: 2 }), false);
  assert.equal(isReadableCopilotLog({ version: "1" }), false);
  assert.equal(isReadableCopilotLog({}), false);
  assert.equal(isReadableCopilotLog(null), false);
});

test("sniff: hooks skipped, meta and unknown kept apart, junk unparsed", () => {
  assert.equal(sniffCopilotLine(JSON.stringify({ type: "hook.end", timestamp: "t" })).kind, "skipped");
  assert.equal(sniffCopilotLine(JSON.stringify({ type: "assistant.turn_end", timestamp: "t" })).kind, "meta");
  assert.equal(sniffCopilotLine(JSON.stringify({ type: "brand.new", timestamp: "t" })).kind, "unknown");
  assert.equal(sniffCopilotLine(JSON.stringify({ type: "user.message", data: {} })).kind, "event");
  assert.equal(sniffCopilotLine("[]").kind, "unparsed");
  assert.equal(sniffCopilotLine("{").kind, "unparsed");
});

test("workspace.yaml: four top-level keys only", () => {
  const ws = readCopilotWorkspace(
    [
      "id: x",
      "cwd: \"/work/quoted\"",
      "git_root: /work/root",
      "branch: feature/x",
      "client_name: vscode",
      "name: what the person typed first",
      "summary: |",
      "  cwd: /indented/is/summary/text",
      "  git_root: /also/text"
    ].join("\n")
  );
  assert.deepEqual(ws, { cwd: "/work/quoted", gitRoot: "/work/root", branch: "feature/x", clientName: "vscode" });
  assert.deepEqual(readCopilotWorkspace("cwd: |\n  /block\n"), { cwd: null, gitRoot: null, branch: null, clientName: null });
});

test("posture: manual is supervised, plan is planning, anything else lands in unknown", () => {
  assert.equal(copilotAutonomyModeOf("interactive", "manual"), "default");
  assert.equal(copilotAutonomyModeOf(undefined, "manual"), "default");
  assert.equal(copilotAutonomyModeOf("plan", "manual"), "plan");
  assert.equal(copilotAutonomyModeOf("autopilot", "auto"), "copilot:autopilot/auto");
  assert.equal(copilotAutonomyModeOf(undefined, undefined), null);
});

test("shutdown without tokenDetails falls back to modelMetrics, cache taken off input", () => {
  const figures = shutdownFiguresOf({
    modelMetrics: {
      a: { usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 60, cacheWriteTokens: 30 } },
      b: { usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    }
  });
  assert.equal(figures.tokensSeen, true);
  assert.equal(figures.inputTokens, 20);
  assert.equal(figures.outputTokens, 10);
  assert.equal(figures.cacheReadTokens, 60);
  assert.equal(figures.cacheCreationTokens, 30);
  assert.equal(shutdownFiguresOf({}).tokensSeen, false);
});

test("an empty or missing store yields nothing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-empty-"));
  assert.deepEqual(await extractAll(dir), []);
  assert.deepEqual(await extractAll(path.join(dir, "absent")), []);
});

test("wiring: store, wire source and host", async () => {
  assert.ok(HISTORY_STORES.includes("copilot_cli"));
  assert.equal(STORE_SOURCE.copilot_cli, "cli_agent");
  assert.equal(STORE_HOST.copilot_cli, "copilot_cli");
  const events = await extractAll();
  const wire = toWirePayload(sessionOf(events, A), 0, "install-test");
  assert.equal(wire.source, "cli_agent");
  assert.equal(wire.metadata.host, "copilot_cli");
  assert.equal(wire.metadata.modelClass, "openai:gpt", "the class of the model that served it");
  assert.equal(wire.metadata.selectedModelClass, "router:auto");
  assert.equal(wire.metadata.gitBranch, undefined, "hashed on the way out");
  assert.ok(wire.metadata.branchHash);
});

test("handoff: one session per log, line counts null without a shutdown", async () => {
  const events = await extractAll();
  const handoff = buildCopilotCliHandoff(events, "x-test", "2026-10-25T00:00:00.000Z");
  assert.equal(handoff.schema, HANDOFF_SCHEMA);
  assert.equal(handoff.store, "copilot_cli");
  assert.equal(handoff.handsOnBoundary, "nearest_line");
  assert.equal(handoff.sessions.length, 3);
  const a = handoff.sessions.find((s) => s.sessionRef === A);
  assert.equal(a.linesAdded, 12);
  assert.equal(a.toolCallCount, 3);
  assert.equal(a.primaryModel, "gpt-test-5");
  const b = handoff.sessions.find((s) => s.sessionRef === B);
  assert.equal(b.linesAdded, null);
  assert.equal(handoff.windowOldest, "2025-12-19T00:00:00.000Z");
  assert.ok(handoff.projects.length >= 1);
});

test("scan counts logs in both shapes and opens none", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-scan-"));
  const paths = resolveStorePaths(home, {});
  assert.equal(paths.copilotSessionState, path.join(home, ".copilot", "session-state"));
  assert.equal((await scanCopilotCli(paths)).present, false);
  await fs.cp(FIXTURE, paths.copilotSessionState, { recursive: true });
  const inv = await scanCopilotCli(paths);
  assert.equal(inv.present, true);
  assert.equal(inv.counts.sessionLogs, 4, "a, c, d, e directories");
  assert.equal(inv.counts.flatLogs, 2, "b and e flat files");
  assert.ok(inv.counts.bytes > 0);
  assert.equal(inv.retentionRisk, undefined);
});

test("snapshot copies the logs and workspace files, nothing else", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-stage-"));
  const dest = await snapshotCopilotSessionState({ extractionId: "x", root }, FIXTURE, "ss");
  const copied = [];
  async function walk(dir, rel = "") {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), next);
      else copied.push(next);
    }
  }
  await walk(dest);
  assert.ok(copied.every((f) => /(?:events\.jsonl|workspace\.yaml|^[^/]+\.jsonl)$/.test(f)), copied.join(", "));
  assert.equal(copied.some((f) => f.includes("plan.md") || f.includes("checkpoints")), false);
  // The snapshot reads exactly as the live directory does.
  const fromSnapshot = await extractAll(dest);
  const fromFixture = await extractAll();
  assert.equal(fromSnapshot.length, fromFixture.length);
  assert.deepEqual(await snapshotCopilotSessionState({ extractionId: "y", root }, path.join(root, "absent"), "none"), path.join(root, "none"));
});
