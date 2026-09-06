/**
 * Ships normalized historical events over the existing batch wire
 * (`POST /v1/tool-events/batch`), authenticated with the same event write
 * token the live hooks use — the import is just another paired tool speaking
 * the same protocol, backdated.
 *
 * Three deliberate choices:
 *
 * - **Own fetch, not tool-kit's `postToolEventsBatch`.** The hook path
 *   collapses the response to accepted/failed because a hook can't do
 *   anything with detail. An importer can: the batch response carries
 *   per-item accepted/rejected with reasons, and surfacing "9,741 accepted,
 *   3 rejected (validation_failed)" is the difference between a verifiable
 *   import and a shrug.
 * - **Stable `importKey` per event.** sha256 over
 *   (store|sessionRef|eventKind|occurredAt|ordinal) — identical on every
 *   re-run of the same store. Since 20 Aug 2026 this is what the backend
 *   dedups on: `(pairedUser, toolInstallation, importKey)` is unique, a
 *   replayed event is reported as `duplicate` and writes nothing, and the
 *   key is *required* on anything carrying a historical provenance. Note it
 *   dedups on this key alone, NOT on `(extractionId, importKey)` — an
 *   extraction id is fresh per run, so including it would dedup nothing.
 *
 *   The key is the FULL hex digest, kept deliberately at 64 chars for parity
 *   with the in-app Dart pipeline (`assignImportKeys` in the macOS app's
 *   wire_event.dart), which hashes the same preimage and is the product path.
 *   The backend compares key strings verbatim, and both pipelines ship as the
 *   same tool installation — so only byte-identical keys let a record shipped
 *   by either pipeline dedup against the other instead of double-counting.
 *
 *   `ordinal` used to be the event's index in the whole shipped array, which
 *   made the key stable only while the store was. A later run extracting a
 *   different *set* — Claude Code's 30-day purge having eaten the oldest
 *   days — shifted every subsequent ordinal, so unchanged records re-keyed
 *   and dedup silently stopped working on exactly the re-run it exists for.
 *   That is no longer a position: `importOrdinals` numbers an event only
 *   among events sharing its whole identity (store, session, kind, instant),
 *   so it disambiguates genuine duplicates and nothing else. Deleting a day,
 *   a session, or an entire store leaves every surviving key untouched.
 * - **Raw local refs are hashed at the wire, not before.** The normalized
 *   file in staging keeps the real cwd (local, never leaves the machine);
 *   `workspaceHash`/`projectHash` go out through tool-kit's shared
 *   `deriveWorkContext` — the SAME derivation the live hooks use (basename
 *   of the folder / of its canonical repo), so historical and live events
 *   for the same repo carry the same digests and correlate server-side
 *   without the server ever learning the path. Early imports hashed the
 *   full cwd instead; that digest is registered as a local alias so rows
 *   already stored under it stay nameable (see contextRegistry.ts).
 */
import { createHash } from "node:crypto";
import {
  classifyModelClass,
  deriveBranchHash,
  deriveWorkContext,
  hashWithMachineSalt,
  readTokenFile,
  recordWorkContext,
  recordWorkContextAlias,
  defaultTokenFilePath,
  utcOffsetMinutesAt
} from "@ascenda-one/tool-kit";
import type { WorkContext } from "@ascenda-one/tool-kit";
import type { AscendaEventPayload, AscendaTelemetrySource } from "@ascenda-one/tool-contract";
import {
  EXTRACTION_EPOCH_KIND,
  HISTORICAL_CONSENT_SCOPE,
  NormalizedHistoricalEvent,
  STORE_HOST,
  STORE_SOURCE
} from "./types.js";

export interface ShipConfig {
  apiBaseUrl: string;
  toolInstallationId: string;
  eventWriteToken: string;
}

export const DEFAULT_API_BASE_URL = "https://api.ascenda.one";

