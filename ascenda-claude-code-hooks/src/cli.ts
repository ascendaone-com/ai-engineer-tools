#!/usr/bin/env node
import { AscendaClient } from "./ascendaClient.js";
import { loadConfigFromEnv } from "./config.js";
import { mapClaudeEvent } from "./mapClaudeEvent.js";
import { ClaudeHookEventName, ClaudeHookInput } from "./types.js";

async function main(): Promise<void> {
  const hookName = process.argv[2] as ClaudeHookEventName | undefined;
  if (!hookName) throw new Error("Usage: ascenda-claude-hook <ClaudeHookEventName>");

  const input = await readJsonFromStdin();
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
