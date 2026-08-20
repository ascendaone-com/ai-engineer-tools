/**
 * Git extractor — the spine. Unbounded depth, fully supported format, zero
 * reverse-engineering risk; every other store's events hang off the commit
 * timeline it establishes. Runs last because nothing about it evaporates.
 *
 * Signals: commit cadence and size, time-of-day, revert/fix chains, and
 * AI-attribution via Co-Authored-By trailers (Claude writes them). Repo
 * identity ships as a hash (repoRef), never a path — tool-kit's machine-salt
 * hashing is the existing convention for exactly this.
 */
import { NormalizedHistoricalEvent } from "../types.js";

/* eslint-disable @typescript-eslint/no-unused-vars, require-yield */
export async function* extractGit(
  snapshotDir: string,
  extractionId: string
): AsyncIterable<NormalizedHistoricalEvent> {
  // Open work. Unlike the other stores git needs no staging copy — history
  // is immutable; `git log --format` against the live repo is the extraction.
  // The snapshotDir parameter is accepted for interface uniformity and
  // ignored.
  throw new Error(
    "extractGit is not implemented yet — scaffolded, no extraction path built"
  );
}
