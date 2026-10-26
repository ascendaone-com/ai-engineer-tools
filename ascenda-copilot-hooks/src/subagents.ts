import * as fs from "fs";
import * as path from "path";
import { ascendaHome } from "@ascenda-one/tool-kit";
import { CopilotHookInput } from "./types.js";

/**
 * Inside a subagent, Copilot CLI sends the subagent's id as `sessionId`: the
 * parent's tool-call id for the subagent call (`call_…`). Shipped as it
 * arrives, the subagent's tool calls would land in a session of their own,
 * and its task prompt and its stop would count as a person's prompt and turn.
 *
 * `subagentStart` always fires first, under the real session id, with the
 * subagent's `agentId`. That pairing is kept in a small local file, so every
 * later hook whose `sessionId` is a known agent id can be filed under the
 * parent. A hook carrying a `parentAgentId` other than its own session is a
 * subagent hook too. Observed sequence: docs/COPILOT_MAPPING.md.
 *
 * Without a pairing (setup ran mid-session, or the file was lost) a hook is
 * attributed as it arrives. An unknown `call_…` id isn't guessed at.
 */
export interface Attribution {
  /** The session this hook's events belong to: the parent's for a subagent hook. */
  sessionId: string | undefined;
  /** Set when the hook fired inside a subagent: that subagent's id. */
  subagentId?: string;
}

interface Pairing {
  parent: string;
  at: string;
}

const KEPT_PAIRINGS = 200;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function subagentPairingsPath(): string {
  return path.join(process.env.ASCENDA_STATE_DIR ?? path.join(ascendaHome(), "state"), "copilot_cli-subagents.json");
}

/** An id from the payload, when it has the shape of one. */
export function payloadId(input: CopilotHookInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

/**
 * Records `subagentStart`'s pairing, then says whose session this hook is.
 * Never throws: a lost pairing costs attribution, never a turn.
 */
export function attributeHook(hookName: string, input: CopilotHookInput, now = new Date()): Attribution {
  const sessionId = payloadId(input, "sessionId") ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
  const pairings = readPairings();

  if (hookName === "subagentStart") {
    const agentId = payloadId(input, "agentId");
    if (agentId && sessionId && agentId !== sessionId) writePairing(pairings, agentId, rootOf(pairings, sessionId), now);
  }

  if (!sessionId) return { sessionId };
  if (pairings[sessionId]) return { sessionId: rootOf(pairings, sessionId), subagentId: sessionId };

  const parentAgentId = payloadId(input, "parentAgentId");
  if (parentAgentId && parentAgentId !== sessionId) {
    // Named as a subagent with no pairing on file. The parent named may be a
    // subagent itself, so it is followed to its session.
    return { sessionId: rootOf(pairings, parentAgentId), subagentId: payloadId(input, "agentId") ?? sessionId };
  }
  return { sessionId };
}

/** Every recorded agent id with the session it belongs to, for `doctor`. */
export function readSubagentParents(): Record<string, string> {
  return Object.fromEntries(Object.entries(readPairings()).map(([id, pairing]) => [id, pairing.parent]));
}

/** Follows a chain of pairings to a session id that isn't a subagent. Bounded, so a loop can't hang a hook. */
function rootOf(pairings: Record<string, Pairing>, id: string): string {
  let current = id;
  for (let hops = 0; hops < 8 && pairings[current]; hops++) current = pairings[current].parent;
  return current;
}

function readPairings(): Record<string, Pairing> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(subagentPairingsPath(), "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const pairings: Record<string, Pairing> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ID.test(id) || !value || typeof value !== "object") continue;
    const { parent, at } = value as Partial<Pairing>;
    if (typeof parent === "string" && ID.test(parent) && typeof at === "string") pairings[id] = { parent, at };
  }
  return pairings;
}

function writePairing(pairings: Record<string, Pairing>, agentId: string, parent: string, now: Date): void {
  try {
    pairings[agentId] = { parent, at: now.toISOString() };
    const kept = Object.entries(pairings)
      .sort(([, a], [, b]) => b.at.localeCompare(a.at))
      .slice(0, KEPT_PAIRINGS);
    const file = subagentPairingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(kept))}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Best effort.
  }
}
