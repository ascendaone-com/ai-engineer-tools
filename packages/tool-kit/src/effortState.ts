import * as fs from "fs";
import * as path from "path";
import { ascendaHome } from "./tokenStore";

/**
 * The last effort level a hook sent for a session, so the next hook can tell
 * whether it changed. Effort arrives on every Claude Code payload; sending it
 * on every event would repeat one value hundreds of times a session. Each hook
 * is its own process, so the value lives in a small file beside the turn
 * state, under `~/.ascenda/state/` (or `ASCENDA_STATE_DIR`).
 *
 * Every failure degrades quietly. A read that fails returns `undefined`, which
 * makes the next level look new and sends it again: one repeated value, never
 * a lost one.
 */
const stateDir = (): string => process.env.ASCENDA_STATE_DIR ?? path.join(ascendaHome(), "state");

function effortFile(agent: string, sessionId: string): string {
  return path.join(stateDir(), `${sanitize(agent)}-effort-${sanitize(sessionId)}`);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function readSentEffortLevel(agent: string, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  try {
    const level = fs.readFileSync(effortFile(agent, sessionId), "utf8").trim();
    return level || undefined;
  } catch {
    return undefined;
  }
}

export function recordSentEffortLevel(agent: string, sessionId: string | undefined, level: string): void {
  if (!sessionId || !level) return;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(effortFile(agent, sessionId), level, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Next hook re-sends the level. See the module note.
  }
}

/** Called when a session ends, so a finished session leaves no file behind. */
export function clearSentEffortLevel(agent: string, sessionId: string | undefined): void {
  if (!sessionId) return;
  try {
    fs.rmSync(effortFile(agent, sessionId), { force: true });
  } catch {
    // Nothing to do: a stale file costs one skipped repeat on a resumed id.
  }
}
