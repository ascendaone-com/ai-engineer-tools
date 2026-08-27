import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { WorkContext } from "./workContext";

// `~/.ascenda/work-contexts.json` — the local hash→name dictionary.
//
// LOCAL ONLY, same contract as the salt beside it: this file never leaves the
// machine, and nothing that leaves the machine contains what it holds. The
// wire carries only salted digests; this file is the machine's own record of
// which digest is which folder. It exists because the mapping is only
// recoverable while the salt AND the repository both still exist — repos get
// deleted and renamed, so the honest time to record a name is the moment the
// hash is computed. Deleting this file orphans no data; it only costs the
// names (a surface reading it would show "Context a1b2…" instead of
// "asc-core-be" until the context is seen again).
//
// This is deliberately groundwork: no shipped surface reads it yet. It is the
// half of the project-visibility design that cannot be built retroactively.

export interface WorkContextRegistryEntry {
  kind: "project" | "workspace" | "alias";
  /** Human-readable folder/repo basename — or, for an alias, whatever label the legacy input carried. */
  label: string;
  /** Paths this hash has been observed at. Capped; a sample, not a census. */
  paths: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface WorkContextRegistry {
  version: 1;
  contexts: Record<string, WorkContextRegistryEntry>;
}

const MAX_PATHS_PER_ENTRY = 8;

export function workContextRegistryFilePath(): string {
  return path.join(os.homedir(), ".ascenda", "work-contexts.json");
}

export function readWorkContextRegistry(
  registryFilePath: string = workContextRegistryFilePath()
): WorkContextRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFilePath, "utf8"));
    if (parsed && parsed.version === 1 && parsed.contexts && typeof parsed.contexts === "object") {
      return parsed as WorkContextRegistry;
    }
  } catch {
    // Missing or unreadable both mean the same thing: start fresh. The
    // registry is a convenience index, not a store of record.
  }
  return { version: 1, contexts: {} };
}

/**
 * Records a derived context (both its hashes) in the local registry.
 *
 * Never throws — this runs on the hook hot path, and a corrupt index is not
 * worth a broken agent turn. Returns false when nothing was written, which is
 * also the common case: an entry already known under the same label and path
 * is only refreshed when the UTC day changes, so steady-state hooks do one
 * `readFileSync` and no write.
 */
export function recordWorkContext(
  context: WorkContext | null,
  options?: { registryFilePath?: string; now?: Date }
): boolean {
  if (!context) return false;
  const updates: Array<{ hash: string; kind: "project" | "workspace"; label: string; observedPath: string | null }> = [];
  if (context.projectHash && context.projectLabel) {
    updates.push({ hash: context.projectHash, kind: "project", label: context.projectLabel, observedPath: context.projectPath ?? context.workspacePath });
  }
  if (context.workspaceHash && context.workspaceLabel && context.workspaceHash !== context.projectHash) {
    updates.push({ hash: context.workspaceHash, kind: "workspace", label: context.workspaceLabel, observedPath: context.workspacePath });
  }
  return upsert(updates, options);
}

/**
 * Records a bare hash→label pair the standard derivation would not produce.
 *
 * Exists for legacy identities: the first historical imports hashed the FULL
 * cwd path, and those digests are already in stored rows. Registering them as
 * aliases beside the canonical entries keeps every stored row nameable.
 */
export function recordWorkContextAlias(
  hash: string | null | undefined,
  label: string | null | undefined,
  observedPath?: string | null,
  options?: { registryFilePath?: string; now?: Date }
): boolean {
  if (!hash || !label) return false;
  return upsert([{ hash, kind: "alias", label, observedPath: observedPath ?? null }], options);
}

function upsert(
  updates: Array<{ hash: string; kind: WorkContextRegistryEntry["kind"]; label: string; observedPath: string | null }>,
  options?: { registryFilePath?: string; now?: Date }
): boolean {
  if (updates.length === 0) return false;
  try {
    const registryFilePath = options?.registryFilePath ?? workContextRegistryFilePath();
    const nowIso = (options?.now ?? new Date()).toISOString();
    const registry = readWorkContextRegistry(registryFilePath);

    let dirty = false;
    for (const update of updates) {
      const existing = registry.contexts[update.hash];
      if (!existing) {
        registry.contexts[update.hash] = {
          kind: update.kind,
          label: update.label,
          paths: update.observedPath ? [update.observedPath] : [],
          firstSeenAt: nowIso,
          lastSeenAt: nowIso
        };
        dirty = true;
        continue;
      }

      // An alias record never overrides what direct observation established,
      // but a direct observation upgrades an alias.
      if (existing.kind === "alias" && update.kind !== "alias") {
        existing.kind = update.kind;
        dirty = true;
      }
      if (existing.label !== update.label && update.kind !== "alias") {
        existing.label = update.label;
        dirty = true;
      }
      if (update.observedPath && !existing.paths.includes(update.observedPath)) {
        if (existing.paths.length < MAX_PATHS_PER_ENTRY) existing.paths.push(update.observedPath);
        dirty = true;
      }
      if (dayOf(existing.lastSeenAt) !== dayOf(nowIso)) {
        existing.lastSeenAt = nowIso;
        dirty = true;
      }
    }

    if (!dirty) return false;
    writeRegistry(registryFilePath, registry);
    return true;
  } catch {
    return false;
  }
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function writeRegistry(registryFilePath: string, registry: WorkContextRegistry): void {
  const dir = path.dirname(registryFilePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Write-then-rename so a concurrent hook reading mid-write sees the old
  // index, never a torn one. Two concurrent writers can drop one another's
  // refresh; acceptable — the next event on that context restores it.
  const tmp = `${registryFilePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, registryFilePath);
  if (process.platform !== "win32") {
    fs.chmodSync(registryFilePath, 0o600);
  }
}
