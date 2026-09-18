/**
 * Which session counts a typed prompt.
 *
 * No single transcript can answer that, so the extractor reads the whole store
 * once for it before it folds any session. The read keeps line ids only, never
 * text.
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
 * Minutes are not deduplicated here. A copied prompt is still a person's
 * instant on the copying fold's timeline, so every fold on a lineage keeps its
 * inherited active and hands-on minutes. That is a separate decision with its
 * own reasoning, recorded where the minutes are computed.
 */
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { isTypedPromptLine } from "./interruptedRuns.js";

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
    if (opts.isSidechain || record.type !== "user") return;
    if (typeof record.uuid !== "string") return;
    if (opts.isToolResult(record) || !isTypedPromptLine(record)) return;
    const home = isHomeTranscript(transcript, record.sessionId);
    const existing = this.owners.get(record.uuid);
    if (existing === undefined || (existing !== null && !existing.home && home)) {
      this.owners.set(record.uuid, { transcript, home });
    }
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
}

/**
 * Whether a line could matter to the ledger: it names a `user` record. A
 * necessary condition only, so it may pass a line that turns out not to
 * matter, but it can't skip one that does. Every line that passes is parsed and
 * classified in full. It exists because the pre-read covers the whole store and
 * most of its bytes are tool output.
 */
function mayMatter(line: string): boolean {
  return line.includes('"user"');
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
 * Reads every transcript once and keeps only line ids with their owners. A transcript that can't be read contributes nothing here,
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
