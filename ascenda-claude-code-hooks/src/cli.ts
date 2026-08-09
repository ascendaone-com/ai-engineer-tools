#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  bucketPromptSize,
  createPairingSession,
  defaultTokenFilePath,
  emitLiveSignal,
  getPairingStatus,
  getString,
  getNestedString,
  persistEventWriteToken
} from "@ascenda-one/tool-kit";
import type { LiveBusEvent } from "@ascenda-one/tool-kit";
import { AscendaClient } from "./ascendaClient.js";
import { loadConfigFromEnv } from "./config.js";
import { isNewSessionStart, mapClaudeEvent, milestoneInviting } from "./mapClaudeEvent.js";
import { ASCENDA_TOOL_TYPE, ClaudeHookEventName, ClaudeHookInput } from "./types.js";

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
  process.stdout.write(
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
    process.stdout.write(
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
  const hookName = process.argv[2] as ClaudeHookEventName | "pair" | undefined;
  if (!hookName) throw new Error("Usage: ascenda-claude-hook <ClaudeHookEventName> | pair");

  // Before the stdin read below — `pair` is interactive-ish and has no hook
  // payload; reading stdin first would hang it forever.
  if (hookName === "pair") {
    await runPair();
    return;
  }

  const input = await readJsonFromStdin();

  // Local, network-independent, and unconditional on pairing state: a
  // broken pairing (or the network being down) must not silently suppress
  // this too, so it happens before anything that can fail below.
  if (hookName === "SessionStart" && isNewSessionStart(input) && process.env.ASCENDA_DISABLE_INTENTION_INVITE !== "true") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: INTENTION_INVITE }
    }));
  }

  // Same placement and the same reasoning as the intention invite above: local,
  // network-independent, and before anything that can fail, so a broken pairing
  // never silently costs the user the prompt.
  if (hookName === "PostToolUse" && milestoneInviting(input) && process.env.ASCENDA_DISABLE_MILESTONE_DEBRIEF !== "true") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: MILESTONE_DEBRIEF_INVITE }
    }));
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
    if (result === "consent_missing") {
      console.error("Ascenda telemetry rejected: renew IDE telemetry consent in the Ascenda app.");
      return;
    }
    if (result === "auth_failed") {
      console.error("Ascenda telemetry rejected: event write token invalid or revoked. Re-pair via the VS Code/Cursor extension.");
      return;
    }
    if (result !== "accepted") {
      console.error(`Ascenda telemetry rejected: ${result}`);
      return;
    }
  }
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
    // Never exit non-zero: Claude Code treats exit 2 as a blocking error and
    // feeds stderr back to the model, and any other non-zero code surfaces in
    // the user's transcript. Failing to report telemetry is not a failure of
    // the user's work, so problems are printed to stderr and swallowed.
    // `ascenda doctor` (installer M2) is the place to diagnose them.
    console.error(error instanceof Error ? error.message : String(error));
  })
  .finally(() => process.exit(0));