/** Mirrors tool-kit's loadCliAgentConfig, minus the hook-only pieces. */
export function loadShipConfig(): ShipConfig {
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const idRaw = process.env.ASCENDA_TOOL_INSTALLATION_ID;
  if (!idRaw) {
    throw new Error(
      "Missing ASCENDA_TOOL_INSTALLATION_ID — the importer ships as the machine's paired tool; pair it first"
    );
  }
  const toolInstallationId = idRaw.trim().includes(":") ? idRaw.trim() : `claude_code:${idRaw.trim()}`;
  const tokenFilePath =
    process.env.ASCENDA_EVENT_WRITE_TOKEN_FILE ?? defaultTokenFilePath(toolInstallationId);
  const eventWriteToken = readTokenFile(tokenFilePath) ?? process.env.ASCENDA_EVENT_WRITE_TOKEN;
  if (!eventWriteToken) {
    throw new Error(`No event write token at ${tokenFilePath} (or ASCENDA_EVENT_WRITE_TOKEN)`);
  }
  return { apiBaseUrl, toolInstallationId, eventWriteToken };
}

/**
 * Per-event ordinals for a batch, positionally aligned with `events`.
 *
 * The ordinal exists only to separate events that are otherwise identical on
 * the wire — same store, same session, same kind, same instant. Claude Code
 * really does emit these: one prompt can produce several events sharing a
 * millisecond, and without a tiebreak they would collapse to one key and the
 * backend would dedup away real records.
 *
 * Counting within that identity rather than across the array is what makes
 * the key survive a changing store. Two runs over stores that differ by
 * whole days still agree on every record they share, because nothing outside
 * an event's own identity group can move its number. Within a group the
 * assignment order is irrelevant: the members are indistinguishable by
 * definition, so any consistent numbering pairs them up.
 */
export function importOrdinals(events: NormalizedHistoricalEvent[]): number[] {
  const seen = new Map<string, number>();
  return events.map((event) => {
    const identity = [event.store, event.sessionRef ?? "", event.eventKind, event.occurredAt].join(
      "|"
    );
    const ordinal = seen.get(identity) ?? 0;
    seen.set(identity, ordinal + 1);
    return ordinal;
  });
}

/**
 * The FULL 64-char sha256 hex, never a prefix. The in-app Dart importer
 * (`assignImportKeys` in wire_event.dart) hashes the identical preimage and
 * ships all 64 chars, and the backend dedups on the verbatim key string per
 * (pairedUser, toolInstallation) — so a truncated key here could never match
 * an app-shipped key for the same record, and a mixed-pipeline re-run would
 * land the whole corpus twice. Until 26 Aug 2026 this sliced to 16 chars;
 * those rows all predate the identity-scoped ordinal, so no later run would
 * have matched them under either width and nothing real is stranded.
 */
export function importKeyOf(event: NormalizedHistoricalEvent, ordinal: number): string {
  return createHash("sha256")
    .update(
      [event.store, event.sessionRef ?? "", event.eventKind, event.occurredAt, String(ordinal)].join(
        "|"
      )
    )
    .digest("hex");
}

/**
 * Context derivation for a historical repo ref, memoized per run — an import
 * replays tens of thousands of events over a handful of repos, and the
 * derivation may touch the filesystem (a still-existing checkout resolves to
 * its canonical repo; a deleted one degrades to basenames).
 *
 * Two side effects per unique ref, both local-only registry writes: the
 * canonical labels, and the LEGACY digest — `hash(full cwd)`, which is what
 * imports before this derivation existed put on the wire. Rows stored under
 * that digest can never be re-keyed (the import is immutable by design), so
 * the alias is what keeps them nameable on this machine.
 */
const workContextMemo = new Map<string, WorkContext | null>();

function workContextOf(repoRef: string | null): WorkContext | null {
  if (!repoRef) return null;
  const hit = workContextMemo.get(repoRef);
  if (hit !== undefined) return hit;

  const context = deriveWorkContext(repoRef);
  if (context) {
    recordWorkContext(context);
    const legacyHash = hashWithMachineSalt(repoRef);
    if (legacyHash && legacyHash !== context.workspaceHash && legacyHash !== context.projectHash) {
      recordWorkContextAlias(legacyHash, context.workspaceLabel ?? repoRef, context.workspacePath);
    }
  }
  workContextMemo.set(repoRef, context);
  return context;
}

/**
 * Registers this import's PREVIOUS branch digest — `hash(raw branch string)`,
 * shipped under `gitBranchHash` — as a local alias of the canonical one.
 *
 * Only where the two actually differ, i.e. where the raw string needed
 * normalising; a plain `main` hashes identically under both and needs no
 * alias. Memoized per run for the same reason `workContextOf` is: an import
 * replays tens of thousands of events over a handful of branches.
 */
const legacyBranchDigestsSeen = new Set<string>();

