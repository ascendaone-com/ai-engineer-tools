#!/usr/bin/env node
/**
 * ascenda-history-import — retrospective AI-usage import.
 *
 *   scan            inventory the stores (read-only, content never opened)
 *   scan --json     same, machine-readable — what the app's consent surface renders
 *   import          snapshot + extract + ship
 *   fix-retention   show the Claude Code retention plan; --apply to write it
 *   archive         the durable copy — see `archive.ts`
 *
 * `archive` flags:
 *   --verify                  re-hash every blob the generation names
 *   --list                    list generations, newest last
 *   --restore <dir>           materialise a generation into <dir>, never in place
 *   --prune                   drop old generations and unreferenced blobs
 *   --keep <n>                generations to keep when pruning (default 10)
 *   --generation <id>         target a specific generation (default: latest)
 *   --include-vscode-sessions add the 15 GB of Copilot sessions VS Code is not deleting
 *
 * `import` flags:
 *   --ship               send the extracted events over the batch wire
 *   --keep-staging       leave the run's snapshot on disk (debugging only)
 *   --snapshot-sessions  copy VS Code chat sessions before reading them
 *
 * Two rules this command is built around, both of them learned the hard way
 * on 25 Aug 2026:
 *
 *  1. A RUN CLEANS UP AFTER ITSELF. Staging is scaffolding. Nineteen runs had
 *     left 254 GB behind and filled a 926 GB disk, at which point unrelated
 *     tooling started failing with ENOSPC — the importer never said a word.
 *     Teardown lives in a `finally` here rather than in a `fix-retention`-style
 *     command precisely because the thing that failed was remembering.
 *  2. THE EXIT CODE AND THE SUMMARY ARE THE PRODUCT. A caller cannot see the
 *     scrollback. Every source reports extracted-or-failed by name, the run
 *     exits non-zero if any of them failed, and `--ship` closes with what
 *     actually landed. This import backfills the work-demand rail; a quietly
 *     short series is worse than a loud failure, because the surface reading
 *     it downstream has no way to tell the difference.
 *
 * The macOS Flow app cannot read any of these stores (sandboxed, and child
 * processes inherit the sandbox), so this CLI is the thing the app hands the
 * user one terminal command to run — same pattern as hooks pairing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveStorePaths } from "./stores.js";
import { scanAll, scanClaudeCode, scanCursor, scanVsCode } from "./scan.js";
import { applyClaudeRetentionFix, planClaudeRetentionFix } from "./retention.js";
import {
  checkSpaceForSnapshot,
  createStagingArea,
  defaultStagingRoot,
  disposeStagingArea,
  formatBytes,
  snapshotPath,
  snapshotVsCodeWorkspaceStorage,
  sweepStagingRoot
} from "./staging.js";
import { extractClaudeCode } from "./extractors/claudeCode.js";
import { extractCursor } from "./extractors/cursor.js";
import { extractVsCode } from "./extractors/vscode.js";
import {
  archiveSizeBytes,
  archiveStores,
  defaultArchiveRoot,
  defaultArchiveSources,
  listManifests,
  pruneArchive,
  readLatestManifest,
  readManifest,
  restoreArchive,
  verifyArchive
} from "./archive.js";
import { loadShipConfig, shipEvents, shippableEvents } from "./ship.js";
import type { ShipResult } from "./ship.js";
import { buildHandoff, buildCursorHandoff, buildVsCodeHandoff, writeHandoff } from "./localHandoff.js";
import { HistoryStore, NormalizedHistoricalEvent, StoreInventory } from "./types.js";

function formatInventory(inv: StoreInventory): string {
  const lines: string[] = [];
  const status = inv.present ? "found" : "not found";
  lines.push(`${inv.store}  (${status})  ${inv.rootPath}`);
  if (inv.present) {
    if (inv.oldest || inv.newest) {
      lines.push(`  window: ${inv.oldest ?? "?"} → ${inv.newest ?? "?"}`);
    }
    const counts = Object.entries(inv.counts)
      .map(([k, v]) => `${k}=${v.toLocaleString("en-US")}`)
      .join("  ");
    if (counts) lines.push(`  ${counts}`);
    if (inv.retentionRisk) lines.push(`  ⚠ ${inv.retentionRisk}`);
    for (const note of inv.notes) lines.push(`  note: ${note}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------------ *
 * Per-source outcome, summary and exit code
 *
 * The defect this replaces: a run in which VS Code — the source carrying the
 * great majority of the usable window — failed outright, while the process
 * printed per-source counts for the two sources that HAD worked and then
 * stopped. Nothing named the failure, nothing summed it up, and the only
 * signal a caller could read was an exit code that did not reflect it.
 * ------------------------------------------------------------------------ */

