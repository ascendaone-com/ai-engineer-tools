import { persistEventWriteToken, postToolEvent, renewToolToken } from "@ascenda-one/tool-kit";
import {
  ASCENDA_CONSENT_SCOPE,
  ASCENDA_PROVENANCE,
  AscendaEventPayload,
  IngestResult,
  MappedAscendaEvent
} from "./types.js";
import { AscendaHookConfig } from "./config.js";

export { AscendaApiError as AscendaClientError } from "@ascenda-one/tool-kit";

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

    let result = await postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload);
    if (result === "auth_failed") {
      const renewed = await this.renewEventToken();
      if (!renewed) return "auth_failed";
      result = await postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload);
    }
    return result;
  }

  async renewEventToken(): Promise<boolean> {
    const renewed = await renewToolToken(this.config.apiBaseUrl, this.eventWriteToken);
    if (!renewed) return false;
    this.eventWriteToken = renewed.eventWriteToken;
    persistEventWriteToken(this.config.tokenFilePath, renewed.eventWriteToken);
    return true;
  }
}