function registerLegacyBranchDigest(rawBranch: string, branchHash: string): void {
  if (legacyBranchDigestsSeen.has(rawBranch)) return;
  legacyBranchDigestsSeen.add(rawBranch);
  const legacyHash = hashWithMachineSalt(rawBranch);
  if (legacyHash && legacyHash !== branchHash) recordWorkContextAlias(legacyHash, rawBranch);
}

export function toWirePayload(
  event: NormalizedHistoricalEvent & { eventKind: AscendaEventPayload["eventType"] },
  ordinal: number,
  toolInstallationId: string
): AscendaEventPayload {
  const metadata: Record<string, string | number | boolean> = {
    importKey: importKeyOf(event, ordinal),
    extractionId: event.extractionId,
    importSchema: 1
  };
  if (event.sourceVersion) metadata.sourceVersion = event.sourceVersion;
  // Stores that share a wire source with other tools name themselves here,
  // the way the live Codex hooks do on every row — so a historical Codex
  // session and a live one disaggregate on the same key.
  const host = STORE_HOST[event.store];
  if (host) metadata.host = host;
  for (const [key, value] of Object.entries(event.metrics)) {
    metadata[key] = value;
  }
  // gitBranch is a metric locally but a name on the wire — hash it like the
  // repo path. Branch names leak project vocabulary ("feature/acme-migration").
  //
  // Through `deriveBranchHash` in tool-kit — the SAME function the live Claude
  // Code and Codex hooks call, imported rather than reimplemented, for exactly
  // the reason `classifyModelClass` is shared below: a historical session and
  // a live one on the same branch must land on the same digest, or the two
  // corpora cannot be pooled and a second derivation drifts into a population
  // shift rather than a visible bug.
  //
  // That moved this import off its own older form, which hashed the branch
  // string raw (no `refs/heads/` normalisation) under the key `gitBranchHash`.
  // Rows already stored that way can never be re-keyed — the import is
  // immutable by design — so where the two digests differ the legacy one is
  // registered as a local alias, the same treatment the full-cwd repo digest
  // gets in `workContextOf` above.
  //
  // No key at all when there is no branch to name. The old `?? ""` wrote an
  // empty string, which is a value a reader can group on: it asserted a branch
  // for every session whose store recorded none.
  if (typeof metadata.gitBranch === "string") {
    const rawBranch = metadata.gitBranch;
    delete metadata.gitBranch;
    const branchHash = deriveBranchHash(rawBranch);
    if (branchHash) {
      metadata.branchHash = branchHash;
      registerLegacyBranchDigest(rawBranch, branchHash);
    }
  }
  // The coarse companion to primaryModel, ADDED beside it and never in place
  // of it. Two reasons it is derived here rather than in each extractor:
  //
  //  - One derivation covers Claude Code, Cursor and VS Code, and covers the
  //    next extractor without anyone remembering to add it. Three copies of a
  //    one-line fold is how `contextUsagePercent` happened.
  //  - It applies to staging files written before this existed. The stage
  //    holds `primaryModel`; the class is computed on the way out, so a
  //    resumed or re-sent corpus is classified without re-extracting.
  //
  // `classifyModelClass` is the SAME function the live Claude Code hooks call
  // for `SessionStart` — imported from tool-kit, not reimplemented — which is
  // the entire point of the exercise: a historical session and a live one from
  // the same model land in the same bucket, so a norm table can pool them.
  // The raw string stays: it is the only record of exactly which build ran,
  // and a class cannot be un-coarsened later — which matters more now that the
  // class degrades to `<vendor>:unknown`, since an unmapped tier is precisely
  // the case where somebody will want to know what the string actually said.
  //
  // It stays under `primaryModel` and must NOT be moved to the live path's
  // `modelId`. They are two different measurements: `primaryModel` is this
  // session's dominant model, folded across the whole transcript, while
  // `modelId` is the model a live session opened with. Same derived class, two
  // different underlying facts — fusing them would make the column
  // uninterpretable in exactly the way P-D28 exists to prevent one level up.
  const modelClass = classifyModelClass(metadata.primaryModel as string | undefined);
  if (modelClass !== undefined) metadata.modelClass = modelClass;
  const context = workContextOf(event.repoRef);
  return {
    toolInstallationId,
    source: STORE_SOURCE[event.store] as AscendaTelemetrySource,
    // Always a canonical catalog type. `eventKind` is typed against the
    // contract union and the epoch marker is filtered out upstream in
    // `shippableEvents`, so no cast is needed here — and an off-catalog name
    // cannot reach the wire to be silently bucketed as `unclassified`.
    eventType: event.eventKind,
    occurredAt: event.occurredAt,
    // The offset in force WHEN THE EVENT HAPPENED, not when the import ran.
    // A nine-month backfill crosses DST boundaries; stamping today's
    // offset on all of it would shift a whole season by an hour.
    utcOffsetMinutes: utcOffsetMinutesAt(new Date(event.occurredAt)),
    severity: "low",
    sessionId: event.sessionRef,
    workspaceHash: context?.workspaceHash ?? null,
    projectHash: context?.projectHash ?? null,
    // A real contract ToolConsentScope now, and a real gate: the backend
    // requires an active historical-import consent lease for anything carrying
    // one of the provenance classes below, and decides that on the provenance
    // rather than on this string — sending `ide_telemetry` here would not buy
    // the event a way in.
    consentScope: HISTORICAL_CONSENT_SCOPE,
    provenance: event.provenance,
    privacyMode: "metadata_only",
    metadata
  };
}

