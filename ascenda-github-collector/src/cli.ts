#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { AscendaEventSender } from "@ascenda-one/tool-kit";
import { loadConfigFromEnv } from "./config.js";
import { mapForgeEvent, ForgePayload } from "./mapForgeEvent.js";

/**
 * Reads one code-forge event and emits the viewer's own collaboration signals.
 *
 * Designed for a GitHub Actions step: the runner writes the webhook payload to
 * `GITHUB_EVENT_PATH` and names the event in `GITHUB_EVENT_NAME`. Both can be
 * overridden for local use, and the payload may be piped on stdin instead.
 *
 * Exits 0 on every path that is not a configuration error, including "nothing
 * to emit" — a telemetry step must never be the reason someone's CI goes red.
 */
async function main(): Promise<void> {
  const config = loadConfigFromEnv();

  const eventName = process.env.GITHUB_EVENT_NAME ?? process.argv[2];
  const payload = await readPayload();
  if (!payload) return;

  const events = mapForgeEvent(eventName, payload, config.viewerLogin);
  if (events.length === 0) return;

  const sender = new AscendaEventSender({
    apiBaseUrl: config.apiBaseUrl,
    toolInstallationId: config.toolInstallationId,
    source: "code_forge",
    eventWriteToken: config.eventWriteToken,
    tokenFilePath: config.tokenFilePath
  });

  for (const event of events) {
    const result = await sender.sendCollaborationSignal(event);
    if (result === "consent_missing") {
      console.error("Ascenda telemetry rejected: renew workflow telemetry consent in the Ascenda app.");
      return;
    }
    if (result === "auth_failed") {
      console.error("Ascenda telemetry rejected: event write token invalid or revoked.");
      return;
    }
    if (result !== "accepted") {
      console.error(`Ascenda telemetry rejected: ${result}`);
      return;
    }
  }
}

async function readPayload(): Promise<ForgePayload | undefined> {
  const path = process.env.GITHUB_EVENT_PATH;
  const raw = path ? await readFile(path, "utf8") : await readStdin();
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ForgePayload) : undefined;
  } catch {
    // A payload we cannot parse is not an error worth failing a build over.
    console.error("Ascenda collector: unreadable event payload, nothing emitted.");
    return undefined;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error) => {
  console.error(`Ascenda collector: ${error instanceof Error ? error.message : String(error)}`);
  // Configuration errors are worth reporting but never worth failing CI for.
  process.exit(0);
});
