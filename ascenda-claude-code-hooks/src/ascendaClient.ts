import {
  ASCENDA_CONSENT_SCOPE,
  ASCENDA_PROVENANCE,
  AscendaEventPayload,
  IngestResult,
  MappedAscendaEvent,
  RenewToolTokenResponse
} from "./types.js";
import { AscendaHookConfig, persistEventWriteToken } from "./config.js";

export class AscendaClientError extends Error {
  constructor(readonly status: number, readonly errorCode?: string, body?: string) {
    super(body ?? `Ascenda telemetry failed: ${status}`);
    this.name = "AscendaClientError";
  }
}

export class AscendaClient {
  private eventWriteToken: string;

  constructor(private readonly config: AscendaHookConfig) {
    this.eventWriteToken = config.eventWriteToken;
  }

  async send(mapped: MappedAscendaEvent): Promise<IngestResult> {
    const payload: AscendaEventPayload = {
      toolInstallationId: this.config.toolInstallationId,
      source: "claude_code",
      occurredAt: new Date().toISOString(),
      sessionId: this.config.sessionId ?? undefined,
      workspaceHash: this.config.workspaceHash ?? undefined,
      consentScope: ASCENDA_CONSENT_SCOPE,
      provenance: ASCENDA_PROVENANCE,
      privacyMode: "metadata_only",
      ...mapped,
      metadata: mapped.metadata ?? {}
    };

    let result = await this.postEvent(payload, this.eventWriteToken);
    if (result === "auth_failed") {
      const renewed = await this.renewEventToken();
      if (!renewed) return "auth_failed";
      result = await this.postEvent(payload, this.eventWriteToken);
    }
    return result;
  }

  async renewEventToken(): Promise<boolean> {
    const response = await fetch(`${this.config.apiBaseUrl}/v1/tool-events/renew-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.eventWriteToken}`
      }
    });
    if (response.status === 401) return false;
    if (!response.ok) throw new AscendaClientError(response.status, undefined, await response.text());
    const body = (await response.json()) as RenewToolTokenResponse;
    this.eventWriteToken = body.eventWriteToken;
    persistEventWriteToken(this.config.tokenFilePath, body.eventWriteToken);
    return true;
  }

  private async postEvent(payload: AscendaEventPayload, eventWriteToken: string): Promise<IngestResult> {
    const response = await fetch(`${this.config.apiBaseUrl}/v1/tool-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${eventWriteToken}`
      },
      body: JSON.stringify(payload)
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
    throw new AscendaClientError(response.status, errorCode, body);
  }
}
