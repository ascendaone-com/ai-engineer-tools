#!/usr/bin/env node
import { consumeTurnDurationMs, deliverHookEvents, isCliAgentManagementCommand, recordTurnStart, runCliAgentSetup } from "@ascenda-one/tool-kit";
import { mapGeminiEvent } from "./mapGeminiEvent.js";
import { SETUP } from "./setup.js";
import { ASCENDA_TOOL_TYPE, GEMINI_HOST, GeminiHookEventName, GeminiHookInput } from "./types.js";

/**
 * Gemini CLI hook entry point. Always exits 0 — a non-zero exit from a
 * BeforeTool hook blocks the tool call, and telemetry must never do that.
 *
 * Gemini supplies the event name in `hook_event_name`; argv is the fallback.
 *
 * The management commands (`setup`, `status`, `uninstall`) are checked
 * before stdin is read: they carry no payload, and reading first would hang
 * on a pipe nothing will ever write to.
 */
async function main(): Promise<void> {
  if (isCliAgentManagementCommand(process.argv[2])) {
    managementExitCode = await runCliAgentSetup(process.argv.slice(2), SETUP);
    return;
  }

  const input = await readJsonFromStdin();
  const hookName = (typeof input.hook_event_name === "string" ? input.hook_event_name : process.argv[2]) as GeminiHookEventName | undefined;
  if (!hookName) {
    console.error("Usage: ascenda-gemini-hook <HookEventName> | setup | status | uninstall  (hooks may supply hook_event_name on stdin instead)");
    return;
  }

  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;

  let turnDurationMs: number | undefined;
  if (hookName === "BeforeAgent") recordTurnStart(GEMINI_HOST, sessionId);
  if (hookName === "AfterAgent") turnDurationMs = consumeTurnDurationMs(GEMINI_HOST, sessionId);

  await deliverHookEvents(mapGeminiEvent(hookName, input, turnDurationMs), {
    toolType: ASCENDA_TOOL_TYPE,
    host: GEMINI_HOST,
    setupCommand: `npx ${SETUP.packageName} setup`,
    source: "cli_agent",
    sessionId
  });
}

/** Only the management commands set this. Hook invocations always exit 0. */
let managementExitCode: number | undefined;

async function readJsonFromStdin(): Promise<GeminiHookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as GeminiHookInput;
  } catch {
    return {};
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  })
  .finally(() => process.exit(managementExitCode ?? 0));
