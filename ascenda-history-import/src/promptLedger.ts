/**
 * Which session counts a typed prompt, and which typed-looking lines a chip
 * wrote.
 *
 * No single transcript can answer either question, so the extractor reads the
 * whole store once for them before it folds any session. The read keeps line
 * ids and hashes only, never text.
 *
 * **Resumed transcripts copy history.** Resuming or forking a session writes a
 * new transcript file that starts with the inherited history, and each copied
 * line keeps its original `uuid` and `timestamp`. Folds are keyed by file (see
 * `extractClaudeCode` for why that keying stays), so every fold on a lineage
 * used to emit an `ai_prompt_submitted` for every inherited prompt. A lineage
 * resumed four times counted its first prompt five times, and `promptCount`,
 * after-hours prompts, quick re-prompts and the day slices all inherited the
 * copies. The ledger gives each typed line, by `uuid`, exactly one owner, and
 * only the owner counts it:
 *
 *  1. the transcript whose filename equals the line's own `sessionId`, which
 *     is the file it was typed in;
 *  2. where that file is gone, the first transcript in the extractor's sorted
 *     walk order.
 *
 * A line with no `uuid` has nothing to match copies by, so every transcript
 * holding one still counts it, as before.
 *
 * The same question is asked of every line, not just typed ones, by
 * {@link TimelineOwnership} at the bottom of this file: a copied line's
 * instant belongs to one fold too, so minutes and spans stop carrying the
 * ancestor's work. Same rule, different material, and it needs no pre-read.
 *
 * **Chip-launched sessions open on a line nobody typed.** A session started
 * from a `spawn_task` chip has, as its first `user` line, the chip's `prompt`
 * input verbatim, sometimes behind a runtime wrapper. Nothing structural tells
 * it apart from a typed prompt: its origin, entrypoint and neighbouring lines
 * read the same. The one piece of evidence is the text matching a chip that
 * some session in the store issued. So the ledger keeps a SHA-256 of every
 * chip's prompt, normalised as `typedRemainderOf` normalises a line, and a
 * typed line whose remainder hashes into that set was dispatched, not typed.
 * The extractor counts it in `dispatchedPromptLines` rather than dropping it,
 * because clicking the chip was still a person's act.
 *
 * Known miss: when the store's 30-day cleanup has purged the transcript that
 * issued a chip, nothing is left to match, and the opener still counts as
 * typed.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { isTypedPromptLine, stripRuntimeWrappers, typedRemainderOf } from "./interruptedRuns.js";

/** The tool a session calls to offer a chip that opens another session. */
export const SPAWN_TASK_TOOL_NAME = "mcp__ccd_session__spawn_task";

/** SHA-256 of already-normalised prompt text. The only form text is kept in. */
export function promptFingerprint(normalised: string): string {
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/**
 * The chip prompts issued on one assistant line, one per `spawn_task` call,
 * each as its call id and a fingerprint. Reads the `prompt` input of that one
 * tool and nothing else, and keeps only the hash.
 */
export function spawnTaskPromptsOf(
  record: Record<string, unknown>
): { callId: string | null; fingerprint: string }[] {
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const out: { callId: string | null; fingerprint: string }[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== "tool_use" || entry.name !== SPAWN_TASK_TOOL_NAME) continue;
    const input = entry.input as Record<string, unknown> | undefined;
    if (typeof input?.prompt !== "string") continue;
    out.push({
      callId: typeof entry.id === "string" ? entry.id : null,
      fingerprint: promptFingerprint(stripRuntimeWrappers(input.prompt))
    });
  }
  return out;
}

/** Whether a line's `sessionId` names the transcript it sits in. */
export function isHomeTranscript(transcriptPath: string, sessionId: unknown): boolean {
  return typeof sessionId === "string" && path.basename(transcriptPath, ".jsonl") === sessionId;
}

interface Owner {
  transcript: string;
  home: boolean;
}

export class PromptLedger {
  /** Line id to owning transcript; `null` once the owner has counted it. */
  private readonly owners = new Map<string, Owner | null>();
  private readonly chipPrompts = new Set<string>();
  private readonly chipCalls = new Set<string>();

