#!/usr/bin/env node
import { consumeTurnDurationMs, deliverHookEvents, isCliAgentManagementCommand, recordTurnStart, runCliAgentSetup } from "@ascenda-one/tool-kit";
import { mapWindsurfEvent } from "./mapWindsurfEvent.js";
import { SETUP } from "./setup.js";
import { ASCENDA_TOOL_TYPE, WINDSURF_HOST, WindsurfHookEventName, WindsurfHookInput } from "./types.js";

/**
 * Cascade hook entry point. Cascade treats exit code 2 from a pre_* hook as
 * "block this action", so this adapter always exits 0 — telemetry must never
 * block the engineer's work.
 *
 * Cascade passes the event name in `agent_action_name`, so unlike the other
 * adapters the argv hook name is optional and only used as a fallback.
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
  const hookName = (typeof input.agent_action_name === "string" ? input.agent_action_name : process.argv[2]) as WindsurfHookEventName | undefined;
  if (!hookName) {
    console.error("Usage: ascenda-windsurf-hook <hook_event_name> | setup | status | uninstall  (hooks may supply agent_action_name on stdin instead)");
    return;
  }

  // trajectory_id is the conversation; execution_id is one turn within it.
  const sessionId = typeof input.trajectory_id === "string" ? input.trajectory_id : undefined;

  let turnDurationMs: number | undefined;
  if (hookName === "pre_user_prompt") recordTurnStart(WINDSURF_HOST, sessionId);
  if (hookName === "post_cascade_response") turnDurationMs = consumeTurnDurationMs(WINDSURF_HOST, sessionId);

  await deliverHookEvents(mapWindsurfEvent(hookName, input, turnDurationMs), {
    toolType: ASCENDA_TOOL_TYPE,
    host: WINDSURF_HOST,
    setupCommand: `npx ${SETUP.packageName} setup`,
    source: "cli_agent",
    sessionId
  });
}

/** Only the management commands set this. Hook invocations always exit 0. */
let managementExitCode: number | undefined;

async function readJsonFromStdin(): Promise<WindsurfHookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as WindsurfHookInput;
  } catch {
    return {};
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  })
  .finally(() => process.exit(managementExitCode ?? 0));
