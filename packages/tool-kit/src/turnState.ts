import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ascendaHome } from "./tokenStore";

/**
 * Agent turn-length tracking for one-shot hook adapters.
 *
 * No agent's turn-end hook carries a duration — Codex's Stop, Cursor's `stop`,
 * Windsurf's `post_cascade_response` and Gemini's `AfterAgent` all arrive bare.
 * So the prompt hook records a start timestamp per session and the turn-end
 * hook consumes it. State lives in small files because each hook invocation is
 * a separate process that cannot see the last one's memory.
 *
 * Every failure degrades to "no duration": telemetry must never break the agent.
 */
// Same base as the send journal: `ASCENDA_HOME` moves the whole ~/.ascenda
// tree, `ASCENDA_STATE_DIR` overrides just this directory.
const stateDir = (): string => process.env.ASCENDA_STATE_DIR ?? path.join(ascendaHome(), "state");

function turnFile(agent: string, sessionId: string): string {
  return path.join(stateDir(), `${sanitize(agent)}-turn-${sanitize(sessionId)}`);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Marks the start of a turn and mints its prompt id: a random UUID, never
 * derived from the prompt. These agents give hooks no id of their own for the
 * prompt a turn answers, so the collector makes one and every event of the turn
 * carries it (see {@link readTurnPromptId}). Returns undefined when there is no
 * session to key the state on or the file can't be written.
 */
export function recordTurnStart(agent: string, sessionId: string | undefined, now = Date.now()): string | undefined {
  if (!sessionId) return undefined;
  try {
    const promptId = randomUUID();
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(turnFile(agent, sessionId), `${now} ${promptId}`, { encoding: "utf8", mode: 0o600 });
    return promptId;
  } catch {
    return undefined;
  }
}

/**
 * The prompt id minted at the start of the turn in progress, without ending it.
 * Read before {@link consumeTurnDurationMs} on the turn's last hook, which
 * removes the file. Undefined outside a turn, and for a file an older release
 * wrote with a timestamp alone.
 */
export function readTurnPromptId(agent: string, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  try {
    const id = fs.readFileSync(turnFile(agent, sessionId), "utf8").trim().split(/\s+/)[1];
    return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export function consumeTurnDurationMs(agent: string, sessionId: string | undefined, now = Date.now()): number | undefined {
  if (!sessionId) return undefined;
  const file = turnFile(agent, sessionId);
  try {
    const started = Number(fs.readFileSync(file, "utf8").trim().split(/\s+/)[0]);
    fs.rmSync(file, { force: true });
    if (!Number.isFinite(started) || started <= 0 || started > now) return undefined;
    return now - started;
  } catch {
    return undefined;
  }
}
