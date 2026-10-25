#!/usr/bin/env node
import { consumeTurnDurationMs, deliverHookEvents, flushHookOutbox, OUTBOX_FLUSH_COMMAND, emitLiveSignal, isCliAgentManagementCommand, stampLastHook, recordTurnStart, readTurnPromptId, runCliAgentSetup } from "@ascenda-one/tool-kit";
import { mapCopilotEvent } from "./mapCopilotEvent.js";
import { liveSignalFor } from "./liveSignal.js";
import { SETUP } from "./setup.js";
import { ASCENDA_TOOL_TYPE, COPILOT_HOST, CopilotHookEventName, CopilotHookInput } from "./types.js";

/**
 * GitHub Copilot CLI hook entry point. Always exits 0: telemetry must never
 * stand in the way of a tool call.
 *
 * The payload doesn't name its hook, so setup registers each one as
 * `<binary> <hookName>` and the name arrives as argv[2].
 *
 * The management commands (`setup`, `status`, `uninstall`) are checked
 * before stdin is read: they carry no payload, and reading first would hang
 * on a pipe nothing will ever write to.
 */
async function main(): Promise<void> {
  // A detached flusher started by an earlier hook, not a hook: no stdin, no
  // agent waiting. See backgroundDelivery.ts in tool-kit.
  if (process.argv[2] === OUTBOX_FLUSH_COMMAND) {
    await flushHookOutbox({ toolType: ASCENDA_TOOL_TYPE, host: COPILOT_HOST, source: "cli_agent" });
    return;
  }
  if (isCliAgentManagementCommand(process.argv[2])) {
    managementExitCode = await runCliAgentSetup(process.argv.slice(2), SETUP);
    return;
  }

  const hookName = process.argv[2] as CopilotHookEventName | undefined;
  if (!hookName) {
    console.error("Usage: ascenda-copilot-hook <hookName> | setup | status | uninstall");
    return;
  }
  const input = await readJsonFromStdin();

  const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;

  let turnDurationMs: number | undefined;
  // That this agent ran a hook at all, for `status` and `doctor`.
  stampLastHook(COPILOT_HOST, hookName);
  // No hook names the prompt a turn answers, so the prompt hook mints an id
  // and the rest read it back. `sessionStart` can arrive after the first
  // prompt, so it reads like any other hook and resets nothing. Read before
  // `agentStop` consumes the state.
  const promptId = hookName === "userPromptSubmitted"
    ? recordTurnStart(COPILOT_HOST, sessionId)
    : readTurnPromptId(COPILOT_HOST, sessionId);
  if (hookName === "agentStop") turnDurationMs = consumeTurnDurationMs(COPILOT_HOST, sessionId);

  // Where the work happened, for the repository and branch keys.
  const workDir = typeof input.cwd === "string" ? input.cwd : undefined;

  // The local live bus, before the cloud send. See `emitLive` below.
  await emitLive(hookName, input, sessionId);

  await deliverHookEvents(mapCopilotEvent(hookName, input, turnDurationMs), {
    toolType: ASCENDA_TOOL_TYPE,
    host: COPILOT_HOST,
    setupCommand: `npx ${SETUP.packageName} setup`,
    source: "cli_agent",
    sessionId,
    promptId,
    cwd: workDir,
    forgeKeys: true
  });
}

/**
 * Whisper this hook's moment to the desktop app's live bus, the local Unix
 * socket the Ascenda Flow macOS app binds. Additive and best-effort, and
 * placed before anything that can fail on an unpaired machine: a local
 * display cue owes nothing to a backend pairing. {@link emitLiveSignal}
 * abandons a write after 50ms and swallows every error; the try/catch is
 * belt-and-braces.
 */
async function emitLive(hookName: CopilotHookEventName, input: CopilotHookInput, sessionId: string | undefined): Promise<void> {
  const body = liveSignalFor(hookName, input);
  if (!body) return;
  try {
    await emitLiveSignal({
      // This host's own name, not the shared `cli_agent` tool type: the app
      // keys one stream per `tool`/`session` pair, and a shared name would
      // fuse the CLI adapters into one.
      tool: COPILOT_HOST,
      // No agent PID: Copilot CLI has no process rule in `AGENT_PROCESS`
      // yet, so streams are keyed by session, falling back to this process's
      // parent when the payload names none.
      session: sessionId ?? `ppid-${process.ppid}`,
      ...body
    });
  } catch {
    // A cosmetic gauge is never worth a word in the user's transcript.
  }
}

/** Only the management commands set this. Hook invocations always exit 0. */
let managementExitCode: number | undefined;

async function readJsonFromStdin(): Promise<CopilotHookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CopilotHookInput;
  } catch {
    return {};
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  })
  .finally(() => process.exit(managementExitCode ?? 0));
