import {
  AscendaEventPayload,
  IngestResult,
  PairingSessionResponse,
  PairingStatusResponse,
  RenewToolTokenResponse
} from "@ascenda/tool-contract";

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
export async function renewToolToken(apiBaseUrl: string, eventWriteToken: string): Promise<RenewToolTokenResponse | null> {
  const response = await fetch(`${apiBaseUrl}/v1/tool-events/renew-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${eventWriteToken}` }
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new AscendaApiError(response.status, undefined, await response.text());
  return (await response.json()) as RenewToolTokenResponse;
}

export async function postToolEvent(apiBaseUrl: string, eventWriteToken: string, payload: AscendaEventPayload): Promise<IngestResult> {
  const response = await fetch(`${apiBaseUrl}/v1/tool-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${eventWriteToken}` },
    body: JSON.stringify(payload)
  });
  return parseIngestResponse(response);
}

export async function postToolEventsBatch(apiBaseUrl: string, eventWriteToken: string, payloads: AscendaEventPayload[]): Promise<IngestResult> {
  const response = await fetch(`${apiBaseUrl}/v1/tool-events/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${eventWriteToken}` },
    body: JSON.stringify({ events: payloads })
  });
  return parseIngestResponse(response);
}

export async function parseIngestResponse(response: Response): Promise<IngestResult> {
  if (response.ok) return "accepted";
  const body = await response.text();
  let errorCode: string | undefined;
  try {
    errorCode = (JSON.parse(body) as { error?: string }).error;
  } catch {
    errorCode = undefined;
  }
  if (response.status === 401) return "auth_failed";
  if (response.status === 403 && errorCode === "consent_missing_or_expired") return "consent_missing";
  if (response.status === 400 || response.status === 422) return "validation_failed";
  throw new AscendaApiError(response.status, errorCode, body);
}
