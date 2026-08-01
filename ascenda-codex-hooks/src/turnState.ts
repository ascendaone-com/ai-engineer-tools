import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Codex's Stop hook carries no duration, so agent-loop length is measured
 * here: UserPromptSubmit records a turn-start timestamp per session, Stop
 * consumes it. State lives in small files so each one-shot hook invocation
 * can see the previous one. All failures degrade to "no duration" silently -
 * telemetry must never break the agent.
 */
const STATE_DIR = () => process.env.ASCENDA_STATE_DIR ?? path.join(os.homedir(), ".ascenda", "state");

function turnFile(sessionId: string): string {
  return path.join(STATE_DIR(), `codex-turn-${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
}

export function recordTurnStart(sessionId: string | undefined, now = Date.now()): void {
  if (!sessionId) return;
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    fs.writeFileSync(turnFile(sessionId), String(now), { encoding: "utf8", mode: 0o600 });
  } catch {
    // best effort only
  }
}

export function consumeTurnDurationMs(sessionId: string | undefined, now = Date.now()): number | undefined {
  if (!sessionId) return undefined;
  const file = turnFile(sessionId);
  try {
    const started = Number(fs.readFileSync(file, "utf8").trim());
    fs.rmSync(file, { force: true });
    if (!Number.isFinite(started) || started <= 0 || started > now) return undefined;
    return now - started;
  } catch {
    return undefined;
  }
}