  /**
   * Takes one line of the pre-read. Main-thread transcripts must be offered in
   * the extractor's walk order, since the first one seen owns a line whose home
   * file is gone.
   */
  observe(
    record: Record<string, unknown>,
    transcript: string,
    opts: { isSidechain: boolean; isToolResult: (record: Record<string, unknown>) => boolean }
  ): void {
    if (record.type === "assistant") {
      // Either thread: a subagent can offer a chip as well as the main thread.
      // A resumed transcript repeats the call, so the id is read once.
      for (const { callId, fingerprint } of spawnTaskPromptsOf(record)) {
        if (callId !== null) {
          if (this.chipCalls.has(callId)) continue;
          this.chipCalls.add(callId);
        }
        this.chipPrompts.add(fingerprint);
      }
      return;
    }
    if (opts.isSidechain || record.type !== "user") return;
    if (typeof record.uuid !== "string") return;
    if (opts.isToolResult(record) || !isTypedPromptLine(record)) return;
    const home = isHomeTranscript(transcript, record.sessionId);
    const existing = this.owners.get(record.uuid);
    if (existing === undefined || (existing !== null && !existing.home && home)) {
      this.owners.set(record.uuid, { transcript, home });
    }
  }

  /** Whether a line that passes `isTypedPromptLine` is a chip's prompt. */
  isDispatched(record: Record<string, unknown>): boolean {
    if (this.chipPrompts.size === 0) return false;
    const remainder = typedRemainderOf(record);
    return remainder !== null && this.chipPrompts.has(promptFingerprint(remainder));
  }

  /**
   * Whether this transcript counts this typed line. True at most once per line
   * id across the store, and always true for a line without one.
   */
  claim(record: Record<string, unknown>, transcript: string): boolean {
    const uuid = record.uuid;
    if (typeof uuid !== "string") return true;
    const owner = this.owners.get(uuid);
    // Unseen by the pre-read: the store changed between the two reads. The
    // first transcript to reach it counts it.
    if (owner === undefined) {
      this.owners.set(uuid, null);
      return true;
    }
    if (owner === null || owner.transcript !== transcript) return false;
    this.owners.set(uuid, null);
    return true;
  }

  /** Distinct chip prompts seen, for tests and diagnostics. */
  get chipPromptCount(): number {
    return this.chipPrompts.size;
  }
}

/**
 * Whether a line could matter to the ledger: it names a `user` record or the
 * chip tool. A necessary condition only, so it may pass a line that turns out
 * not to matter, but it can't skip one that does. Every line that passes is
 * parsed and classified in full. It exists because the pre-read covers the
 * whole store and most of its bytes are tool output.
 */
function mayMatter(line: string): boolean {
  return line.includes('"user"') || line.includes(SPAWN_TASK_TOOL_NAME);
}

/**
 * Calls `onLine` for each line of a transcript, streamed in 1 MB chunks, so a
 * transcript of hundreds of MB is never held whole. A line longer than a chunk
 * is joined from its pieces, not by repeated concatenation.
 */
async function eachLine(transcript: string, onLine: (line: string) => void): Promise<void> {
  const stream = createReadStream(transcript, { encoding: "utf8", highWaterMark: 1 << 20 });
  let pending: string[] = [];
  for await (const chunk of stream as AsyncIterable<string>) {
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf("\n", start)) !== -1) {
      pending.push(chunk.slice(start, newline));
      onLine(pending.length === 1 ? pending[0] : pending.join(""));
      pending = [];
      start = newline + 1;
    }
    if (start < chunk.length) pending.push(chunk.slice(start));
  }
  if (pending.length > 0) onLine(pending.join(""));
}

/**
 * Reads every transcript once and keeps only line ids with their owners, plus
 * chip prompt hashes. A transcript that can't be read contributes nothing here,
 * and the fold that follows handles it as it always has.
 */