export interface ShipResult {
  sent: number;
  accepted: number;
  /**
   * Events the backend already held for this installation — a re-run over
   * source records it has seen before. Neither accepted nor rejected: nothing
   * was stored and nothing failed. Counted separately because the two wrong
   * answers are both actively misleading. Folding these into `accepted` would
   * tell someone their second run added another 8,720 events to their
   * baseline; folding them into `rejected` would tell them their import broke.
   */
  duplicate: number;
  rejected: number;
  /** reason -> count, from the batch response's per-item results. */
  rejectionReasons: Record<string, number>;
  httpFailures: number;
  /** Per-store outcome, so a caller can read "vscode shipped 0" instead of
   * inferring it from a total. See `attributionComplete`. */
  perStore: Record<string, StoreShipCounts>;
  /**
   * The run stopped because the backend refused a whole batch on consent
   * grounds — there is no lease for a retrospective import on this account, or
   * the scope this build sends is not one the server knows.
   *
   * Not a transport failure and not a per-event problem: it is the one refusal
   * that will not change while the run is in progress, so the shipper stops
   * instead of sending the rest. `sent` and `rejected` then describe only what
   * was tried before the stop, which is the point — a report of 28,158 refusals
   * and a report of 100 describe the same situation, and only one of them costs
   * a person their afternoon.
   */
  consentBlocked?: boolean;

  /**
   * False when at least one batch response could not be attributed back to
   * individual events — the response omitted `results`, or returned a
   * different number of them than we sent. The per-store `sent` figures are
   * still exact (we know what we put in each batch); the accepted/duplicate/
   * rejected splits for those batches are not, and are left OUT of `perStore`
   * rather than spread across stores by assumption. A caller that prints a
   * per-store table must say so when this is false.
   */
  attributionComplete: boolean;
}

export interface StoreShipCounts {
  sent: number;
  accepted: number;
  duplicate: number;
  rejected: number;
}

function storeCounts(result: ShipResult, store: string): StoreShipCounts {
  return (result.perStore[store] ??= { sent: 0, accepted: 0, duplicate: 0, rejected: 0 });
}

const BATCH_SIZE = 200;

/**
 * The events that belong on the wire: everything except the extraction epoch
 * marker, which is local bookkeeping about the read itself rather than an
 * observation of anyone's work (see `EXTRACTION_EPOCH_KIND`). Exported so the
 * CLI can report the same count it is about to send.
 */
export function shippableEvents(
  events: NormalizedHistoricalEvent[]
): (NormalizedHistoricalEvent & { eventKind: AscendaEventPayload["eventType"] })[] {
  return events.filter(
    (e): e is NormalizedHistoricalEvent & { eventKind: AscendaEventPayload["eventType"] } =>
      e.eventKind !== EXTRACTION_EPOCH_KIND
  );
}

