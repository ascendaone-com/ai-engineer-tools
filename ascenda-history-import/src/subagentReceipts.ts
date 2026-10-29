/**
 * Per-subagent receipts: the metrics a later probe needs to ask whether work
 * is lost when a subagent hands its result back to the main loop.
 *
 * The session-level `subagent*` figures cannot see that handoff. The 29 Oct
 * 2026 probe (docs/SUBAGENT_SESSION_SHAPE.md in the workspace repo) found no
 * outcome difference once session length was held, and these are the numbers
 * it could not read: how big the return was, how much work the subagent did to
 * produce it, and whether the main thread went back over the same files soon
 * after.
 *
 * **Metrics only.** A receipt holds a class token, two instants, minutes,
 * counts, a character count and one boolean. It never holds the agent's name
 * (`classifySubagentType` collapses a custom one to `custom`), a prompt, a
 * result, or a path. Paths are compared by SHA-256 inside this module and the
 * hashes are dropped with the tally; not even a hash reaches the receipt.
 *
 * Local-only, like `dayBreakdown`: receipts are nested and `metrics` is flat
 * because it becomes wire metadata. The in-app writer
 * (`claude_code_extractor.dart`) makes the same receipts by the same rules.
 */
import { createHash } from "node:crypto";
import type { SubagentClass } from "@ascenda-one/tool-contract";

/** How long after a subagent returned a main-thread edit still counts as
 * going back over its work. */
export const RETOUCH_WINDOW_MS = 10 * 60_000;

/** The 5-minute gap rule the session's own active minutes use. */
const ACTIVE_GAP_MS = 5 * 60_000;

export interface SubagentReceipt {
  class: SubagentClass;
  /** First and last timestamp of the subagent's own lines. */
  firstAt: string | null;
  lastAt: string | null;
  /** Consecutive gaps of at most five minutes, summed. */
  activeMinutes: number;
  /** `tool_use` items made inside the subagent, and its failed results. */
  toolCalls: number;
  toolFailures: number;
  /** Characters of the result the parent received. Null where the parent has
   * no `tool_result` for this subagent, or only the launch acknowledgement of
   * a background one. */
  resultChars: number | null;
  /** True when the parent's `tool_result` was the launch acknowledgement of a
   * background subagent, so the real return is not on that line. */
  background: boolean;
  /** Whether the main thread edited a file this subagent edited, within
   * {@link RETOUCH_WINDOW_MS} after it returned. Null where there is no return
   * instant to measure from. */
  retouchedAfterReturn: boolean | null;
}

/** Built up while one subagent transcript is read. */
export interface SidechainTally {
  agentId: string | null;
  /** `agentType` from the sibling `.meta.json`, when there is one. */
  metaType: string | null;
  toolUseId: string | null;
  times: number[];
  toolCalls: number;
  toolFailures: number;
  editHashes: Set<string>;
}

export function newSidechainTally(): SidechainTally {
  return {
    agentId: null,
    metaType: null,
    toolUseId: null,
    times: [],
    toolCalls: 0,
    toolFailures: 0,
    editHashes: new Set()
  };
}

/** What the main thread did, collected while its own transcript is read. */
export interface ParentRecord {
  /** `Task`/`Agent` calls: tool_use id to the raw `subagent_type`. */
  spawns: Map<string, string | undefined>;
  /** The parent's `tool_result` per tool_use id. */
  results: Map<string, { at: number | null; chars: number; agentId: string | null; background: boolean }>;
  /** Main-thread edits, by path hash. */
  edits: Array<{ at: number; hash: string }>;
}

export function newParentRecord(): ParentRecord {
  return { spawns: new Map(), results: new Map(), edits: [] };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function pathHash(p: string): string {
  return createHash("sha256").update(p).digest("hex");
}

/** `tool_use` items of an assistant line: id, name, and only what a receipt
 * reads of the input — the edited path's hash and a subagent's type. */
export function receiptToolUsesOf(
  record: Record<string, unknown>
): Array<{ id: string | null; name: string; editHash: string | null; subagentType: string | undefined }> {
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string | null; name: string; editHash: string | null; subagentType: string | undefined }> = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== "tool_use" || typeof entry.name !== "string") continue;
    const input = (typeof entry.input === "object" && entry.input !== null ? entry.input : {}) as Record<string, unknown>;
    let editHash: string | null = null;
    if (EDIT_TOOLS.has(entry.name)) {
      const p = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
      if (p) editHash = pathHash(p);
    }
    const subagentType =
      (entry.name === "Task" || entry.name === "Agent") && typeof input.subagent_type === "string"
        ? input.subagent_type
        : undefined;
    out.push({ id: typeof entry.id === "string" ? entry.id : null, name: entry.name, editHash, subagentType });
  }
  return out;
}

