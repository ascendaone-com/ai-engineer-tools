import {
  AscendaEventPayload,
  IngestResult,
  PairingSessionResponse,
  PairingStatusResponse,
  RenewToolTokenResponse
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
};

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

export async function parseIngestResponse(response: Response): Promise<IngestOutcome> {
  if (response.ok) return { result: "accepted", httpStatus: response.status };
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
