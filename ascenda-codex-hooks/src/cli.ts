#!/usr/bin/env node
import { AscendaEventSender } from "@ascenda-one/tool-kit";
import { loadConfigFromEnv } from "./config.js";
import { mapCodexEvent } from "./mapCodexEvent.js";
import { consumeTurnDurationMs, recordTurnStart } from "./turnState.js";
import { CodexHookEventName, CodexHookInput } from "./types.js";

/**
 * Codex command hook entry point. Contract with Codex: exit code 2 BLOCKS the
 * user's action, so this adapter always exits 0 - telemetry failures must
 * never stall or block the engineer. Problems surface as a one-line
 * systemMessage (shown by Codex) or stderr, and the hook moves on.
 */
async function main(): Promise<void> {
  const hookName = process.argv[2] as CodexHookEventName | undefined;
  if (!hookName) {
    console.error("Usage: ascenda-codex-hook <CodexHookEventName>");
    return;
  }

  const input = await readJsonFromStdin();
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;

  let turnDurationMs: number | undefined;
  if (hookName === "UserPromptSubmit") recordTurnStart(sessionId);
  if (hookName === "Stop") turnDurationMs = consumeTurnDurationMs(sessionId);

  const mappedEvents = mapCodexEvent(hookName, input, turnDurationMs);
  if (mappedEvents.length === 0) return;

  const config = loadConfigFromEnv(sessionId);
  const sender = new AscendaEventSender({
    apiBaseUrl: config.apiBaseUrl,
    toolInstallationId: config.toolInstallationId,
    source: "cli_agent",
    eventWriteToken: config.eventWriteToken,
    tokenFilePath: config.tokenFilePath,
    sessionId: config.sessionId,
    workspaceHash: config.workspaceHash,
    timeoutMs: config.timeoutMs
  });

  // Every outcome below is also written to the shared send journal at
  // ~/.ascenda/state/<installationId>.json by the sender itself, so a Codex
  // collector that stops delivering leaves the same readable trail a Claude
  // Code one does — including its successes, which is what makes "stale
  // journal" mean "never ran" rather than "healthy".
  for (const event of mappedEvents) {
    const result = await sender.send(event);
    if (result === "consent_missing") {
      emitSystemMessage("Ascenda telemetry paused: renew IDE telemetry consent in the Ascenda app.");
      return;
    }
    if (result === "auth_failed") {
      emitSystemMessage("Ascenda telemetry paused: connection revoked or expired. Re-pair via an Ascenda IDE extension or pairing-sim.");
      return;
    }
    if (result === "transport_error") {
      emitSystemMessage("Ascenda telemetry paused: the ingest endpoint could not be reached. Your work is unaffected.");
      return;
    }
    if (result !== "accepted") {
      console.error(`Ascenda telemetry rejected: ${result}`);
      return;
    }
  }
}

function emitSystemMessage(message: string): void {
  console.log(JSON.stringify({ continue: true, systemMessage: message, suppressOutput: true }));
}

async function readJsonFromStdin(): Promise<CodexHookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CodexHookInput;
  } catch {
    return {};
  }
}

main()
  .catch((error) => {
    // Never exit non-zero: Codex treats exit 2 as a block and other codes as
    // hook failure. Telemetry problems are reported, then swallowed.
    console.error(error instanceof Error ? error.message : String(error));
  })
  .finally(() => process.exit(0));
