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

export function recordTurnStart(agent: string, sessionId: string | undefined, now = Date.now()): void {
  if (!sessionId) return;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(turnFile(agent, sessionId), String(now), { encoding: "utf8", mode: 0o600 });
  } catch {
    // best effort only
  }
}

export function consumeTurnDurationMs(agent: string, sessionId: string | undefined, now = Date.now()): number | undefined {
  if (!sessionId) return undefined;
  const file = turnFile(agent, sessionId);
  try {
    const started = Number(fs.readFileSync(file, "utf8").trim());
    fs.rmSync(file, { force: true });
    if (!Number.isFinite(started) || started <= 0 || started > now) return undefined;
    return now - started;
  } catch {
    return undefined;
  }
}
