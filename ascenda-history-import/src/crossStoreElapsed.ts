/**
 * The run's elapsed reading over every store at once.
 *
 * **Why a file that belongs to no store.** Each store's handoff carries a
 * `projects[].elapsed` block, and each is a true statement about that store:
 * the union of *its* overlapping sessions. Adding two of them is not a union.
 * A Claude Code session and a Codex session running in the same hour are that
 * hour twice, and nothing downstream can repair it, because a handoff carries
 * minutes and the spans they were unioned from are gone by then. The importer
 * is the only place both stores' spans exist at once, so the union over both
 * is taken here or nowhere.
 *
 * **Which stores can be in it.** Whichever ones handed over spans, and today
 * that is Claude Code and Codex — Cursor and VS Code classify no timeline and
 * gap-split nothing, so they contribute nothing to pool. That is a fact about
 * what those stores hand over rather than a list kept here: a store with no
 * spans never registers, and a store that one day grows a timeline is covered
 * the moment it does. Under-reporting by forgetting to add a store to a list
 * would be the same defect as the sum this replaces, facing the other way.
 *
 * **Nested, and that is not tidiness.** The app's `HistoricalImportReader`
 * treats every `*.json` file directly inside the handoff directory as a
 * store's handoff — that is how a store it has never heard of is still
 * reported rather than ignored — so a sibling file here would read as a store
 * named after itself, on the current build and on every build shipped before
 * it. Directories are not listed as stores, so nesting hides this file from
 * older readers by construction instead of asking them to know a name they
 * cannot know.
 *
 * **Accepted by identity, never by age.** The file names the stores it pooled
 * and carries the run's `extractionId` — the same stamp every handoff of the
 * run carries, which is what makes the match possible at all. The reader takes
 * it only where every elapsed-bearing handoff on disk is named in it and
 * carries that same stamp; a run that rewrites one store's handoff afterwards
 * changes that store's stamp, and this file is then correctly refused rather
 * than quietly standing in for a window that no longer exists. Comparing file
 * times could not do that job: a copy or a restore falsifies them.
 *
 * Which is also why a run that writes no union leaves an older one where it
 * is rather than deleting it. The stamp already makes it inert — every
 * handoff this run rewrote carries a new one — and a writer that deletes
 * files it did not write is a worse thing to have around than a file that is
 * refused.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { LOCAL_TIMEZONE } from "./daySlice.js";
import { DEFAULT_ACTIVE_GAP_MS, type ActiveSpan } from "./activeSplit.js";
import { CROSS_STORE_ACTIVE_TIME_QUANTITIES, type ActiveTimeQuantityStamp } from "./handoffActiveTime.js";
import {
  HANDOFF_SCHEMA,
  appIsInstalled,
  digestKeyOf,
  elapsedActiveOf,
  handoffDir,
  writeJsonAtomically,
  type ProjectElapsedActive,
  type ProjectSpanInput
} from "./localHandoff.js";

/** The directory the union lives in, inside the handoff directory. Its whole
 * job is to not be a `*.json` file beside the handoffs — see the note above. */
export const CROSS_STORE_ELAPSED_DIR_NAME = "elapsed";
export const CROSS_STORE_ELAPSED_FILE_NAME = "cross-store.json";

export function crossStoreElapsedPath(home: string = os.homedir()): string {
  return path.join(handoffDir(home), CROSS_STORE_ELAPSED_DIR_NAME, CROSS_STORE_ELAPSED_FILE_NAME);
}

/** One project's spans pooled across every store the run read. */
export interface CrossStoreProject {
  projectHash: string | null;
  projectLabel: string | null;
  /** The stores that contributed spans to this project, sorted. Carried so a
   * project touched by one store alone is still distinguishable from one where
   * the union genuinely spans two. */
  stores: string[];
  /** The same block a per-store digest carries, from the same builder over a
   * wider pool. Deliberately no summed pair beside it: the per-store digests
   * already carry the agent-hours reading. */
  elapsed: ProjectElapsedActive;
}

