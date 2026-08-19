#!/usr/bin/env node
import { consumeTurnDurationMs, deliverHookEvents, recordTurnStart } from "@ascenda-one/tool-kit";
import { mapWindsurfEvent } from "./mapWindsurfEvent.js";
import { ASCENDA_TOOL_TYPE, WINDSURF_HOST, WindsurfHookEventName, WindsurfHookInput } from "./types.js";

/**
 * Cascade hook entry point. Cascade treats exit code 2 from a pre_* hook as
 * "block this action", so this adapter always exits 0 — telemetry must never
 * block the engineer's work.
 *
 * Cascade passes the event name in `agent_action_name`, so unlike the other
 * adapters the argv hook name is optional and only used as a fallback.
 */
async function main(): Promise<void> {
  const input = await readJsonFromStdin();
  const hookName = (typeof input.agent_action_name === "string" ? input.agent_action_name : process.argv[2]) as WindsurfHookEventName | undefined;
  if (!hookName) {
    console.error("Usage: ascenda-windsurf-hook <hook_event_name>  (or supply agent_action_name on stdin)");
    return;
  }

  // trajectory_id is the conversation; execution_id is one turn within it.
  const sessionId = typeof input.trajectory_id === "string" ? input.trajectory_id : undefined;

  let turnDurationMs: number | undefined;
  if (hookName === "pre_user_prompt") recordTurnStart(WINDSURF_HOST, sessionId);
  if (hookName === "post_cascade_response") turnDurationMs = consumeTurnDurationMs(WINDSURF_HOST, sessionId);

  await deliverHookEvents(mapWindsurfEvent(hookName, input, turnDurationMs), {
    toolType: ASCENDA_TOOL_TYPE,
    source: "cli_agent",
    sessionId
  });
}

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
  .finally(() => process.exit(0));
