import * as fs from "fs";
import * as path from "path";
import { ascendaHome } from "@ascenda-one/tool-kit";
import { getToolName, notificationKind, readSubagentId } from "./mapClaudeEvent.js";
import { getString } from "./safeExtract.js";
import type { ClaudeHookEventName, ClaudeHookInput, MappedAscendaEvent } from "./types.js";

/**
 * How long the agent waited on the person, worked out after the fact.
 *
 * Claude Code reports a wait starting (`PermissionRequest`, `Notification`)
 * and never reports it ending, so the end is inferred from the next hook that
 * could only have fired once someone answered. Each hook is its own process,
 * so the open waits live in a small file per session.
 *
 * What the inference is willing to claim:
 *
 *  - `inferred`: the next hook that answers it fired. The duration is the
 *    time to that hook.
 *  - `lower_bound`: more than one request was open at once (parallel tool
 *    calls), so a hook may have answered a sibling. The person waited at
 *    least this long.
 *  - `upper_bound`: the next thing seen was a new prompt, which is also what
 *    an interrupt looks like (Esc runs no hook). The person waited at most
 *    this long.
 *
 * Waits are kept per session and per subagent, so one agent's calls never
 * answer another's prompt.
 *
 * A question (`AskUserQuestion`) is timed from its own tool hooks: the tool
 * is the wait, so its PostToolUse is the answer and the duration is
 * `inferred`, or `lower_bound` when more than one question was open.
 *
 * Nothing here reads a message or a tool input. Only the notification's type
 * and the tool's name are looked at.
 */

export type WaitKind = "permission_request" | "input_request" | "idle_prompt" | "question";

/**
 * The tool Claude Code uses to put a multiple-choice question to the person.
 * It sends no Notification, so its own PreToolUse opens the wait and its
 * PostToolUse (or PostToolUseFailure, when the person dismisses it) closes it.
 */
export const QUESTION_TOOL = "AskUserQuestion";
export type WaitConfidence = "inferred" | "lower_bound" | "upper_bound";
export type WaitEndedBy = "tool_started" | "tool_finished" | "permission_denied" | "prompt_submitted";

/** A tool hook inside this window of a wait opening is a sibling call, not an answer. */
export const SETTLE_MS = 1500;
/** A second idle prompt this soon after the first is the same pause. */
export const IDLE_COOLDOWN_MS = 60_000;
/** A wait older than this was abandoned, and is dropped rather than reported. */
export const STALE_MS = 24 * 60 * 60 * 1000;

export type OpenWait = {
  startedAt: number;
  /** PermissionRequest hooks seen for this wait. A Notification alone leaves it 0. */
  requests: number;
  maxRequests: number;
  /** Set only by a PermissionRequest; a Notification never says which tool. */
  toolName?: string;
};

export type WaitState = {
  waits: Partial<Record<WaitKind, OpenWait>>;
  /** When each kind last opened, kept after it closes so a repeat can be absorbed. */
  lastStart: Partial<Record<WaitKind, number>>;
};

export type WaitAdvance = {
  state: WaitState;
  events: MappedAscendaEvent[];
  /** True for an idle prompt inside the cooldown; the caller drops its repeat interruption event. */
  suppressInterruption: boolean;
};

export const emptyWaitState = (): WaitState => ({ waits: {}, lastStart: {} });

const ANSWERABLE: readonly WaitKind[] = ["permission_request", "input_request"];

function startKind(hookName: ClaudeHookEventName, input: ClaudeHookInput): WaitKind | undefined {
  if (hookName === "PermissionRequest") return "permission_request";
  if (hookName !== "Notification") return undefined;
  const kind = notificationKind(getString(input, ["message"]), getString(input, ["notification_type", "notificationType"]));
  return kind === "other" ? undefined : kind;
}

function waitEvent(kind: WaitKind, wait: OpenWait, now: number, endedBy: WaitEndedBy, confidence: WaitConfidence): MappedAscendaEvent {
  return {
    eventType: "supervision_wait_ended",
    severity: "low",
    metadata: {
      interruptionKind: kind,
      waitMs: Math.max(0, Math.round(now - wait.startedAt)),
      waitEndedBy: endedBy,
      waitConfidence: wait.maxRequests > 1 && confidence === "inferred" ? "lower_bound" : confidence
    }
  };
}