/**
 * A scan that throws must not take the whole import with it.
 *
 * One unreadable directory under `~/.claude/projects` was enough to kill the
 * run before it printed a single line — no inventory, no summary, not even
 * which store was being scanned. That is the same defect as the one below,
 * one phase earlier: the failure was real, and the report of it was a bare
 * errno on stderr with the store's name nowhere in sight.
 */
async function safeScan(
  store: HistoryStore,
  rootPath: string,
  scan: () => Promise<StoreInventory>
): Promise<{ inventory: StoreInventory; scanError: string | null }> {
  try {
    return { inventory: await scan(), scanError: null };
  } catch (error) {
    return {
      inventory: { store, rootPath, present: false, counts: {}, notes: [] },
      scanError: error instanceof Error ? error.message : String(error)
    };
  }
}

type SourceStatus = "extracted" | "absent" | "failed";

interface SourceOutcome {
  store: string;
  status: SourceStatus;
  events: number;
  /** Present only on `failed` — the reason, verbatim. */
  error?: string;
  /** From the store's extraction_epoch: files it meant to read and could not.
   * A source can succeed and still be incomplete, and that is worth saying. */
  readFailures: number;
}

/** Counters an extraction_epoch carries that mean "we did not read this". */
const READ_FAILURE_METRICS = [
  "unparsedFiles",
  "unreadableFiles",
  "unparsedHistoryFiles",
  "unreadableHistoryFiles",
  "malformedHistoryEntries",
  "unparsedChatSessionFiles",
  "unreadableChatSessionFiles",
  "unrecognisedChatSessionFiles",
  "malformedChatSessionLines",
  "unparsedLines",
  "unparsedTranscripts"
];

function readFailuresOf(events: NormalizedHistoricalEvent[]): number {
  let total = 0;
  for (const event of events) {
    if (event.eventKind !== "extraction_epoch") continue;
    for (const metric of READ_FAILURE_METRICS) {
      const value = event.metrics[metric];
      if (typeof value === "number") total += value;
    }
  }
  return total;
}

/**
 * Append one array onto another without spreading it.
 *
 * `target.push(...source)` passes every element as a separate argument, and
 * a big enough source overflows the call stack. That is not theoretical:
 * counting tool calls one event apiece takes a working store past the limit,
 * and `push(...)` died with "Maximum call stack size exceeded" AFTER the
 * extraction had finished and the per-source summary had printed — the whole
 * run's work thrown away at the last step, with a message naming nothing
 * that would lead anyone here. `tests/toolCalls.test.mjs` pins it.
 */
function appendAll<T>(target: T[], source: T[]): void {
  for (const item of source) target.push(item);
}

/**
 * Run one store's snapshot+extract, and record what happened either way.
 *
 * A throw here is contained: it becomes a `failed` outcome that the summary
 * names and the exit code honours, and the sources after it still run. What
 * it must never do is disappear.
 */
