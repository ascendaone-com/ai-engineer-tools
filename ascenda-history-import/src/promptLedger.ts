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

  /**
   * Hands a contested line to the transcript that wrote it.
   *
   * The ledger picks an owner by `sessionId` too, so a copy that rewrote it
   * reads as home here as well. That never counted a prompt twice — the id is
   * the key either way — but it could count it in the wrong session, whichever
   * of the two the walk reached first. `HomeClaims` settles the same question
   * for the timeline, and one answer serves both: a prompt and the instant it
   * happened at cannot belong to different sessions.
   */
  applyContestedOwners(owners: ReadonlyMap<string, string>): void {
    for (const [uuid, transcript] of owners) {
      if (!this.owners.has(uuid)) continue;
      this.owners.set(uuid, { transcript, home: true });
    }
  }

  /** Distinct chip prompts seen, for tests and diagnostics. */
  get chipPromptCount(): number {
    return this.chipPrompts.size;
  }
}

/**
 * Which transcripts claim the same line as written in them.
 *
 * `TimelineOwnership` below settles a copied line by trusting its
 * `sessionId`: the line names the file it was written in, so the file whose
 * name it is owns it. That premise is true of most copies and **false of
 * some**. A second copy path rewrites `sessionId` to the copying file's own
 * name while keeping the original `uuid` and `timestamp` — one pair diffed
 * field for field is identical in all thirteen but that one — so both files
 * answer "this line is mine" and both count it.
 *
 * Measured on a store of 991 transcripts: 637,660 lines claim their own file,
 * and **21,826 of those ids are claimed by two files — 23,445 duplicate
 * instances across 76 transcripts**, 3.7% of them. It is not a version
 * artifact; the transcripts carrying it span fourteen Claude Code releases
 * from 2.1.215 to 2.1.274. Left alone it costs 1,647 active minutes (3.1%)
 * and 441 hands-on minutes (5.5%) on that store, counted twice.
 *
 * No line tells you which of the two files wrote it, so this cannot be
 * answered one line at a time. It is answered by where the line sits:
 *
 *  1. every id claimed by two or more files is **contested**;
 *  2. in each of those files, the run of contested ids at its head is the
 *     history it inherited, and it ends at the file's first **uncontested**
 *     claim — everything from there on it wrote itself;
 *  3. a contested id is owned by the file that holds it after its own head
 *     began, which is the file that wrote it.
 *
 * On the store above that answers 83.9% of contested ids with exactly one
 * owner and **none with two**, so the rule never has to choose between two
 * writers. The other 16.1% are held only inside inherited heads — the file
 * that wrote them has been purged — and fall back to the first in walk
 * order, the same answer `TimelineOwnership` already gives an orphan.
 *
 * The cost is one map of contested ids, not of every id: 21,826 entries
 * rather than 605,501, because the full set is built during the pre-read and
 * thrown away at the end of it.
 */
export class HomeClaims {
  /** Id to the first transcript that claimed it, in walk order. */
  private readonly firstClaim = new Map<string, string>();
  /** Id to every transcript claiming it, once a second one does. */
  private readonly contested = new Map<string, Set<string>>();

  /** Takes one line of the pre-read, in walk order. */
  observe(uuid: unknown, sessionId: unknown, transcript: string): void {
    if (typeof uuid !== "string" || !isHomeTranscript(transcript, sessionId)) return;
    const first = this.firstClaim.get(uuid);
    if (first === undefined) {
      this.firstClaim.set(uuid, transcript);
      return;
    }
    if (first === transcript) return;
    const all = this.contested.get(uuid) ?? new Set([first]);
    all.add(transcript);
    this.contested.set(uuid, all);
  }

  get contestedCount(): number {
    return this.contested.size;
  }

  /** Every transcript holding a contested id — the only ones worth re-reading. */
  transcriptsToClassify(): string[] {
    const out = new Set<string>();
    for (const files of this.contested.values()) for (const f of files) out.add(f);
    return [...out];
  }

  has(uuid: string): boolean {
    return this.contested.has(uuid);
  }

  /** Every contested id, so each one can be given an owner. */
  contestedUuids(): Iterable<string> {
    return this.contested.keys();
  }

  /** The first transcript in walk order that claimed this id. */
  firstClaimOf(uuid: string): string | undefined {
    return this.firstClaim.get(uuid);
  }
}

