import {
  AscendaEventPayload,
  IngestResult,
  PairingSessionResponse,
  PairingStatusResponse,
  RenewToolTokenResponse,
  TOOL_EVENT_DELIVERED_STATUSES,
  ToolEventDeliveredStatus
} from "@ascenda-one/tool-contract";

export class AscendaApiError extends Error {
  constructor(readonly status: number, readonly errorCode?: string, body?: string) {
    super(body ?? `Ascenda API error ${status}`);
    this.name = "AscendaApiError";
  }
}

/** Tool-side (anonymous): create a pairing session. */
export async function createPairingSession(apiBaseUrl: string, toolInstallationId: string, toolType: string, displayName: string): Promise<PairingSessionResponse> {
  const response = await fetch(`${apiBaseUrl}/v1/tool-pairing-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolInstallationId, toolType, displayName })
  });
  if (!response.ok) throw new AscendaApiError(response.status, undefined, await response.text());
  return (await response.json()) as PairingSessionResponse;
}

/** Tool-side (anonymous): poll pairing status. */
export async function getPairingStatus(apiBaseUrl: string, pairingSessionId: string): Promise<PairingStatusResponse> {
  const response = await fetch(`${apiBaseUrl}/v1/tool-pairing-sessions/${encodeURIComponent(pairingSessionId)}/status`, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new AscendaApiError(response.status, undefined, await response.text());
  return (await response.json()) as PairingStatusResponse;
}

/** Tool-scoped renew — Bearer eventWriteToken, no user JWT. Returns null on 401 (re-pair required). */
export async function renewToolToken(apiBaseUrl: string, eventWriteToken: string, signal?: AbortSignal): Promise<RenewToolTokenResponse | null> {
  const response = await fetch(`${apiBaseUrl}/v1/tool-events/renew-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${eventWriteToken}` },
    signal
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new AscendaApiError(response.status, undefined, await response.text());
  return (await response.json()) as RenewToolTokenResponse;
}

/**
 * A verdict plus the evidence for it. The status and error code are carried
 * out rather than folded into the result because the journal and `doctor` both
 * need to say *why*, and "auth_failed" alone sends someone re-pairing a tool
 * whose token was fine.
 */
export type IngestOutcome = {
  result: IngestResult;
  httpStatus?: number;
  errorCode?: string;
  detail?: string;
  /**
   * How many of the request's events the server answered `duplicate` — a
   * replay it matched on `idempotencyKey` (or `importKey`) and wrote nothing
   * for. Present only on an `accepted` result, and only when non-zero.
   * Informational: a duplicate IS accepted for every decision a caller makes
   * (evict, journal as healthy, do not retry). It is surfaced so a person
   * reading a log can tell a drained backlog from first delivery, never so a
   * caller can branch on it.
   */
  duplicates?: number;
  /**
   * The batch door's per-item verdicts, positional against the events sent,
   * when the 2xx body carried them. An outbox drain reads these to decide
   * which entries the server now holds (`accepted` or `duplicate` — delete)
   * and which it refused with a verdict (`rejected` — replaying cannot change
   * the answer). Absent on the single door and on a body without `results`.
   */
  results?: IngestBatchItemResult[];
};

export type IngestBatchItemResult = {
  index: number;
  status: string;
  reason?: string;
};

/**
 * `status` words the ingest doors use for an event that is on the server.
 * Anything else on a 2xx (an empty body, a proxy's HTML, a future word) is
 * still a 2xx: the request got a success verdict, and that verdict is what
 * the caller acts on.
 */
function isDeliveredStatus(value: unknown): value is ToolEventDeliveredStatus {
  return typeof value === "string" && (TOOL_EVENT_DELIVERED_STATUSES as readonly string[]).includes(value);
}

/**
 * Reads the success body of either door, branching on `status` only — never
 * on `reason`, which exists for a human reading their own logs
 * (`already_delivered` vs `already_imported`) and is not a contract for
 * clients. Returns the number of events the server called `duplicate`.
 */
function readSuccessBody(body: string): { duplicates: number; results?: IngestBatchItemResult[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { duplicates: 0 };
  }
  if (!parsed || typeof parsed !== "object") return { duplicates: 0 };
  const single = (parsed as { status?: unknown }).status;
  if (isDeliveredStatus(single)) return { duplicates: single === "duplicate" ? 1 : 0 };
  const raw = (parsed as { results?: unknown }).results;
  if (!Array.isArray(raw)) return { duplicates: 0 };
  const results: IngestBatchItemResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { index, status, reason } = item as { index?: unknown; status?: unknown; reason?: unknown };
    if (typeof index !== "number" || typeof status !== "string") continue;
    results.push({ index, status, ...(typeof reason === "string" ? { reason } : {}) });
  }
  return { duplicates: results.filter((item) => item.status === "duplicate").length, results };
}

/** Statuses worth a second attempt: the request never got a real verdict. */
export function isRetryableStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

export async function postToolEvent(apiBaseUrl: string, eventWriteToken: string, payload: AscendaEventPayload, signal?: AbortSignal): Promise<IngestOutcome> {
  return sendIngest(`${apiBaseUrl}/v1/tool-events`, eventWriteToken, JSON.stringify(payload), signal);
}

export async function postToolEventsBatch(apiBaseUrl: string, eventWriteToken: string, payloads: AscendaEventPayload[], signal?: AbortSignal): Promise<IngestOutcome> {
  return sendIngest(`${apiBaseUrl}/v1/tool-events/batch`, eventWriteToken, JSON.stringify({ events: payloads }), signal);
}

/**
 * Never throws. A network failure, a DNS failure and a timeout are all
 * `transport_error` with the cause in `detail` — the caller records it and
 * moves on, because on the hook path an exception is just silence with extra
 * steps.
 */
async function sendIngest(url: string, eventWriteToken: string, body: string, signal?: AbortSignal): Promise<IngestOutcome> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${eventWriteToken}` },
      body,
      signal
    });
    return parseIngestResponse(response);
  } catch (error) {
    return {
      result: "transport_error",
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    };
  }
}