export async function readPromptLedger(
  mainTranscripts: string[],
  subagentTranscripts: string[],
  isToolResult: (record: Record<string, unknown>) => boolean
): Promise<PromptLedger> {
  const ledger = new PromptLedger();
  const read = async (transcript: string, isSidechain: boolean) => {
    try {
      await eachLine(transcript, (line) => {
        if (!mayMatter(line)) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        ledger.observe(parsed as Record<string, unknown>, transcript, { isSidechain, isToolResult });
      });
    } catch {
      // Unreadable, or gone since the walk listed it.
    }
  };
  for (const transcript of mainTranscripts) await read(transcript, false);
  for (const transcript of subagentTranscripts) await read(transcript, true);
  return ledger;
}

/**
 * Which fold a line's INSTANT belongs to.
 *
 * The rule above, applied to time rather than to prompts: every known line
 * contributes a timeline point to one transcript only, so a resumed session's
 * active minutes, hands-on minutes, day slices and `startedAt` describe what
 * happened in it and not in its ancestors. Measured on one real store of 984
 * transcripts: 151 carried inherited lines, per-session active minutes summed
 * to 2.8x the union of the same intervals, and 30% of all active spans were
 * an exact duplicate of another session's.
 *
 * The owner is the same one the ledger picks — the transcript named by the
 * line's own `sessionId`, or the first in walk order where that file is gone —
 * but this one is decided from the walk's file list and the line's two ids,
 * with no pre-read behind it:
 *
 *  - a copied line keeps its original `sessionId`, so `sessionId` against the
 *    file's own name answers almost every line on its own;
 *  - only a line whose home file is missing needs an id remembered, and then
 *    only until some transcript claims it.
 *
 * That distinction is why this holds ids at all rather than all of them. On
 * the store above the full set of line ids is 605,096 entries and 52 MB of
 * heap held for the length of the walk; the set this keeps held 0, because
 * every inherited line's home file was still on disk. A store mid-purge holds
 * one id per orphaned line and nothing else.
 *
 * Two lines are counted by every fold that holds them, exactly as before: one
 * with no `uuid` (nothing to recognise a copy by) and one with no `sessionId`
 * (nothing to name its home). Neither is guessed at. On the reference store
 * the first is `queue-operation` and nothing else — 3.4% of known dated lines,
 * 10,313 of them inherited — and no known dated line was missing a
 * `sessionId`. So a copied queue operation still puts its instant on both
 * timelines; it is one instant, usually inside a stretch the lines around it
 * already cover, and inventing an id for it would be worse.
 *
 * A subagent transcript is never inherited — a resume copies the main thread's
 * lines, not the `subagents/` directory beside it, and its lines carry the
 * parent session's id rather than their own file's name, which would read as
 * inherited under the rule above. Verified on the same store: no subagent line
 * carries a `sessionId` other than its session directory's. So they are owned
 * by the fold they were found under, unconditionally.
 */
export class TimelineOwnership {
  /** Basenames of every main-thread transcript the walk listed. */
  private readonly transcriptIds: ReadonlySet<string>;
  /** Ids of inherited lines whose home file is gone, claimed as they're met. */
  private readonly claimedOrphans = new Set<string>();

  constructor(mainTranscripts: readonly string[]) {
    this.transcriptIds = new Set(mainTranscripts.map((file) => path.basename(file, ".jsonl")));
  }

  /**
   * Whether this transcript's fold counts this line's instant. Called once per
   * known line, in the extractor's walk order — the orphan rule is first-come,
   * so a different order would hand a purged lineage's minutes to a different
   * fold.
   */
  owns(
    line: { uuid: string | null; sessionId: string | null },
    transcript: string,
    opts: { isSidechain: boolean }
  ): boolean {
    if (opts.isSidechain) return true;
    if (line.sessionId === null || line.uuid === null) return true;
    if (isHomeTranscript(transcript, line.sessionId)) return true;
    // Inherited. The file it was written in is still here and will count it.
    if (this.transcriptIds.has(line.sessionId)) return false;
    // Inherited from a session the purge took: the first transcript to reach
    // it owns it, the way the ledger gives it the prompt.
    if (this.claimedOrphans.has(line.uuid)) return false;
    this.claimedOrphans.add(line.uuid);
    return true;
  }

  /** Ids held for orphaned lines, for tests and diagnostics. */
  get orphanLineCount(): number {
    return this.claimedOrphans.size;
  }
}