async function runSource(
  outcomes: SourceOutcome[],
  store: string,
  inventory: StoreInventory,
  allEvents: NormalizedHistoricalEvent[],
  extract: (collect: (event: NormalizedHistoricalEvent) => void) => Promise<void>,
  buildStoreHandoff: (events: NormalizedHistoricalEvent[]) => Parameters<typeof writeHandoff>[0],
  scanError: string | null = null
): Promise<void> {
  if (scanError !== null) {
    process.stdout.write(`${inventory.store} FAILED to scan: ${scanError}\n\n`);
    outcomes.push({ store, status: "failed", events: 0, error: scanError, readFailures: 0 });
    return;
  }
  process.stdout.write(formatInventory(inventory) + "\n\n");
  if (!inventory.present) {
    outcomes.push({ store, status: "absent", events: 0, readFailures: 0 });
    return;
  }

  const events: NormalizedHistoricalEvent[] = [];
  const kindCounts: Record<string, number> = {};
  try {
    await extract((event) => {
      events.push(event);
      kindCounts[event.eventKind] = (kindCounts[event.eventKind] ?? 0) + 1;
    });
  } catch (error) {
    // Whatever was extracted before the failure is still real and still
    // shipped — but the store is reported as FAILED, never as a small number.
    appendAll(allEvents, events);
    outcomes.push({
      store,
      status: "failed",
      events: events.length,
      error: error instanceof Error ? error.message : String(error),
      readFailures: readFailuresOf(events)
    });
    process.stdout.write(`${store} FAILED after ${events.length.toLocaleString("en-US")} events\n\n`);
    return;
  }

  appendAll(allEvents, events);
  process.stdout.write(`${store} extracted: ${events.length.toLocaleString("en-US")} events\n`);
  for (const [kind, n] of Object.entries(kindCounts)) {
    process.stdout.write(`  ${kind}: ${n.toLocaleString("en-US")}\n`);
  }
  const epoch = events.find((e) => e.eventKind === "extraction_epoch");
  if (epoch) {
    process.stdout.write(`  window: ${epoch.metrics.windowOldest} → ${epoch.metrics.windowNewest}\n`);
  }

  const handoffPath = await writeHandoff(buildStoreHandoff(events));
  process.stdout.write(
    handoffPath
      ? `  handoff: → ${handoffPath}\n\n`
      : "  handoff: desktop app container not found — skipped\n\n"
  );

  outcomes.push({
    store,
    status: "extracted",
    events: events.length,
    readFailures: readFailuresOf(events)
  });
}

interface SummaryInput {
  outcomes: SourceOutcome[];
  eventsFile: string;
  totalExtracted: number;
  shippable: number;
  ship: boolean;
  shipResult: ShipResult | null;
  shipError: string | null;
}

/**
 * The closing summary. Printed on every path, success or failure, because it
 * is the thing a caller reads instead of inferring an outcome from the
 * absence of an error.
 */
function writeSummary(input: SummaryInput): void {
  const { outcomes, shipResult, ship } = input;
  const out = process.stdout;
  out.write("\n" + "─".repeat(60) + "\nsummary\n");

  for (const outcome of outcomes) {
    const name = outcome.store.padEnd(12);
    if (outcome.status === "absent") {
      out.write(`  ${name} not present on this machine\n`);
      continue;
    }
    if (outcome.status === "failed") {
      out.write(`  ${name} FAILED — ${outcome.error}\n`);
      out.write(`  ${" ".repeat(12)} ${outcome.events.toLocaleString("en-US")} events salvaged before the failure\n`);
      continue;
    }
    const counts = shipResult?.perStore[outcome.store];
    let line = `  ${name} ${outcome.events.toLocaleString("en-US")} extracted`;
    if (counts) {
      line += `, ${counts.sent.toLocaleString("en-US")} sent`;
      line += ` (accepted ${counts.accepted.toLocaleString("en-US")}`;
      line += `, duplicate ${counts.duplicate.toLocaleString("en-US")}`;
      line += `, rejected ${counts.rejected.toLocaleString("en-US")})`;
    }
    out.write(line + "\n");
    if (outcome.readFailures > 0) {
      out.write(
        `  ${" ".repeat(12)} ⚠ ${outcome.readFailures.toLocaleString("en-US")} file(s)/record(s) this store could not read — the window is short by an unknown amount\n`
      );
    }
  }

  out.write(`  ${"total".padEnd(12)} ${input.totalExtracted.toLocaleString("en-US")} extracted`);
  out.write(ship ? `, ${input.shippable.toLocaleString("en-US")} eligible for the wire\n` : "\n");
  out.write(`  events file: ${input.eventsFile}\n`);

  if (!ship) {
    out.write("\ndry run — pass --ship to send these over the batch wire.\n");
    return;
  }
  if (input.shipError) {
    out.write(`\nship FAILED: ${input.shipError}\n`);
    return;
  }
  if (!shipResult) {
    out.write("\nship did not run.\n");
    return;
  }
  out.write(
    `\nshipped: sent=${shipResult.sent} accepted=${shipResult.accepted} duplicate=${shipResult.duplicate} rejected=${shipResult.rejected} httpFailures=${shipResult.httpFailures}\n`
  );
  if (shipResult.duplicate > 0) {
    out.write(
      `  ${shipResult.duplicate.toLocaleString("en-US")} already imported — the backend kept its existing copy and stored nothing new.\n`
    );
  }
  if (shipResult.consentBlocked) {
    out.write(
      "\n  stopped early: this account has no consent for a retrospective import, so the\n" +
        "  backend refused the whole batch and every remaining event would be refused too.\n" +
        "  Nothing was stored. Grant it in Flow — Connections > Bring in daily tools — and\n" +
        "  run this again; the import is idempotent, so nothing here is wasted.\n"
    );
  }
  for (const [reason, n] of Object.entries(shipResult.rejectionReasons)) {
    out.write(`  rejected ${reason}: ${n}\n`);
  }
  if (!shipResult.attributionComplete) {
    out.write(
      "  note: at least one batch could not be attributed per source — the per-source accept/reject splits above are incomplete.\n"
    );
  }
}