/**
 * A 2xx is `accepted` whatever the body says. That includes a replay the
 * server answered `status: "duplicate"` — on the single door as the whole
 * response, on the batch door per item with `reason: "already_delivered"`.
 * A duplicate is a success with nothing to do: the event is on the server,
 * it must be evicted from any queue exactly as an accepted one is, it must
 * not be retried (the backlog would be immortal), and it must not be
 * journalled as a failure. It is counted, not distinguished, so the one
 * `result` every caller already branches on keeps meaning "delivered".
 */
export async function parseIngestResponse(response: Response): Promise<IngestOutcome> {
  if (response.ok) {
    const outcome: IngestOutcome = { result: "accepted", httpStatus: response.status };
    let read: { duplicates: number; results?: IngestBatchItemResult[] } = { duplicates: 0 };
    try {
      read = readSuccessBody(await response.text());
    } catch {
      read = { duplicates: 0 };
    }
    return {
      ...outcome,
      ...(read.duplicates > 0 ? { duplicates: read.duplicates } : {}),
      ...(read.results !== undefined ? { results: read.results } : {})
    };
  }
  const body = await response.text();
  let errorCode: string | undefined;
  try {
    errorCode = (JSON.parse(body) as { error?: string }).error;
  } catch {
    errorCode = undefined;
  }
  const base = { httpStatus: response.status, errorCode, detail: body || undefined };
  if (response.status === 401) return { ...base, result: "auth_failed" };
  if (response.status === 403 && errorCode === "consent_missing_or_expired") return { ...base, result: "consent_missing" };
  if (response.status === 400 || response.status === 422) return { ...base, result: "validation_failed" };
  // Everything else — 429, 5xx, a proxy's 502 — used to throw here, which on
  // the hook path meant the event vanished with no record and no retry.
  return { ...base, result: "transport_error" };
}