export interface CrossStoreElapsedFile {
  schema: number;
  /** The run that wrote it, matched against each handoff's own stamp. */
  extractionId: string;
  generatedAt: string;
  timezone: string | null;
  activeGapMinutes: number;
  /** Which stores are actually inside these figures. A reader holding an
   * elapsed-bearing handoff from a store missing here must fall back to
   * adding, because this union does not cover it. */
  stores: string[];
  activeTimeQuantities: ActiveTimeQuantityStamp;
  projects: CrossStoreProject[];
}

/**
 * The spans of a whole run, pooled per project across the stores it read.
 *
 * Keyed as `buildProjectDigests` keys — the hash where there is one and the
 * label otherwise, through the same `digestKeyOf` — so a project lines up
 * across stores exactly as it lines up across sessions, and two checkouts of
 * one repository stay one project here as they do there.
 *
 * Local only, exactly as `ProjectSpanInput.spans` is: these never reach a
 * session, never reach the wire, and are dropped when the run ends.
 */
export class CrossStoreElapsedPool {
  private readonly byKey = new Map<
    string,
    { projectHash: string | null; projectLabel: string | null; stores: Set<string>; spans: ActiveSpan[] }
  >();

  /** Pools one store's project spans. A store that hands over none is not
   * recorded as having contributed, which is what keeps the store list in the
   * written file a list of stores actually inside the figures. */
  add(storeId: string, spansBySession: readonly ProjectSpanInput[]): void {
    for (const session of spansBySession) {
      if (session.spans.length === 0) continue;
      const key = digestKeyOf(session);
      let project = this.byKey.get(key);
      if (!project) {
        project = {
          projectHash: session.projectHash,
          projectLabel: session.projectLabel,
          stores: new Set<string>(),
          spans: []
        };
        this.byKey.set(key, project);
      }
      project.stores.add(storeId);
      for (const span of session.spans) project.spans.push(span);
    }
  }

  /**
   * The union over everything pooled, or null where there is nothing for it to
   * say.
   *
   * Null below two contributing stores, and that is the point rather than an
   * edge case: with one store the per-store union already *is* the union, and a
   * file restating it would be a second copy of a figure to drift from the
   * first.
   */
  build(extractionId: string, generatedAt: string): CrossStoreElapsedFile | null {
    const projects = [...this.byKey.values()].filter((project) => project.spans.length > 0);
    const stores = new Set<string>();
    for (const project of projects) for (const store of project.stores) stores.add(store);
    if (stores.size < 2) return null;

    return {
      schema: HANDOFF_SCHEMA,
      extractionId,
      generatedAt,
      timezone: LOCAL_TIMEZONE,
      // From the same constant the extractors split with, never a literal
      // repeated here — a provenance stamp that can disagree with the rule it
      // describes is worse than none.
      activeGapMinutes: DEFAULT_ACTIVE_GAP_MS / 60_000,
      stores: [...stores].sort(),
      activeTimeQuantities: CROSS_STORE_ACTIVE_TIME_QUANTITIES,
      projects: projects.map((project) => ({
        projectHash: project.projectHash,
        projectLabel: project.projectLabel,
        stores: [...project.stores].sort(),
        elapsed: elapsedActiveOf(project.spans)
      }))
    };
  }
}

/**
 * Write the union beside the handoffs it was pooled from.
 *
 * Returns null on the same terms `writeHandoff` does — the app not being
 * installed is a normal state for a CLI that also serves people who only ship
 * to the backend, and a union nobody will read is just an orphan file. The two
 * writers share the test so the union cannot appear without the handoffs it
 * describes.
 */
export async function writeCrossStoreElapsed(
  file: CrossStoreElapsedFile,
  home: string = os.homedir()
): Promise<string | null> {
  if (!(await appIsInstalled(home))) return null;
  const target = crossStoreElapsedPath(home);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeJsonAtomically(target, file);
  return target;
}
