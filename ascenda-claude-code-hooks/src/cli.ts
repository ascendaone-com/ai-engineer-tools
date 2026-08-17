#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  bucketPromptSize,
  createPairingSession,
  defaultTokenFilePath,
  emitLiveSignal,
  getPairingStatus,
  getString,
  getNestedString,
  markFailureNotified,
  persistEventWriteToken,
  readCollectorState,
  shouldAnnounceFailure
} from "@ascenda-one/tool-kit";
import type { CollectorState, LiveBusEvent } from "@ascenda-one/tool-kit";
import { AscendaClient } from "./ascendaClient.js";
import { loadConfigFromEnv, normalizeToolInstallationId, resolveStateFilePath } from "./config.js";
import { isNewSessionStart, mapClaudeEvent, milestoneInviting } from "./mapClaudeEvent.js";
import { ASCENDA_TOOL_TYPE, ClaudeHookEventName, ClaudeHookInput, IngestResult, isClaudeHookEventName } from "./types.js";

const INTENTION_INVITE =
  "Ascenda tip: if it's natural, you can ask what would make this session " +
  "count before diving in — one line is enough. Not a required step, " +
  "and skip it entirely if the user is already mid-task.";

/**
 * The milestone debrief (H1). The bookend to the intention invite: that one
 * asks what would make the session count, this one asks — at the moment a
 * piece of work actually ended — what it cost and what carries forward.
 *
 * Three deliberate restraints. It fires only on a *completion* (a merge, a
 * closed ticket), never on a handoff, so it lands where a person is already
 * pausing. It asks about the work, not the person — the same discipline the
 * shutdown ritual keeps. And it stays an invitation: only the model that can
 * see whether the user is already onto the next thing should decide whether
 * asking is welcome.
 */
const MILESTONE_DEBRIEF_INVITE =
  "Ascenda tip: that finished a piece of work. If the moment suits, it's " +
  "worth a short debrief — what moved, what's still unresolved, and what " +
  "you'd do differently next time. One or two lines. Skip it if they're " +
  "already onto the next thing.";

/**
 * The Phase-2 roadmap item, shipped: one command that pairs this machine as
 * its own claude_code installation. Every prior path was worse in practice —
 * "reuse the IDE extension's pairing" turned out to be impossible (the
 * extension keeps its token in the editor's private SecretStorage, never in
 * ~/.ascenda/tokens/), and the manual alternative was raw curl plus a
 * hand-written token file.
 *
 * Prints a 6-digit code to confirm in the Ascenda app, waits, persists the
 * write token where every CLI tool reads it, and prints the one export line
 * the hooks and MCP server still need.
 */