/** `tool_result` items of a user line: the id, the character count of what was
 * returned (text blocks only), and whether it was a background launch ack. */
export function receiptToolResultsOf(
  record: Record<string, unknown>
): Array<{ id: string; chars: number; agentId: string | null; background: boolean }> {
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const tur = record.toolUseResult;
  const turRecord = typeof tur === "object" && tur !== null && !Array.isArray(tur) ? (tur as Record<string, unknown>) : null;
  const agentId = turRecord && typeof turRecord.agentId === "string" ? turRecord.agentId : null;
  const background = turRecord?.isAsync === true;
  const out: Array<{ id: string; chars: number; agentId: string | null; background: boolean }> = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== "tool_result" || typeof entry.tool_use_id !== "string") continue;
    let chars = 0;
    if (typeof entry.content === "string") chars = entry.content.length;
    else if (Array.isArray(entry.content)) {
      for (const block of entry.content) {
        if (typeof block === "object" && block !== null && typeof (block as Record<string, unknown>).text === "string") {
          chars += ((block as Record<string, unknown>).text as string).length;
        }
      }
    }
    out.push({ id: entry.tool_use_id, chars, agentId, background });
  }
  return out;
}

/**
 * Mirrors `classifySubagentType` in ascenda-claude-code-hooks. Copied, not
 * imported, because this package does not depend on the hooks package; the
 * vocabulary is the one in tool-contract, and `subagentReceipts.test.mjs`
 * pins the table.
 */
export function classifySubagentType(raw: unknown): SubagentClass {
  if (typeof raw !== "string") return "unknown";
  const value = raw.trim().toLowerCase();
  if (value === "") return "none";
  if (value.includes(":")) return "plugin";
  return BUILT_IN[value] ?? "custom";
}

const BUILT_IN: Record<string, SubagentClass> = {
  "general-purpose": "general_purpose",
  explore: "explore",
  plan: "plan",
  "statusline-setup": "statusline_setup",
  "claude-code-guide": "claude_code_guide"
};

function activeMsOf(times: readonly number[]): number {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap <= ACTIVE_GAP_MS) total += gap;
  }
  return total;
}

export function buildReceipt(tally: SidechainTally, parent: ParentRecord): SubagentReceipt {
  // The parent's result for this subagent: by the tool_use id the sibling
  // `.meta.json` names, else by the agent id the parent's result carries.
  let useId = tally.toolUseId;
  if (!useId || !parent.results.has(useId)) {
    useId = null;
    if (tally.agentId) {
      for (const [id, r] of parent.results) {
        if (r.agentId === tally.agentId) {
          useId = id;
          break;
        }
      }
    }
    if (!useId) useId = tally.toolUseId;
  }
  const result = useId ? parent.results.get(useId) : undefined;
  const rawType = tally.metaType ?? (useId && parent.spawns.has(useId) ? parent.spawns.get(useId) : undefined);

  const sorted = [...tally.times].sort((a, b) => a - b);
  const background = result?.background === true;
  const returnedAt = result && !background ? result.at : null;
  let retouched: boolean | null = null;
  if (returnedAt !== null) {
    retouched = parent.edits.some(
      (e) => e.at > returnedAt && e.at - returnedAt <= RETOUCH_WINDOW_MS && tally.editHashes.has(e.hash)
    );
  }
  return {
    class: classifySubagentType(rawType),
    firstAt: sorted.length ? new Date(sorted[0]).toISOString() : null,
    lastAt: sorted.length ? new Date(sorted[sorted.length - 1]).toISOString() : null,
    activeMinutes: Math.round(activeMsOf(tally.times) / 60_000),
    toolCalls: tally.toolCalls,
    toolFailures: tally.toolFailures,
    resultChars: result && !background ? result.chars : null,
    background,
    retouchedAfterReturn: retouched
  };
}
