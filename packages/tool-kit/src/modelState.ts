import * as fs from "fs";
import * as path from "path";
import type { AscendaEventMetadata, ModelClass, ModelRoute } from "@ascenda-one/tool-contract";
import { ascendaHome } from "./tokenStore";
import { classifyModelClass } from "./modelClassifier";

/**
 * The last model a hook sent for a session, so the next hook can tell whether
 * it changed. The same pattern as `effortState.ts`: Codex and Cursor put the
 * model on every hook payload, and sending it on every event would repeat
 * one slug hundreds of times a session. Each hook is its own process, so the
 * value lives in a small file under `~/.ascenda/state/` (or
 * `ASCENDA_STATE_DIR`).
 *
 * Every failure degrades quietly. A read that fails returns `undefined`, which
 * makes the next model look new and sends it again: one repeated value, never
 * a lost one.
 */
const stateDir = (): string => process.env.ASCENDA_STATE_DIR ?? path.join(ascendaHome(), "state");

function modelFile(agent: string, sessionId: string): string {
  return path.join(stateDir(), `${sanitize(agent)}-model-${sanitize(sessionId)}`);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function readSentModelId(agent: string, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  try {
    const id = fs.readFileSync(modelFile(agent, sessionId), "utf8").trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

export function recordSentModelId(agent: string, sessionId: string | undefined, modelId: string): void {
  if (!sessionId || !modelId) return;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(modelFile(agent, sessionId), modelId, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Next hook re-sends the model. See the module note.
  }
}

/** Called when a session ends, so a finished session leaves no file behind. */
export function clearSentModelId(agent: string, sessionId: string | undefined): void {
  if (!sessionId) return;
  try {
    fs.rmSync(modelFile(agent, sessionId), { force: true });
  } catch {
    // A stale file costs one skipped repeat on a resumed id.
  }
}

/** The model trio a hook puts on an event: the raw slug, its class, and the
 * route when one could be read. */
export type ModelFields = { modelId: string; modelClass: ModelClass; modelRoute?: ModelRoute };

/**
 * The model fields for a raw slug, or `undefined` when nothing usable was
 * reported (absent, empty, whitespace, not a string). Both `modelId` and
 * `modelClass` or neither, as on every other path. Slugs over 200 characters
 * are not model ids and are dropped rather than truncated.
 */
export function modelFieldsFor(raw: unknown, route?: ModelRoute): ModelFields | undefined {
  if (typeof raw !== "string") return undefined;
  const modelId = raw.trim();
  if (!modelId || modelId.length > 200) return undefined;
  const modelClass = classifyModelClass(modelId);
  if (modelClass === undefined) return undefined;
  return { modelId, modelClass, ...(route ? { modelRoute: route } : {}) };
}

/**
 * Puts the model fields on the first event of a mapped batch when the model
 * differs from the last one sent for this session, or when `force` is set (a
 * session's opening event always says which model it opened on). A batch
 * whose payload carries no model is returned unchanged, and so is one whose
 * model matches the last one sent.
 *
 * Returns the slug that went out, so the caller can record it. The record
 * moves only when a value is sent: a hook that maps to no event can't carry
 * a change, so it waits for the next one that does.
 */
export function withModelOnChange<E extends { metadata?: AscendaEventMetadata }>(
  events: E[],
  fields: ModelFields | undefined,
  lastSentModelId: string | undefined,
  force = false
): { events: E[]; sent?: string } {
  if (events.length === 0 || !fields) return { events };
  if (!force && fields.modelId === lastSentModelId) return { events };
  const [first, ...rest] = events;
  return {
    events: [{ ...first, metadata: { ...(first.metadata ?? {}), ...fields } as AscendaEventMetadata }, ...rest],
    sent: fields.modelId
  };
}