export function advanceWait(previous: WaitState, hookName: ClaudeHookEventName, input: ClaudeHookInput, now: number): WaitAdvance {
  const state: WaitState = { waits: { ...previous.waits }, lastStart: { ...previous.lastStart } };
  const events: MappedAscendaEvent[] = [];
  let suppressInterruption = false;

  for (const kind of Object.keys(state.waits) as WaitKind[]) {
    const wait = state.waits[kind];
    if (wait && now - wait.startedAt > STALE_MS) delete state.waits[kind];
  }

  const opening = startKind(hookName, input);
  if (opening) {
    const open = state.waits[opening];
    const last = state.lastStart[opening];
    if (open) {
      // The Notification and the PermissionRequest for one prompt, or a repeat
      // idle prompt: the same wait.
      if (hookName === "PermissionRequest") {
        open.requests += 1;
        open.maxRequests = Math.max(open.maxRequests, open.requests);
        open.toolName ??= getToolName(input);
      }
      if (opening === "idle_prompt") suppressInterruption = true;
    } else if (opening === "idle_prompt" && last !== undefined && now - last < IDLE_COOLDOWN_MS) {
      suppressInterruption = true;
    } else if (opening !== "idle_prompt" && hookName === "Notification" && last !== undefined && now - last < SETTLE_MS) {
      // The Notification trailing a prompt that was answered at once.
    } else {
      const isRequest = hookName === "PermissionRequest";
      state.waits[opening] = { startedAt: now, requests: isRequest ? 1 : 0, maxRequests: isRequest ? 1 : 0, ...(isRequest && getToolName(input) ? { toolName: getToolName(input) } : {}) };
      state.lastStart[opening] = now;
    }
    return { state, events, suppressInterruption };
  }

  if (getToolName(input) === QUESTION_TOOL) {
    if (hookName === "PreToolUse") {
      const open = state.waits.question;
      if (open) {
        open.requests += 1;
        open.maxRequests = Math.max(open.maxRequests, open.requests);
      } else {
        state.waits.question = { startedAt: now, requests: 1, maxRequests: 1, toolName: QUESTION_TOOL };
        state.lastStart.question = now;
      }
      return { state, events, suppressInterruption };
    }
    if (hookName === "PostToolUse" || hookName === "PostToolUseFailure") {
      const open = state.waits.question;
      if (open) {
        open.requests -= 1;
        if (open.requests <= 0) {
          events.push(waitEvent("question", open, now, "tool_finished", "inferred"));
          delete state.waits.question;
        }
      }
      return { state, events, suppressInterruption };
    }
  }

  const close = (kind: WaitKind, endedBy: WaitEndedBy, confidence: WaitConfidence): void => {
    const wait = state.waits[kind];
    if (!wait) return;
    events.push(waitEvent(kind, wait, now, endedBy, confidence));
    delete state.waits[kind];
  };

  switch (hookName) {
    case "PreToolUse":
    case "PermissionDenied": {
      for (const kind of ANSWERABLE) {
        const wait = state.waits[kind];
        if (!wait) continue;
        // A sibling call that started alongside the prompt isn't the answer.
        if (hookName === "PreToolUse" && now - wait.startedAt < SETTLE_MS) continue;
        // The prompt named its tool; only a call to that tool answers it.
        const tool = getToolName(input);
        if (wait.toolName !== undefined && tool !== undefined && tool !== wait.toolName) continue;
        const outstanding = Math.max(1, wait.requests) - 1;
        if (outstanding > 0) {
          wait.requests = outstanding;
        } else {
          close(kind, hookName === "PreToolUse" ? "tool_started" : "permission_denied", "inferred");
        }
      }
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      // Normally the PreToolUse already closed it. This covers a missed one,
      // and only when no sibling request is still open.
      for (const kind of ANSWERABLE) {
        const wait = state.waits[kind];
        if (!wait || now - wait.startedAt < SETTLE_MS || wait.requests > 1) continue;
        close(kind, "tool_finished", "lower_bound");
      }
      break;
    }
    case "UserPromptSubmit": {
      for (const kind of ANSWERABLE) close(kind, "prompt_submitted", "upper_bound");
      close("question", "prompt_submitted", "upper_bound");
      close("idle_prompt", "prompt_submitted", "inferred");
      break;
    }
    case "Stop":
    case "StopFailure": {
      // The turn is over, so whatever it was waiting on is moot. No duration:
      // nothing says the person ever answered.
      for (const kind of ANSWERABLE) delete state.waits[kind];
      delete state.waits.question;
      break;
    }
    case "SessionEnd":
      state.waits = {};
      break;
    default:
      break;
  }
  return { state, events, suppressInterruption };
}

const stateDir = (): string => process.env.ASCENDA_STATE_DIR ?? path.join(ascendaHome(), "state");
const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, "_");

function waitFile(sessionId: string, agentId: string | undefined): string {
  return path.join(stateDir(), `claude-wait-${sanitize(sessionId)}${agentId ? `-${sanitize(agentId)}` : ""}.json`);
}

export function readWaitState(sessionId: string, agentId: string | undefined): WaitState {
  try {
    const parsed = JSON.parse(fs.readFileSync(waitFile(sessionId, agentId), "utf8")) as Partial<WaitState>;
    return { waits: parsed.waits ?? {}, lastStart: parsed.lastStart ?? {} };
  } catch {
    return emptyWaitState();
  }
}

export function writeWaitState(sessionId: string, agentId: string | undefined, state: WaitState): void {
  try {
    const file = waitFile(sessionId, agentId);
    if (Object.keys(state.waits).length === 0 && Object.keys(state.lastStart).length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  } catch {
    // A lost write loses one duration, never the hook.
  }
}

/**
 * The hook-side entry: read, advance, write. Never throws, and does no
 * network I/O, so it can't slow or block the agent.
 */
export function trackWait(hookName: ClaudeHookEventName, input: ClaudeHookInput, now: number = Date.now()): WaitAdvance {
  const sessionId = getString(input, ["session_id", "sessionId"]);
  if (!sessionId) return { state: emptyWaitState(), events: [], suppressInterruption: false };
  try {
    const agentId = readSubagentId(input);
    const advance = advanceWait(readWaitState(sessionId, agentId), hookName, input, now);
    if (hookName === "SessionEnd") {
      fs.rmSync(waitFile(sessionId, agentId), { force: true });
    } else {
      writeWaitState(sessionId, agentId, advance.state);
    }
    return advance;
  } catch {
    return { state: emptyWaitState(), events: [], suppressInterruption: false };
  }
}
