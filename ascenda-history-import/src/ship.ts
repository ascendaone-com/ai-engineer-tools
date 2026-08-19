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
 *   re-run of the same store. Since 19 Aug 2026 this is what the backend
 *   dedups on: `(pairedUser, toolInstallation, importKey)` is unique, a
 *   replayed event is reported as `duplicate` and writes nothing, and the
 *   key is *required* on anything carrying a historical provenance. Note it
 *   dedups on this key alone, NOT on `(extractionId, importKey)` — an
 *   extraction id is fresh per run, so including it would dedup nothing.
 *
 *   The one soft spot is `ordinal`: it is the event's index in the whole
 *   shipped array, so if a later run extracts a different *set* — Claude
 *   Code's 30-day purge having eaten the oldest days, say — the ordinals
 *   shift and the same source record hashes differently. Re-running over a
 *   shrunken store can therefore still double the overlap. Fixing that means
 *   a per-(store, session) ordinal here, not a backend change.
 * - **Raw local refs are hashed at the wire, not before.** The normalized
 *   file in staging keeps the real cwd (local, never leaves the machine);
 *   `workspaceHash`/`projectHash` go out as the same machine-salted 16-hex
 *   hashes the live hooks send, so historical and live events for the same
 *   repo correlate server-side without the server ever learning the path.
 */
import { createHash } from "node:crypto";
import { hashWithMachineSalt, readTokenFile, defaultTokenFilePath } from "@ascenda-one/tool-kit";
import type { AscendaEventPayload, AscendaTelemetrySource } from "@ascenda-one/tool-contract";
import {
  EXTRACTION_EPOCH_KIND,
  HISTORICAL_CONSENT_SCOPE,
  NormalizedHistoricalEvent,
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

export function importKeyOf(event: NormalizedHistoricalEvent, ordinal: number): string {
  return createHash("sha256")
    .update(
      [event.store, event.sessionRef ?? "", event.eventKind, event.occurredAt, String(ordinal)].join(
        "|"
      )
    )
    .digest("hex")
    .slice(0, 16);
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
  for (const [key, value] of Object.entries(event.metrics)) {
    metadata[key] = value;
  }
  // gitBranch is a metric locally but a name on the wire — hash it like the
  // repo path. Branch names leak project vocabulary ("feature/acme-migration").
  if (typeof metadata.gitBranch === "string") {
    metadata.gitBranchHash = hashWithMachineSalt(metadata.gitBranch) ?? "";
    delete metadata.gitBranch;
  }
  const workspaceHash = event.repoRef ? hashWithMachineSalt(event.repoRef) : null;
  return {
    toolInstallationId,
    source: STORE_SOURCE[event.store] as AscendaTelemetrySource,
    // Always a canonical catalog type. `eventKind` is typed against the
    // contract union and the epoch marker is filtered out upstream in
    // `shippableEvents`, so no cast is needed here — and an off-catalog name
    // cannot reach the wire to be silently bucketed as `unclassified`.
    eventType: event.eventKind,
    occurredAt: event.occurredAt,
    severity: "low",
    sessionId: event.sessionRef,
    workspaceHash,
    projectHash: workspaceHash,
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
    httpFailures: 0
  };
  const wireEvents = shippableEvents(events);
  for (let offset = 0; offset < wireEvents.length; offset += BATCH_SIZE) {
    const chunk = wireEvents.slice(offset, offset + BATCH_SIZE);
    const payloads = chunk.map((event, i) => toWirePayload(event, offset + i, config.toolInstallationId));
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
      continue; // Transport failure: skip this chunk, keep going — the stable
      // importKey makes a later re-run of just the gaps safe to reconcile.
    }
    result.sent += chunk.length;
    if (!response.ok) {
      result.httpFailures += 1;
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
      for (const item of body.results ?? []) {
        // Duplicates have their own counter; bucketing them as rejection
        // reasons too would report the same events twice under two headings.
        if (item.status !== "accepted" && item.status !== "duplicate") {
          const reason = item.reason ?? "unknown";
          result.rejectionReasons[reason] = (result.rejectionReasons[reason] ?? 0) + 1;
        }
      }
    } catch {
      result.httpFailures += 1;
    }
    onProgress?.(Math.min(offset + BATCH_SIZE, wireEvents.length), wireEvents.length);
  }
  return result;
}