async function runPair(): Promise<void> {
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? "https://api.ascenda.one").replace(/\/$/, "");
  // `pair --tool-type cli_agent` lets the Codex adapter (and anything else
  // CLI-shaped) pair under its honest identity; the server rejects unknown
  // types, so no allow-list is duplicated here.
  const flagIndex = process.argv.indexOf("--tool-type");
  const toolType = flagIndex !== -1 ? (process.argv[flagIndex + 1] ?? "").trim() || ASCENDA_TOOL_TYPE : ASCENDA_TOOL_TYPE;
  // Reuse an already-exported id so re-pairing heals the existing identity
  // instead of minting a second one; mint only when none is configured.
  const existing = process.env.ASCENDA_TOOL_INSTALLATION_ID?.trim();
  const toolInstallationId = existing && existing.includes(":") ? existing : `${toolType}:${randomUUID()}`;

  const session = await createPairingSession(apiBaseUrl, toolInstallationId, toolType, toolType === ASCENDA_TOOL_TYPE ? "Claude Code" : toolType);
  const code = session.deviceCode ?? session.code;
  await writeStdout(
    `\nPairing code: ${code}\n\n` +
    `In the Ascenda app: Connections -> Ingest telemetry -> paste the code -> Pair tool.\n` +
    `Waiting for confirmation (expires ${session.expiresAt})...\n\n`
  );

  const deadline = Date.now() + 11 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const status = await getPairingStatus(apiBaseUrl, session.pairingSessionId);
    if (status.status === "pending") continue;
    if (status.status !== "paired") {
      process.stderr.write(`Pairing ${status.status}. Run the command again for a fresh code.\n`);
      process.exitCode = 1;
      return;
    }
    const pairedId = status.toolInstallationId ?? toolInstallationId;
    if (!status.eventWriteToken) {
      process.stderr.write(
        "Paired, but the server did not deliver a write token. Disconnect this tool in the Ascenda app and run the command again.\n"
      );
      process.exitCode = 1;
      return;
    }
    const tokenFilePath = defaultTokenFilePath(pairedId);
    persistEventWriteToken(tokenFilePath, status.eventWriteToken);
    await writeStdout(
      `Paired. Write token saved to ${tokenFilePath}\n\n` +
      `One step left — add this to your shell profile (~/.zshrc), then restart Claude Code:\n\n` +
      `  export ASCENDA_TOOL_INSTALLATION_ID="${pairedId}"\n\n`
    );
    return;
  }
  process.stderr.write("Timed out waiting for confirmation. Run the command again for a fresh code.\n");
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command) throw new Error("Usage: ascenda-claude-hook <ClaudeHookEventName> | pair | doctor");

  // Both of these run before the stdin read below, and must stay there: they
  // carry no hook payload, so reading stdin first hangs them forever on a pipe
  // nothing will ever write to.
  if (command === "pair") {
    await runPair();
    return;
  }
  if (command === "doctor") {
    await runDoctor();
    return;
  }
  if (!isClaudeHookEventName(command)) {
    throw new Error(`Unknown command "${command}". Expected a Claude Code hook name, "pair" or "doctor".`);
  }
  const hookName: ClaudeHookEventName = command;

  const input = await readJsonFromStdin();

  // Everything that can put a line in front of the user is composed here and
  // written exactly once, below. Claude Code parses this hook's stdout as a
  // single JSON document, so two writes would produce `{...}{...}` and lose
  // *both* messages — which is how a fix for a silent-failure bug could
  // silently break the invites it shares a channel with.
  const contextParts: string[] = [];

  // Local, network-independent, and unconditional on pairing state: a
  // broken pairing (or the network being down) must not silently suppress
  // this too, so it is decided before anything that can fail below.
  if (hookName === "SessionStart" && isNewSessionStart(input) && process.env.ASCENDA_DISABLE_INTENTION_INVITE !== "true") {
    contextParts.push(INTENTION_INVITE);
  }

  // Same placement and the same reasoning as the intention invite above: local,
  // network-independent, and before anything that can fail, so a broken pairing
  // never silently costs the user the prompt.
  if (hookName === "PostToolUse" && milestoneInviting(input) && process.env.ASCENDA_DISABLE_MILESTONE_DEBRIEF !== "true") {
    contextParts.push(MILESTONE_DEBRIEF_INVITE);
  }

  // Read from the journal rather than from this process's own send, which has
  // not happened yet. That costs the notice one hook invocation — irrelevant
  // against an outage measured in hours, and it buys the fail-safe ordering
  // above: a local file read that cannot throw, decided before the network.
  const pending = pendingFailureNotice(hookName);
  if (pending) contextParts.push(pending.text);

  if (contextParts.length > 0) {
    await writeStdout(JSON.stringify({
      hookSpecificOutput: { hookEventName: hookName, additionalContext: contextParts.join("\n\n") }
    }));
    // Only after the write has actually flushed: a notice recorded as
    // delivered but lost to a truncated pipe is the same bug again.
    if (pending) markFailureNotified(pending.stateFilePath, pending.state);
  }

  // The live presence bus — deliberately above `loadConfigFromEnv()`, which
  // throws when this machine has never paired. The waterline is a local
  // display cue driven by a socket on this machine; it owes nothing to a
  // backend pairing, and gating it on one would leave the gauges dark for
  // exactly the people still setting Ascenda up. Same placement reasoning
  // as the two invites above: local, network-independent, before anything
  // that can fail.
  await emitLive(hookName, input);

  const config = loadConfigFromEnv();
  const client = new AscendaClient(config);
  const mappedEvents = mapClaudeEvent(hookName, input);

  for (const event of mappedEvents) {
    const result = await client.send(event);
    if (result === "accepted") continue;

    // Kept for `doctor` and for anyone running the hook by hand — but never
    // relied upon. Claude Code discards a hook's stderr when it exits 0, and
    // this process always exits 0 by design, so nothing written here reaches
    // the user. The durable record is the journal the send just wrote; the
    // user-facing channel is the notice composed above.
    console.error(explainRejection(result));
    return;
  }
}

