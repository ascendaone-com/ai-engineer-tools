#!/usr/bin/env node
import { consumeTurnDurationMs, deliverHookEvents, recordTurnStart } from "@ascenda-one/tool-kit";
import { mapCursorEvent } from "./mapCursorEvent.js";
import { ASCENDA_TOOL_TYPE, CURSOR_HOST, CursorHookEventName, CursorHookInput } from "./types.js";

/**
 * Cursor agent hook entry point. Cursor treats exit code 2 as "deny the
 * action", so this adapter always exits 0 — telemetry must never block the
 * engineer's work. Problems go to stderr and the hook moves on.
 */
async function main(): Promise<void> {
  const hookName = process.argv[2] as CursorHookEventName | undefined;
  if (!hookName) {
    console.error("Usage: ascenda-cursor-hook <cursorHookEventName>");
    return;
  }

  const input = await readJsonFromStdin();
  // Cursor identifies a conversation by conversation_id on every hook;
  // session_id only appears on sessionStart.
  const sessionId = typeof input.conversation_id === "string" ? input.conversation_id
    : typeof input.session_id === "string" ? input.session_id
    : undefined;

  let turnDurationMs: number | undefined;
  if (hookName === "beforeSubmitPrompt") recordTurnStart(CURSOR_HOST, sessionId);
  if (hookName === "stop") turnDurationMs = consumeTurnDurationMs(CURSOR_HOST, sessionId);

  await deliverHookEvents(mapCursorEvent(hookName, input, turnDurationMs), {
    toolType: ASCENDA_TOOL_TYPE,
    source: "cli_agent",
    sessionId
  });
}

async function readJsonFromStdin(): Promise<CursorHookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CursorHookInput;
  } catch {
    return {};
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  })
  .finally(() => process.exit(0));