/**
 * Reads the transcripts that hold a contested id and says, for each id, which
 * of them wrote it.
 *
 * Only the transcripts `HomeClaims` names are opened — 76 of 991 on the
 * reference store — because a file holding no contested id cannot change the
 * answer for one.
 *
 * Inside a file, the head is every claimed line before its first uncontested
 * claim. A file whose claims are all contested is inherited head all the way
 * down and owns nothing; that is a resume that was opened and never used, or
 * one whose own lines carry a different id.
 */
export async function resolveContestedOwners(
  claims: HomeClaims,
  walkOrder: readonly string[]
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  const rank = new Map(walkOrder.map((file, i) => [file, i]));
  const toRead = claims
    .transcriptsToClassify()
    .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  for (const transcript of toRead) {
    let headOver = false;
    const own: string[] = [];
    try {
      await eachLine(transcript, (line) => {
        if (!line.includes('"uuid"')) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const record = parsed as Record<string, unknown>;
        if (typeof record.uuid !== "string") return;
        if (!isHomeTranscript(transcript, record.sessionId)) return;
        if (!claims.has(record.uuid)) {
          // The first line this file claims that no other file does: its own
          // history starts here, and everything contested from here on it
          // wrote rather than inherited.
          headOver = true;
          return;
        }
        if (headOver) own.push(record.uuid);
      });
    } catch {
      // Unreadable since the pre-read listed it. It claims nothing, and the
      // fallback below still gives every contested id an owner.
    }
    for (const uuid of own) if (!owners.has(uuid)) owners.set(uuid, transcript);
  }
  // An id no surviving file claims as its own was written in a transcript the
  // store's cleanup has taken: every file still holding it holds it inside an
  // inherited head. First in walk order owns it, which is the answer
  // `TimelineOwnership` already gives an orphaned line — and the answer has to
  // be recorded rather than left absent, because absent means "uncontested"
  // and would hand it back to every claimant. 16.1% of contested ids on the
  // reference store.
  for (const uuid of claims.contestedUuids()) {
    if (owners.has(uuid)) continue;
    const first = claims.firstClaimOf(uuid);
    if (first !== undefined) owners.set(uuid, first);
  }
  return owners;
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
 * Whether a line could carry a home claim: it names an id at all. Broader than
 * {@link mayMatter} on purpose — `HomeClaims` asks about every line, not just
 * the ones a prompt could hide in — and still skips the tool output that is
 * most of the store's bytes without an id in it.
 */
function mayClaim(line: string): boolean {
  return line.includes('"uuid"');
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
): Promise<{ ledger: PromptLedger; claims: HomeClaims }> {
  const ledger = new PromptLedger();
  // Filled from the same read rather than a second one. It holds every id a
  // main-thread line claims, which is the expensive part and the reason it
  // lives here: the map is built while the store is already open and reduced
  // to the contested ids before the fold starts.
  const claims = new HomeClaims();
  const read = async (transcript: string, isSidechain: boolean) => {
    try {
      await eachLine(transcript, (line) => {
        const claiming = !isSidechain && mayClaim(line);
        if (!claiming && !mayMatter(line)) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        const record = parsed as Record<string, unknown>;
        // A subagent transcript is never inherited and its lines carry the
        // parent's id, so it claims nothing — see `TimelineOwnership`.
        if (claiming) claims.observe(record.uuid, record.sessionId, transcript);
        if (mayMatter(line)) {
          ledger.observe(record, transcript, { isSidechain, isToolResult });
        }
      });
    } catch {
      // Unreadable, or gone since the walk listed it.
    }
  };
  for (const transcript of mainTranscripts) await read(transcript, false);
  for (const transcript of subagentTranscripts) await read(transcript, true);
  return { ledger, claims };
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
 * the store above the full set of line ids is 605,501 entries and 52 MB of
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
  /**
   * Ids two transcripts both claim as written in them, mapped to the one that
   * wrote it — see `HomeClaims`. Empty where no copy rewrote a `sessionId`,
   * which is most stores and every store this rule's first version was
   * measured on.
   */
  private readonly contestedOwners: ReadonlyMap<string, string>;

  constructor(
    mainTranscripts: readonly string[],
    contestedOwners: ReadonlyMap<string, string> = new Map()
  ) {
    this.transcriptIds = new Set(mainTranscripts.map((file) => path.basename(file, ".jsonl")));
    this.contestedOwners = contestedOwners;
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
    if (isHomeTranscript(transcript, line.sessionId)) {
      // Usually the end of it: the line names this file, so it was written
      // here. Unless another file names it too, because it was copied with
      // its `sessionId` rewritten — then only the file that wrote it counts
      // it, and where that file is gone the first in walk order does.
      const owner = this.contestedOwners.get(line.uuid);
      if (owner === undefined) return true;
      return owner === transcript;
    }
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