/**
 * Non-zero whenever the caller would be wrong to treat this run as a
 * complete import: any source that failed, any transport failure, any
 * rejection, or a ship that landed nothing at all.
 */
function exitCodeFor(
  outcomes: SourceOutcome[],
  ship: boolean,
  shipResult: ShipResult | null,
  shipError: string | null
): number {
  if (outcomes.some((o) => o.status === "failed")) return 1;
  if (!ship) return 0;
  if (shipError || !shipResult) return 1;
  if (shipResult.rejected > 0 || shipResult.httpFailures > 0) return 1;
  // A re-run over records the backend already holds is a success, not a
  // failure: everything the user asked to be there is there. Gating on
  // `accepted > 0` alone would make the second run of a working importer
  // report failure precisely because dedup did its job.
  return shipResult.accepted + shipResult.duplicate > 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const paths = resolveStorePaths();

  switch (command) {
    case "scan": {
      const inventories = await scanAll(paths);
      if (rest.includes("--json")) {
        process.stdout.write(JSON.stringify(inventories, null, 2) + "\n");
      } else {
        process.stdout.write(inventories.map(formatInventory).join("\n\n") + "\n");
      }
      return 0;
    }
    case "import": {
      // Evaporation order: Claude Code first (its 30-day rolling purge is
      // deleting a day of baseline per day this hasn't run), then Cursor (no
      // purge observed, but the richest per-message structure), then VS Code
      // (stable, ~9-month baseline). Each store is independently optional AND
      // independently fallible — a machine missing any of them, or a store
      // that blows up mid-read, still gets a real import of the rest. That
      // isolation is new: before it, VS Code failing on the last source threw
      // away the Claude Code and Cursor events already extracted above it.
      const ship = rest.includes("--ship");
      const keepStaging = rest.includes("--keep-staging");
      const snapshotSessions = rest.includes("--snapshot-sessions");

      const claudeScan = await safeScan("claude_code", paths.claudeProjects, () => scanClaudeCode(paths));
      const cursorScan = await safeScan("cursor", paths.cursorStateDb, () => scanCursor(paths));
      const vsCodeScan = await safeScan("vscode", paths.vscodeHistory, () => scanVsCode(paths));
      const claudeInventory = claudeScan.inventory;
      const cursorInventory = cursorScan.inventory;
      const vsCodeInventory = vsCodeScan.inventory;
      const anyScanFailed = [claudeScan, cursorScan, vsCodeScan].some((r) => r.scanError !== null);
      // "Nothing to import" and "we could not look" are different answers, and
      // only the first of them is a clean exit.
      if (!claudeInventory.present && !cursorInventory.present && !vsCodeInventory.present && !anyScanFailed) {
        process.stderr.write(
          `no Claude Code store at ${claudeInventory.rootPath}, no Cursor store at ${cursorInventory.rootPath}, and no VS Code store at ${vsCodeInventory.rootPath} — nothing to import\n`
        );
        return 2;
      }

      const stagingRoot = defaultStagingRoot(paths.home);

      // Drain any backlog first: it frees the space the pre-flight check is
      // about to measure, so a machine already full of old snapshots heals
      // itself instead of refusing to run.
      const swept = await sweepStagingRoot(stagingRoot);
      if (swept.runsSwept > 0) {
        process.stdout.write(
          `swept ${swept.runsSwept} stale staging run(s), freed ${formatBytes(swept.freedBytes)}\n`
        );
      }

      // What this run will actually copy. VS Code chat sessions are read in
      // place unless --snapshot-sessions, so they are not in this list.
      const willCopy = [paths.claudeProjects, paths.cursorStateDb, paths.vscodeHistory].filter(
        (_, i) => [claudeInventory.present, cursorInventory.present, vsCodeInventory.present][i]
      );
      if (snapshotSessions && vsCodeInventory.present) willCopy.push(paths.vscodeWorkspaceStorage);

      const space = await checkSpaceForSnapshot(stagingRoot, willCopy);
      if (!space.sufficient) {
        process.stderr.write(
          `not enough space to stage this import: need ~${formatBytes(space.requiredBytes)}, ` +
            `${formatBytes(space.freeBytes ?? 0)} free on the volume holding ${stagingRoot}\n` +
            `refusing to start rather than failing halfway through the copy\n`
        );
        return 2;
      }

      const area = await createStagingArea(stagingRoot);
      process.stdout.write(`staging: ${area.root}\n\n`);

      const allEvents: NormalizedHistoricalEvent[] = [];
      const outcomes: SourceOutcome[] = [];

      try {
        await runSource(outcomes, "claude_code", claudeInventory, allEvents, async (collect) => {
          const snapshotRoot = path.join(area.root, "claude_code");
          await snapshotPath(area, paths.claudeProjects, path.join("claude_code", "projects"));
          for await (const event of extractClaudeCode(snapshotRoot, area.extractionId)) collect(event);
        }, (events) => buildHandoff(events, area.extractionId, new Date().toISOString()), claudeScan.scanError);

        await runSource(outcomes, "cursor", cursorInventory, allEvents, async (collect) => {
          const cursorSnapshotRoot = path.join(area.root, "cursor");
          await snapshotPath(area, paths.cursorStateDb, path.join("cursor", "state.vscdb"));
          for await (const event of extractCursor(cursorSnapshotRoot, area.extractionId)) collect(event);
        }, (events) => buildCursorHandoff(events, area.extractionId, new Date().toISOString()), cursorScan.scanError);

        await runSource(outcomes, "vscode", vsCodeInventory, allEvents, async (collect) => {
          // Timeline history is small (~280 MB) and cheap to snapshot. Chat
          // sessions are not: they were 15 GB of the ~20 GB per run on the
          // machine that filled up, and the bulk of them are months-old closed
          // sessions that nothing is writing. Copying them bought a
          // consistency guarantee against a risk the readers already handle —
          // a truncated `.jsonl` tail counts as malformed lines, an unreadable
          // file now counts as unreadable — so they are read in place.
          await snapshotPath(area, paths.vscodeHistory, path.join("vscode", "history"));
          let workspaceStorageDir = paths.vscodeWorkspaceStorage;
          if (snapshotSessions) {
            workspaceStorageDir = await snapshotVsCodeWorkspaceStorage(
              area,
              paths.vscodeWorkspaceStorage,
              path.join("vscode", "workspaceStorage")
            );
          }
          const source = {
            historyDir: path.join(area.root, "vscode", "history"),
            workspaceStorageDir
          };
          for await (const event of extractVsCode(source, area.extractionId)) collect(event);
        }, (events) => buildVsCodeHandoff(events, area.extractionId, new Date().toISOString()), vsCodeScan.scanError);

        // The normalized record set stays in staging — raw refs local-only.
        const eventsFile = path.join(area.root, "events.jsonl");
        await fs.writeFile(eventsFile, allEvents.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

        let shipResult: Awaited<ReturnType<typeof shipEvents>> | null = null;
        let shipError: string | null = null;
        if (ship) {
          const config = loadShipConfig();
          process.stdout.write(`\nshipping to ${config.apiBaseUrl} as ${config.toolInstallationId}…\n`);
          try {
            shipResult = await shipEvents(allEvents, config, (done, total) => {
              process.stdout.write(`  ${done.toLocaleString("en-US")}/${total.toLocaleString("en-US")}\r`);
            });
            process.stdout.write("\n");
          } catch (error) {
            process.stdout.write("\n");
            shipError = error instanceof Error ? error.message : String(error);
          }
        }

        writeSummary({
          outcomes,
          eventsFile,
          totalExtracted: allEvents.length,
          shippable: shippableEvents(allEvents).length,
          ship,
          shipResult,
          shipError
        });

        return exitCodeFor(outcomes, ship, shipResult, shipError);
      } finally {
        // Teardown runs on the success path and on the way out of a throw
        // alike: the failure that started all this left ~20 GB behind
        // precisely because it died before any cleanup could run.
        if (keepStaging) {
          process.stdout.write(`\nstaging kept at ${area.root} (--keep-staging)\n`);
        } else {
          const disposed = await disposeStagingArea(area);
          if (disposed.freedBytes > 0) {
            process.stdout.write(
              `\nstaging cleaned: freed ${formatBytes(disposed.freedBytes)}, kept ${disposed.kept.join(", ") || "nothing"}\n`
            );
          }
        }
      }
    }
    case "archive": {
      const archiveRoot = defaultArchiveRoot(paths.home);
      const flagValue = (name: string): string | null => {
        const at = rest.indexOf(name);
        return at >= 0 && rest[at + 1] ? rest[at + 1] : null;
      };
      const generationFlag = flagValue("--generation");

      if (rest.includes("--list")) {
        const generations = await listManifests(archiveRoot);
        if (generations.length === 0) {
          process.stdout.write(`no archive at ${archiveRoot} — run \`archive\` to create one\n`);
          return 0;
        }
        for (const generation of generations) {
          const manifest = await readManifest(archiveRoot, generation);
          if (!manifest) {
            // A manifest we cannot read is not an absence. Saying so is the
            // whole point of this package's recent history.
            process.stdout.write(`  ${generation}  UNREADABLE\n`);
            continue;
          }
          const bytes = manifest.files.reduce((sum, f) => sum + f.size, 0);
          process.stdout.write(
            `  ${generation}  ${manifest.files.length.toLocaleString("en-US")} files  ${formatBytes(bytes)} logical\n`
          );
        }
        process.stdout.write(`\narchive on disk: ${formatBytes(await archiveSizeBytes(archiveRoot))}\n`);
        return 0;
      }

      if (rest.includes("--verify")) {
        const manifest = generationFlag
          ? await readManifest(archiveRoot, generationFlag)
          : await readLatestManifest(archiveRoot);
        if (!manifest) {
          process.stderr.write(`no readable generation to verify in ${archiveRoot}\n`);
          return 2;
        }
        const verified = await verifyArchive(archiveRoot, manifest);
        process.stdout.write(
          `generation ${verified.generation}: ${verified.checked.toLocaleString("en-US")} files checked, ` +
            `${verified.missing.length} missing, ${verified.corrupted.length} corrupted\n`
        );
        for (const file of verified.missing.slice(0, 10)) process.stdout.write(`  missing: ${file}\n`);
        for (const file of verified.corrupted.slice(0, 10)) process.stdout.write(`  corrupted: ${file}\n`);
        // A backup that fails verification must fail the command. Reporting
        // "checked 12,000 files" and exiting 0 while some of them are gone is
        // the defect class this package keeps finding.
        return verified.missing.length + verified.corrupted.length > 0 ? 1 : 0;
      }

      const restoreTo = flagValue("--restore");
      if (rest.includes("--restore")) {
        if (!restoreTo) {
          process.stderr.write("--restore needs a destination directory\n");
          return 2;
        }
        const manifest = generationFlag
          ? await readManifest(archiveRoot, generationFlag)
          : await readLatestManifest(archiveRoot);
        if (!manifest) {
          process.stderr.write(`no readable generation to restore in ${archiveRoot}\n`);
          return 2;
        }
        const restored = await restoreArchive(archiveRoot, manifest, restoreTo);
        process.stdout.write(
          `restored ${restored.restored.toLocaleString("en-US")} files from ${manifest.generation} → ${restored.destination}\n`
        );
        if (restored.skipped > 0) {
          process.stdout.write(`  ${restored.skipped} could not be written\n`);
        }
        process.stdout.write(
          "\nnothing was written to the live stores — copy back by hand once you have looked at this.\n"
        );
        return restored.skipped > 0 ? 1 : 0;
      }

      if (rest.includes("--prune")) {
        const keep = Number(flagValue("--keep") ?? 10);
        if (!Number.isInteger(keep) || keep < 1) {
          process.stderr.write("--keep needs a positive integer\n");
          return 2;
        }
        const pruned = await pruneArchive(archiveRoot, keep);
        process.stdout.write(
          `pruned ${pruned.generationsRemoved.length} generation(s) and ${pruned.blobsRemoved} unreferenced blob(s), ` +
            `freed ${formatBytes(pruned.freedBytes)}\n`
        );
        process.stdout.write(`archive on disk: ${formatBytes(await archiveSizeBytes(archiveRoot))}\n`);
        return 0;
      }

      // Default: take a generation.
      const includeSessions = rest.includes("--include-vscode-sessions");
      const sources = defaultArchiveSources(paths, includeSessions);
      const generation = new Date().toISOString().replace(/[:.]/g, "-");

      process.stdout.write(`archiving to ${archiveRoot}\n`);
      for (const source of sources) process.stdout.write(`  ${source.store}/${source.label}: ${source.root}\n`);
      if (!includeSessions) {
        process.stdout.write(
          "  vscode/workspaceStorage: skipped — 15 GB that VS Code is not deleting (--include-vscode-sessions to add)\n"
        );
      }
      process.stdout.write("\n");

      const result = await archiveStores({
        archiveRoot,
        sources,
        generation,
        now: new Date().toISOString()
      });

      process.stdout.write("─".repeat(60) + `\ngeneration ${result.generation}\n`);
      for (const [store, counts] of Object.entries(result.perStore)) {
        process.stdout.write(
          `  ${store.padEnd(12)} ${counts.files.toLocaleString("en-US")} files, ${formatBytes(counts.newBytes)} new\n`
        );
      }
      process.stdout.write(
        `  ${"total".padEnd(12)} ${result.filesArchived.toLocaleString("en-US")} files ` +
          `(${result.filesDeduplicated.toLocaleString("en-US")} already held), ${formatBytes(result.newBytes)} new\n`
      );
      if (result.unreadable > 0) {
        process.stdout.write(
          `  ⚠ ${result.unreadable} file(s) could not be read — this generation is short by an unknown amount\n`
        );
      }
      const onDisk = await archiveSizeBytes(archiveRoot);
      process.stdout.write(`  archive on disk: ${formatBytes(onDisk)} across ${(await listManifests(archiveRoot)).length} generation(s)\n`);
      process.stdout.write(`  manifest: ${result.manifestPath}\n`);
      process.stdout.write("\nverify it: ascenda-history-import archive --verify\n");

      // An archive run that could not read part of a store has not made the
      // copy it was asked for.
      return result.unreadable > 0 ? 1 : 0;
    }
    case "fix-retention": {
      const plan = await planClaudeRetentionFix(paths);
      if (!plan.changeNeeded) {
        process.stdout.write(
          `cleanupPeriodDays is already ${plan.currentCleanupPeriodDays} — nothing to do.\n`
        );
        return 0;
      }
      process.stdout.write(
        `${plan.settingsPath}: cleanupPeriodDays ${
          plan.currentCleanupPeriodDays ?? "(unset, 30 by default)"
        } → ${plan.proposedCleanupPeriodDays}\n`
      );
      if (rest.includes("--apply")) {
        await applyClaudeRetentionFix(plan);
        process.stdout.write("applied.\n");
      } else {
        process.stdout.write("dry run — pass --apply to write it.\n");
      }
      return 0;
    }
    default: {
      process.stderr.write(
        "usage: ascenda-history-import <scan [--json] | import [--ship] | fix-retention [--apply] | archive [--verify|--list|--restore <dir>|--prune]>\n"
      );
      return command === undefined || command === "--help" ? 0 : 2;
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
);