export async function shipEvents(
  events: NormalizedHistoricalEvent[],
  config: ShipConfig,
  onProgress?: (done: number, total: number) => void
): Promise<ShipResult> {
  const result: ShipResult = {
    sent: 0,
    accepted: 0,
    duplicate: 0,
    rejected: 0,
    rejectionReasons: {},
    httpFailures: 0,
    perStore: {},
    attributionComplete: true
  };
  const wireEvents = shippableEvents(events);
  // Ordinals are assigned across the whole shipment before it is cut into
  // batches: an identity group split by a chunk boundary must still number
  // continuously, or the same record would key differently depending on
  // where the batching happened to fall.
  const ordinals = importOrdinals(wireEvents);
  for (let offset = 0; offset < wireEvents.length; offset += BATCH_SIZE) {
    const chunk = wireEvents.slice(offset, offset + BATCH_SIZE);
    const payloads = chunk.map((event, i) =>
      toWirePayload(event, ordinals[offset + i], config.toolInstallationId)
    );
    let response: Response;
    try {
      response = await fetch(`${config.apiBaseUrl}/v1/tool-events/batch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.eventWriteToken}`
        },
        body: JSON.stringify({ events: payloads })
      });
    } catch {
      result.httpFailures += 1;
      result.attributionComplete = false;
      continue; // Transport failure: skip this chunk, keep going — the stable
      // importKey makes a later re-run of just the gaps safe to reconcile.
    }
    result.sent += chunk.length;
    for (const event of chunk) storeCounts(result, event.store).sent += 1;
    if (!response.ok) {
      result.httpFailures += 1;
      result.attributionComplete = false;
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Ingest refused (${response.status}) — token invalid/revoked or consent missing; aborting rather than burning ${wireEvents.length - offset} more events`
        );
      }
      continue;
    }
    try {
      const body = (await response.json()) as {
        accepted?: number;
        duplicate?: number;
        rejected?: number;
        results?: { status?: string; reason?: string }[];
      };
      result.accepted += body.accepted ?? 0;
      result.duplicate += body.duplicate ?? 0;
      result.rejected += body.rejected ?? 0;
      const items = body.results ?? [];
      // Per-item results are positional against the batch we sent. Only
      // attribute when the response returns exactly as many as we sent —
      // anything else and the mapping is a guess, and a guessed per-store
      // table is worse than an absent one.
      const attributable = items.length === chunk.length;
      if (!attributable && (body.accepted ?? body.duplicate ?? body.rejected) !== undefined) {
        result.attributionComplete = false;
      }
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (attributable) {
          const counts = storeCounts(result, chunk[i].store);
          if (item.status === "accepted") counts.accepted += 1;
          else if (item.status === "duplicate") counts.duplicate += 1;
          else counts.rejected += 1;
        }
        // Duplicates have their own counter; bucketing them as rejection
        // reasons too would report the same events twice under two headings.
        if (item.status !== "accepted" && item.status !== "duplicate") {
          const reason = item.reason ?? "unknown";
          result.rejectionReasons[reason] = (result.rejectionReasons[reason] ?? 0) + 1;
        }
      }

      // **Stop on a wall, rather than walking into it 28,158 times.**
      //
      // The abort above only catches a 401/403, and the batch door does not
      // answer with either: a missing consent lease is a 200 whose every item
      // is `rejected: consent_missing_or_expired`. So on 25 Aug 2026 a real run
      // sent every event it had, one full batch at a time, and reported
      // `accepted=0 rejected=28158` at the end — the right refusal discovered
      // in the most expensive possible order.
      //
      // A consent lease does not appear halfway through a run: the person is in
      // a terminal, not a consent screen. So if a whole batch came back refused
      // for the lease, every remaining batch will be too, and continuing only
      // costs time and writes audit rows for a decision already made.
      //
      // Keyed on the *whole* batch, not on any single item, and only on the
      // consent reasons — a mixed batch is a per-event problem (an off-catalog
      // type, a missing importKey) and must keep going so the events that are
      // fine still land.
      if (items.length === chunk.length && items.length > 0) {
        const blocked = items.every(
          (item) =>
            item.status !== "accepted" &&
            item.status !== "duplicate" &&
            (item.reason === "consent_missing_or_expired" ||
              item.reason === "unknown_consent_scope")
        );
        if (blocked) {
          result.consentBlocked = true;
          result.attributionComplete = false;
          onProgress?.(Math.min(offset + BATCH_SIZE, wireEvents.length), wireEvents.length);
          return result;
        }
      }
    } catch {
      result.httpFailures += 1;
      result.attributionComplete = false;
    }
    onProgress?.(Math.min(offset + BATCH_SIZE, wireEvents.length), wireEvents.length);
  }
  return result;
}