function explainRejection(result: IngestResult): string {
  if (result === "consent_missing") return "Ascenda telemetry rejected: renew IDE telemetry consent in the Ascenda app.";
  if (result === "auth_failed") return "Ascenda telemetry rejected: event write token invalid or revoked. Re-pair with `npx @ascenda-one/claude-code-hooks pair`.";
  if (result === "transport_error") return "Ascenda telemetry not delivered: the ingest endpoint could not be reached.";
  return `Ascenda telemetry rejected: ${result}`;
}

/**
 * Whisper this hook's moment to the desktop app's waterline gauges.
 *
 * Only the lifecycle beats the gauges actually render are mapped; anything
 * else is silence rather than a signal nothing consumes. `PreToolUse` — not
 * `PostToolUse` — carries the cadence heartbeat, because it fires at the
 * *leading* edge of the work and the gauge should rise as the agent starts,
 * not after it finishes.
 *
 * Never throws: {@link emitLiveSignal} already swallows everything, and the
 * try/catch is belt-and-braces so a future change here can't take a user's
 * turn down with it.
 */
async function emitLive(hookName: ClaudeHookEventName, input: ClaudeHookInput): Promise<void> {
  const event: LiveBusEvent | undefined =
    hookName === "UserPromptSubmit" ? "prompt_submitted"
    : hookName === "PreToolUse" ? "tool_call"
    : hookName === "PreCompact" ? "compaction"
    : hookName === "PostToolUseFailure" ? "tool_failure"
    : hookName === "Stop" ? "stop"
    : undefined;
  if (!event) return;

  try {
    const prompt = event === "prompt_submitted"
      ? getString(input, ["prompt", "userPrompt", "message"])
        ?? getNestedString(input, [["payload", "prompt"], ["payload", "message"]])
      : undefined;

    // Whether this turn came out of the queue. Claude Code labels user turns
    // with `promptSource`, and "queued" is one of its values — confirmed in
    // real transcripts. Read defensively across the plausible spellings and
    // omitted entirely when absent, because whether the *hook* payload
    // carries the field (the transcript certainly does) is the open question
    // this is here to answer: an older Claude Code, or a payload that never
    // carried it, must look exactly like today rather than like "not queued".
    const promptSource = event === "prompt_submitted"
      ? getString(input, ["promptSource", "prompt_source"])
      : undefined;
    const queued = promptSource === undefined ? undefined : promptSource === "queued";

    await emitLiveSignal({
      tool: process.env.ASCENDA_TOOL_TYPE ?? "claude_code",
      // Concurrent sessions must count as separate streams for the X gauge.
      // Without a session id every window collapses into one, so fall back to
      // this process's parent — still per-session in practice, since Claude
      // Code spawns hooks from the session process.
      session: getString(input, ["session_id", "sessionId"])
        ?? process.env.ASCENDA_SESSION_ID
        ?? `ppid-${process.ppid}`,
      event,
      ...(prompt !== undefined ? { sizeBucket: bucketPromptSize(prompt) } : {}),
      ...(queued !== undefined ? { queued } : {})
    });
  } catch {
    // A cosmetic gauge is never worth a word in the user's transcript.
  }
}

