#!/usr/bin/env node
import { consumeTurnDurationMs, deliverHookEvents, emitLiveSignal, isCliAgentManagementCommand, recordTurnStart, runCliAgentSetup } from "@ascenda-one/tool-kit";
import { mapCodexEvent } from "./mapCodexEvent.js";
import { liveSignalFor } from "./liveSignal.js";
import { SETUP } from "./setup.js";
import { ASCENDA_TOOL_TYPE, CODEX_HOST, CodexHookEventName, CodexHookInput } from "./types.js";

/**
 * Codex command hook entry point. Contract with Codex: exit code 2 BLOCKS the
 * user's action, so this adapter always exits 0 - telemetry failures must
 * never stall or block the engineer. Problems surface as a one-line
 * systemMessage (shown by Codex) or stderr, and the hook moves on.
 *
 * Two modes on one binary: hook events are the hot path, the lowercase
 * management commands (`setup`, `status`, `uninstall`) are what a person
 * types. Codex hook names are all TitleCase, so the two cannot collide.
 * Management runs before stdin is read - it carries no payload, and reading
 * first would hang on a pipe nothing will ever write to.
 */
async function main(): Promise<void> {
  const command = process.argv[2];
  if (isCliAgentManagementCommand(command)) {
    managementExitCode = await runCliAgentSetup(process.argv.slice(2), SETUP);
    return;
  }

  const hookName = command as CodexHookEventName | undefined;
  if (!hookName) {
    console.error("Usage: ascenda-codex-hook <CodexHookEventName> | setup | status | uninstall");
    return;
  }

  const input = await readJsonFromStdin();
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;

  let turnDurationMs: number | undefined;
  if (hookName === "UserPromptSubmit") recordTurnStart(CODEX_HOST, sessionId);
  if (hookName === "Stop") turnDurationMs = consumeTurnDurationMs(CODEX_HOST, sessionId);

  // The local live bus, before the cloud send. See `emitLive` below.
  await emitLive(hookName, input, sessionId);

  await deliverHookEvents(mapCodexEvent(hookName, input, turnDurationMs), {
    toolType: ASCENDA_TOOL_TYPE,
    host: CODEX_HOST,
    setupCommand: `npx ${SETUP.packageName} setup`,
    source: "cli_agent",
    sessionId,
    onNotice: emitSystemMessage
  });
  // Delivery, including the notices above, is `deliverHookEvents` in tool-kit.
  // Every outcome it sees is also written to the shared send journal at
  // ~/.ascenda/state/<installationId>.json by the sender underneath it, so a
  // Codex collector that stops delivering leaves the same readable trail a
  // Claude Code one does — successes included, which is what makes a stale
  // journal mean "never ran" rather than "healthy".
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
async function emitLive(hookName: CodexHookEventName, input: CodexHookInput, sessionId: string | undefined): Promise<void> {
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
      tool: CODEX_HOST,
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
    // Never exit non-zero from a hook: Codex treats exit 2 as a block and
    // other codes as hook failure. Telemetry problems are reported, then
    // swallowed. Only `setup`/`status`/`uninstall`, which no hook invokes,
    // may return a code - `status` is meant to gate a CI step.
    console.error(error instanceof Error ? error.message : String(error));
  })
  .finally(() => process.exit(managementExitCode ?? 0));
