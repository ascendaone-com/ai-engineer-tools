#!/usr/bin/env node
import { appendEventLog, buildEventPayload, resolveEventLogPath } from "@ascenda-one/tool-kit";
import { AscendaClient } from "./ascendaClient.js";
import { loadConfigFromEnv } from "./config.js";
import { isNewSessionStart, mapClaudeEvent, milestoneInviting } from "./mapClaudeEvent.js";
import { ASCENDA_TOOL_TYPE, ClaudeHookEventName, ClaudeHookInput, MappedAscendaEvent } from "./types.js";

const INTENTION_INVITE =
  "Ascenda tip: if it's natural, you can ask what would make this session " +
  "count before diving in — one line is enough. Not a required step, " +
  "and skip it entirely if the user is already mid-task.";

/**
 * The milestone debrief (H1). The bookend to the intention invite: that one
 * asks what would make the session count, this one asks — at the moment a
 * piece of work actually ended — what it cost and what carries forward.
 *
 * Three deliberate restraints. It fires only on a *completion* (a merge, a
 * closed ticket), never on a handoff, so it lands where a person is already
 * pausing. It asks about the work, not the person — the same discipline the
 * shutdown ritual keeps. And it stays an invitation: only the model that can
 * see whether the user is already onto the next thing should decide whether
 * asking is welcome.
 */
const MILESTONE_DEBRIEF_INVITE =
  "Ascenda tip: that finished a piece of work. If the moment suits, it's " +
  "worth a short debrief — what moved, what's still unresolved, and what " +
  "you'd do differently next time. One or two lines. Skip it if they're " +
  "already onto the next thing.";

async function main(): Promise<void> {
  const hookName = process.argv[2] as ClaudeHookEventName | undefined;
  if (!hookName) throw new Error("Usage: ascenda-claude-hook <ClaudeHookEventName>");

  const input = await readJsonFromStdin();

  // Local, network-independent, and unconditional on pairing state: a
  // broken pairing (or the network being down) must not silently suppress
  // this too, so it happens before anything that can fail below.
  if (hookName === "SessionStart" && isNewSessionStart(input) && process.env.ASCENDA_DISABLE_INTENTION_INVITE !== "true") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: INTENTION_INVITE }
    }));
  }

  // Same placement and the same reasoning as the intention invite above: local,
  // network-independent, and before anything that can fail, so a broken pairing
  // never silently costs the user the prompt.
  if (hookName === "PostToolUse" && milestoneInviting(input) && process.env.ASCENDA_DISABLE_MILESTONE_DEBRIEF !== "true") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: MILESTONE_DEBRIEF_INVITE }
    }));
  }

  const mappedEvents = mapClaudeEvent(hookName, input);
  if (!mappedEvents.length) return;

  let config;
  try {
    config = loadConfigFromEnv();
  } catch (error) {
    // With a log file configured, an unpaired install is a supported mode, not
    // a failure: you can watch exactly what this tool would transmit before
    // deciding to pair. Without one there is nowhere for the event to go.
    const logFile = resolveEventLogPath();
    if (!logFile) throw error;
    for (const event of mappedEvents) logUnsent(logFile, event);
    return;
  }

  const client = new AscendaClient(config);

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

/**
 * The id is a placeholder because there is no pairing to name — `not_sent`
 * plus this value is what distinguishes these lines from delivered ones.
 */
function logUnsent(logFile: string, event: MappedAscendaEvent): void {
  const payload = buildEventPayload({
    toolInstallationId: `${ASCENDA_TOOL_TYPE}:unpaired`,
    source: "claude_code",
    sessionId: process.env.ASCENDA_SESSION_ID ?? null,
    workspaceHash: process.env.ASCENDA_WORKSPACE_HASH ?? null
  }, event);
  appendEventLog(logFile, { loggedAt: new Date().toISOString(), delivery: "not_sent", payload });
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
