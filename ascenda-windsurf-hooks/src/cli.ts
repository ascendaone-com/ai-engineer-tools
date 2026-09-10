#!/usr/bin/env node
import { consumeTurnDurationMs, deliverHookEvents, emitLiveSignal, isCliAgentManagementCommand, recordTurnStart, runCliAgentSetup } from "@ascenda-one/tool-kit";
import { mapWindsurfEvent } from "./mapWindsurfEvent.js";
import { liveSignalFor } from "./liveSignal.js";
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

  // The local live bus, before the cloud send. See `emitLive` below.
  await emitLive(hookName, input, sessionId);

  await deliverHookEvents(mapWindsurfEvent(hookName, input, turnDurationMs), {
    toolType: ASCENDA_TOOL_TYPE,
    host: WINDSURF_HOST,
    setupCommand: `npx ${SETUP.packageName} setup`,
    source: "cli_agent",
    sessionId
  });
}

/**
 * Whisper this hook's moment to the desktop app's live bus — the local Unix
 * socket the Ascenda Flow macOS app binds. Additive and best-effort: it is
 * the sole input to the waterline gauges, the Away Mode keep-awake
 * assertion, the settle bell and the screen saver's paired handoff, none of
 * which the cloud path can serve, and it is not itself telemetry — nothing
 * leaves the machine and nothing is stored.
 *
 * Placed before the cloud send and above anything that can fail on an
 * unpaired machine: a local display cue owes nothing to a backend pairing,
 * and gating it on one would leave the gauges dark for exactly the people
 * still setting Ascenda up. {@link emitLiveSignal} abandons a write after
 * 50ms and swallows every error, so this cannot stall or break the send;
 * the try/catch is belt-and-braces so a future change here can't take a
 * user's turn down with it.
 */
async function emitLive(hookName: WindsurfHookEventName, input: WindsurfHookInput, sessionId: string | undefined): Promise<void> {
  const body = liveSignalFor(hookName, input);
  if (!body) return;
  try {
    await emitLiveSignal({
      // This host's own name, not the shared `cli_agent` tool type the cloud
      // path files these events under. The app keys one decaying envelope per
      // `tool/session` pair, so reporting a value shared with the other CLI
      // adapters would fuse three different agents into one stream and make
      // the concurrency gauge under-count. `ASCENDA_TOOL_TYPE` is deliberately
      // *not* honoured here for the same reason: it is the cloud tool type,
      // and on this adapter that value is the shared one.
      tool: WINDSURF_HOST,
      // Concurrent sessions must count as separate streams for the X gauge.
      // Without a session id every window collapses into one, so fall back to
      // this process's parent — still per-session in practice, since the hook
      // is spawned from the session process.
      session: sessionId ?? `ppid-${process.ppid}`,
      ...body
    });
  } catch {
    // A cosmetic gauge is never worth a word in the user's transcript.
  }
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
