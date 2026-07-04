import {
  AscendaEventPayload,
  PairingSessionResponse,
  PairingStatusResponse,
  RenewToolTokenResponse,
  ASCENDA_TOOL_TYPE
} from "./types";
import { AscendaConfig } from "./config";

export type IngestResult = "accepted" | "auth_failed" | "consent_missing" | "validation_failed" | "other";

export class AscendaApiError extends Error {
  constructor(readonly status: number, readonly errorCode?: string, body?: string) {
    super(body ?? `Ascenda API error ${status}`);
    this.name = "AscendaApiError";
  }
}

export class AscendaApi {
  async createPairingSession(toolInstallationId: string, displayName: string): Promise<PairingSessionResponse> {
    const response = await fetch(`${AscendaConfig.apiBaseUrl}/v1/tool-pairing-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolInstallationId, toolType: ASCENDA_TOOL_TYPE, displayName })
    });
    if (!response.ok) throw new AscendaApiError(response.status, undefined, await response.text());
    return (await response.json()) as PairingSessionResponse;
  }

  async getPairingStatus(pairingSessionId: string): Promise<PairingStatusResponse> {
    const response = await fetch(`${AscendaConfig.apiBaseUrl}/v1/tool-pairing-sessions/${encodeURIComponent(pairingSessionId)}/status`, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new AscendaApiError(response.status, undefined, await response.text());
    return (await response.json()) as PairingStatusResponse;
  }

  /** Tool-scoped renew — Bearer eventWriteToken, no user JWT. */
  async renewEventToken(eventWriteToken: string): Promise<RenewToolTokenResponse | null> {
    const response = await fetch(`${AscendaConfig.apiBaseUrl}/v1/tool-events/renew-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${eventWriteToken}` }
    });
    if (response.status === 401) return null;
    if (!response.ok) throw new AscendaApiError(response.status, undefined, await response.text());
    return (await response.json()) as RenewToolTokenResponse;
  }

  async sendEvent(payload: AscendaEventPayload, eventWriteToken: string): Promise<IngestResult> {
    const response = await fetch(`${AscendaConfig.apiBaseUrl}/v1/tool-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${eventWriteToken}` },
      body: JSON.stringify(payload)
    });
    return this.parseIngestResponse(response);
  }

  async sendEventsBatch(payloads: AscendaEventPayload[], eventWriteToken: string): Promise<IngestResult> {
    const response = await fetch(`${AscendaConfig.apiBaseUrl}/v1/tool-events/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${eventWriteToken}` },
      body: JSON.stringify({ events: payloads })
    });
    return this.parseIngestResponse(response);
  }

  private async parseIngestResponse(response: Response): Promise<IngestResult> {
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
}
