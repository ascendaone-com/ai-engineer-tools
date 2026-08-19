#!/usr/bin/env node
/**
 * ascenda-history-import — retrospective AI-usage import.
 *
 *   scan            inventory the stores (read-only, content never opened)
 *   scan --json     same, machine-readable — what the app's consent surface renders
 *   import          snapshot + extract + ship (NOT IMPLEMENTED in the scaffold)
 *   fix-retention   show the Claude Code retention plan; --apply to write it
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
  createStagingArea,
  defaultStagingRoot,
  snapshotPath,
  snapshotVsCodeWorkspaceStorage
} from "./staging.js";
import { extractClaudeCode } from "./extractors/claudeCode.js";
import { extractCursor } from "./extractors/cursor.js";
import { extractVsCode } from "./extractors/vscode.js";
import { loadShipConfig, shipEvents } from "./ship.js";
import { buildHandoff, buildCursorHandoff, buildVsCodeHandoff, writeHandoff } from "./localHandoff.js";
import { NormalizedHistoricalEvent, StoreInventory } from "./types.js";

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
      // (stable, ~9-month baseline — safe to run in this same background
      // pass rather than needing its own onboarding moment). git still slots
      // in behind the same staging/extract/ship flow. Each store is
      // independently optional — a machine missing any of them still gets a
      // real import of the rest, not an all-or-nothing failure.
      const ship = rest.includes("--ship");

      const claudeInventory = await scanClaudeCode(paths);
      const cursorInventory = await scanCursor(paths);
      const vsCodeInventory = await scanVsCode(paths);
      if (!claudeInventory.present && !cursorInventory.present && !vsCodeInventory.present) {
        process.stderr.write(
          `no Claude Code store at ${claudeInventory.rootPath}, no Cursor store at ${cursorInventory.rootPath}, and no VS Code store at ${vsCodeInventory.rootPath} — nothing to import\n`
        );
        return 2;
      }

      const area = await createStagingArea(defaultStagingRoot(paths.home));
      process.stdout.write(`staging: ${area.root}\n\n`);

      const allEvents: NormalizedHistoricalEvent[] = [];

      if (claudeInventory.present) {
        process.stdout.write(formatInventory(claudeInventory) + "\n\n");
        const snapshotRoot = path.join(area.root, "claude_code");
        await snapshotPath(area, paths.claudeProjects, path.join("claude_code", "projects"));

        const claudeEvents: NormalizedHistoricalEvent[] = [];
        const kindCounts: Record<string, number> = {};
        for await (const event of extractClaudeCode(snapshotRoot, area.extractionId)) {
          claudeEvents.push(event);
          kindCounts[event.eventKind] = (kindCounts[event.eventKind] ?? 0) + 1;
        }
        allEvents.push(...claudeEvents);

        const epoch = claudeEvents.find((e) => e.eventKind === "extraction_epoch");
        process.stdout.write(`claude_code extracted: ${claudeEvents.length.toLocaleString("en-US")} events\n`);
        for (const [kind, n] of Object.entries(kindCounts)) {
          process.stdout.write(`  ${kind}: ${n.toLocaleString("en-US")}\n`);
        }
        if (epoch) {
          process.stdout.write(`  window: ${epoch.metrics.windowOldest} → ${epoch.metrics.windowNewest}\n`);
        }

        const handoff = buildHandoff(claudeEvents, area.extractionId, new Date().toISOString());
        const handoffPath = await writeHandoff(handoff);
        if (handoffPath) {
          process.stdout.write(`  handoff: ${handoff.sessions.length} sessions → ${handoffPath}\n\n`);
        } else {
          process.stdout.write("  handoff: desktop app container not found — skipped\n\n");
        }
      } else {
        process.stdout.write(formatInventory(claudeInventory) + "\n\n");
      }

      if (cursorInventory.present) {
        process.stdout.write(formatInventory(cursorInventory) + "\n\n");
        const cursorSnapshotRoot = path.join(area.root, "cursor");
        await snapshotPath(area, paths.cursorStateDb, path.join("cursor", "state.vscdb"));

        const cursorEvents: NormalizedHistoricalEvent[] = [];
        const kindCounts: Record<string, number> = {};
        for await (const event of extractCursor(cursorSnapshotRoot, area.extractionId)) {
          cursorEvents.push(event);
          kindCounts[event.eventKind] = (kindCounts[event.eventKind] ?? 0) + 1;
        }
        allEvents.push(...cursorEvents);

        const epoch = cursorEvents.find((e) => e.eventKind === "extraction_epoch");
        process.stdout.write(`cursor extracted: ${cursorEvents.length.toLocaleString("en-US")} events\n`);
        for (const [kind, n] of Object.entries(kindCounts)) {
          process.stdout.write(`  ${kind}: ${n.toLocaleString("en-US")}\n`);
        }
        if (epoch) {
          process.stdout.write(`  window: ${epoch.metrics.windowOldest} → ${epoch.metrics.windowNewest}\n`);
        }

        const handoff = buildCursorHandoff(cursorEvents, area.extractionId, new Date().toISOString());
        const handoffPath = await writeHandoff(handoff);
        if (handoffPath) {
          process.stdout.write(`  handoff: ${handoff.sessions.length} sessions → ${handoffPath}\n\n`);
        } else {
          process.stdout.write("  handoff: desktop app container not found — skipped\n\n");
        }
      } else {
        process.stdout.write(formatInventory(cursorInventory) + "\n\n");
      }

      if (vsCodeInventory.present) {
        process.stdout.write(formatInventory(vsCodeInventory) + "\n\n");
        const vsCodeSnapshotRoot = path.join(area.root, "vscode");
        await snapshotPath(area, paths.vscodeHistory, path.join("vscode", "history"));
        await snapshotVsCodeWorkspaceStorage(area, paths.vscodeWorkspaceStorage, path.join("vscode", "workspaceStorage"));

        const vsCodeEvents: NormalizedHistoricalEvent[] = [];
        const kindCounts: Record<string, number> = {};
        for await (const event of extractVsCode(vsCodeSnapshotRoot, area.extractionId)) {
          vsCodeEvents.push(event);
          kindCounts[event.eventKind] = (kindCounts[event.eventKind] ?? 0) + 1;
        }
        allEvents.push(...vsCodeEvents);

        const epoch = vsCodeEvents.find((e) => e.eventKind === "extraction_epoch");
        process.stdout.write(`vscode extracted: ${vsCodeEvents.length.toLocaleString("en-US")} events\n`);
        for (const [kind, n] of Object.entries(kindCounts)) {
          process.stdout.write(`  ${kind}: ${n.toLocaleString("en-US")}\n`);
        }
        if (epoch) {
          process.stdout.write(`  window: ${epoch.metrics.windowOldest} → ${epoch.metrics.windowNewest}\n`);
        }

        const handoff = buildVsCodeHandoff(vsCodeEvents, area.extractionId, new Date().toISOString());
        const handoffPath = await writeHandoff(handoff);
        if (handoffPath) {
          process.stdout.write(
            `  handoff: ${handoff.editDays.length} edit-days, ${handoff.chatSessions.length} chat sessions → ${handoffPath}\n\n`
          );
        } else {
          process.stdout.write("  handoff: desktop app container not found — skipped\n\n");
        }
      } else {
        process.stdout.write(formatInventory(vsCodeInventory) + "\n\n");
      }

      // The normalized record set stays in staging — raw refs local-only.
      const eventsFile = path.join(area.root, "events.jsonl");
      await fs.writeFile(eventsFile, allEvents.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      process.stdout.write(`total extracted: ${allEvents.length.toLocaleString("en-US")} events\n`);
      process.stdout.write(`events file: ${eventsFile}\n`);

      if (!ship) {
        process.stdout.write("dry run — pass --ship to send these over the batch wire.\n");
        return 0;
      }

      const config = loadShipConfig();
      process.stdout.write(`shipping to ${config.apiBaseUrl} as ${config.toolInstallationId}…\n`);
      const result = await shipEvents(allEvents, config, (done, total) => {
        process.stdout.write(`  ${done.toLocaleString("en-US")}/${total.toLocaleString("en-US")}\r`);
      });
      process.stdout.write("\n");
      process.stdout.write(
        `shipped: sent=${result.sent} accepted=${result.accepted} duplicate=${result.duplicate} rejected=${result.rejected} httpFailures=${result.httpFailures}\n`
      );
      if (result.duplicate > 0) {
        process.stdout.write(
          `  ${result.duplicate.toLocaleString("en-US")} already imported — the backend kept its existing copy and stored nothing new.\n`
        );
      }
      for (const [reason, n] of Object.entries(result.rejectionReasons)) {
        process.stdout.write(`  rejected ${reason}: ${n}\n`);
      }
      // A re-run over records the backend already holds is a success, not a
      // failure: everything the user asked to be there is there. Gating the exit
      // code on `accepted > 0` alone would make the second run of a working
      // importer report failure precisely because dedup did its job.
      return result.accepted + result.duplicate > 0 && result.rejected === 0 && result.httpFailures === 0
        ? 0
        : 1;
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
        "usage: ascenda-history-import <scan [--json] | import [--ship] | fix-retention [--apply]>\n"
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