/**
 * The one-time notice for a collector that is failing right now.
 *
 * This is the only channel that reaches a person while they work — stderr is
 * discarded at exit 0, and `lastSeenAt` in the app cannot tell a dead token
 * from a night's sleep. It is deliberately kept to the Gentle Path: state the
 * fact, name the remedy, and say it once. `notifiedFailingSince` is what makes
 * "once" true — it is stamped with the episode, not the attempt, so several
 * hundred failing tool calls produce exactly one line.
 *
 * Restricted to the two hooks whose payload Claude Code reads back as context.
 * `SessionStart` is what makes an overnight outage visible: the notice waits in
 * the journal and lands at the top of the next session.
 */
function pendingFailureNotice(hookName: ClaudeHookEventName): { text: string; state: CollectorState; stateFilePath: string } | undefined {
  if (hookName !== "SessionStart" && hookName !== "PostToolUse") return undefined;
  if (process.env.ASCENDA_DISABLE_FAILURE_NOTICE === "true") return undefined;

  const rawId = process.env.ASCENDA_TOOL_INSTALLATION_ID?.trim();
  if (!rawId) return undefined;

  const stateFilePath = resolveStateFilePath(normalizeToolInstallationId(rawId));
  const state = readCollectorState(stateFilePath);
  if (!shouldAnnounceFailure(state) || !state) return undefined;

  const since = state.lastSuccessAt ? `since ${state.lastSuccessAt}` : "and has never succeeded on this machine";
  return {
    text:
      `Ascenda note: work telemetry has not been reaching Ascenda ${since} ` +
      `(${describeOutcome(state)}). Your work is unaffected and nothing was lost from this session. ` +
      `Run \`npx @ascenda-one/claude-code-hooks doctor\` for details, or ` +
      `\`npx @ascenda-one/claude-code-hooks pair\` to reconnect. This note appears once.`,
    state,
    stateFilePath
  };
}

function describeOutcome(state: CollectorState): string {
  // The caller already wraps this in parentheses, so the status is joined with
  // a comma rather than nested brackets.
  const status = state.httpStatus ? `, HTTP ${state.httpStatus}` : "";
  switch (state.lastOutcome) {
    case "auth_failed": return `the write token was rejected${status}`;
    case "consent_missing": return `the telemetry consent lease has lapsed${status}`;
    case "validation_failed": return `the events were refused as invalid${status}`;
    case "transport_error": return `the ingest endpoint could not be reached${status}`;
    default: return `last outcome ${state.lastOutcome}${status}`;
  }
}

/**
 * Resolves only once the bytes have left this process.
 *
 * `main()` ends in `process.exit(0)`, which does not wait for a pending write
 * to a pipe — and this hook's stdout is always a pipe. An un-awaited write here
 * could be truncated to nothing, taking the session's context injection with
 * it, intermittently and with no error anywhere.
 */
function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

/**
 * What we needed on 17 Aug 2026 and had to reconstruct by reading `dist/`.
 *
 * Answers the four questions a stalled collector raises, in order: who am I,
 * do I hold a credential, what happened last time I tried, and does it work
 * right now. The last one is a real send rather than a reachability ping —
 * a `/health` that returns 200 while ingest 403s is exactly the reassurance
 * that made this bug expensive.
 */
async function runDoctor(): Promise<void> {
  const lines: string[] = ["Ascenda collector doctor", ""];
  const rawId = process.env.ASCENDA_TOOL_INSTALLATION_ID?.trim();
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? "https://api.ascenda.one").replace(/\/$/, "");

  lines.push(`  API base URL          ${apiBaseUrl}`);
  lines.push(`  Installation id       ${rawId || "(unset — ASCENDA_TOOL_INSTALLATION_ID is empty)"}`);

  if (!rawId) {
    lines.push("", "  Not paired on this machine. Run:", "    npx @ascenda-one/claude-code-hooks pair");
    await writeStdout(`${lines.join("\n")}\n`);
    return;
  }

  const toolInstallationId = normalizeToolInstallationId(rawId);
  const tokenFilePath = process.env.ASCENDA_EVENT_WRITE_TOKEN_FILE ?? defaultTokenFilePath(toolInstallationId);
  lines.push(`  Token file            ${tokenFilePath}`);
  lines.push(`  Token                 ${describeToken(tokenFilePath)}`);

  const stateFilePath = resolveStateFilePath(toolInstallationId);
  lines.push(`  Journal               ${stateFilePath}`);
  const state = readCollectorState(stateFilePath);
  if (!state) {
    // Now a distinguishable state rather than an ambiguous silence: no journal
    // means no send was ever attempted by a build that writes one.
    lines.push("  Last outcome          (no journal yet — no send attempted since this version was installed)");
  } else {
    lines.push(`  Last attempt          ${state.lastAttemptAt}`);
    lines.push(`  Last success          ${state.lastSuccessAt ?? "never"}`);
    lines.push(`  Last outcome          ${state.lastOutcome}${state.httpStatus ? ` (HTTP ${state.httpStatus})` : ""}`);
    if (state.errorCode) lines.push(`  Error code            ${state.errorCode}`);
    if (state.detail) lines.push(`  Detail                ${state.detail}`);
    lines.push(`  Consecutive failures  ${state.consecutiveFailures}`);
    if (state.failingSince) lines.push(`  Failing since         ${state.failingSince}`);
  }

  lines.push("", "  Live round trip...");
  lines.push(`  ${await liveRoundTrip()}`);
  await writeStdout(`${lines.join("\n")}\n`);
}

async function liveRoundTrip(): Promise<string> {
  let config;
  try {
    config = loadConfigFromEnv();
  } catch (error) {
    return `skipped — ${error instanceof Error ? error.message : String(error)}`;
  }

  // A real, low-severity event through the real sender: same endpoint, same
  // token, same consent scope as every hook. Anything narrower can pass while
  // the path that matters fails.
  const result = await new AscendaClient(config).send({ eventType: "editor_activity", severity: "low", metadata: {} });
  if (result === "accepted") return "OK — event accepted by the ingest endpoint.";
  return `FAILED — ${explainRejection(result)}`;
}

function describeToken(tokenFilePath: string): string {
  try {
    if (!fs.existsSync(tokenFilePath)) {
      return process.env.ASCENDA_EVENT_WRITE_TOKEN ? "from ASCENDA_EVENT_WRITE_TOKEN (no file)" : "MISSING — run `pair`";
    }
    const stat = fs.statSync(tokenFilePath);
    const ageDays = Math.floor((Date.now() - stat.mtimeMs) / 86_400_000);
    return `present, last written ${stat.mtime.toISOString()} (${ageDays}d ago)`;
  } catch (error) {
    return `unreadable — ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function readJsonFromStdin(): Promise<ClaudeHookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as ClaudeHookInput;
}

main()
  .catch((error) => {
    // Never exit non-zero *on a hook path*: Claude Code treats exit 2 as a
    // blocking error and feeds stderr back to the model, and any other non-zero
    // code surfaces in the user's transcript. Failing to report telemetry is not
    // a failure of the user's work, so problems are journalled and swallowed.
    // `doctor` is the place to diagnose them.
    console.error(error instanceof Error ? error.message : String(error));
  })
  // Reads `exitCode` rather than forcing 0, so `pair` can still report that it
  // timed out or was declined — it is a command a person runs and reads, not a
  // hook, and it previously set an exit code that this line discarded. No hook
  // path sets `exitCode`, so their guarantee is unchanged.
  .finally(() => process.exit(process.exitCode ?? 0));
