import {
  AscendaEventPayload,
  IngestResult,
  PairingSessionResponse,
  PairingStatusResponse,
  RenewToolTokenResponse
} from "./types";
import {
  createPairingSession,
  getPairingStatus,
  postToolEvent,
  postToolEventsBatch,
  renewToolToken
} from "@ascenda/tool-kit";
import { AscendaConfig } from "./config";

export type { IngestResult };
export { AscendaApiError } from "@ascenda/tool-kit";

export class AscendaApi {
  async createPairingSession(toolInstallationId: string, toolType: string, displayName: string): Promise<PairingSessionResponse> {
    return createPairingSession(AscendaConfig.apiBaseUrl, toolInstallationId, toolType, displayName);
  }

  async getPairingStatus(pairingSessionId: string): Promise<PairingStatusResponse> {
    return getPairingStatus(AscendaConfig.apiBaseUrl, pairingSessionId);
  }

  /** Tool-scoped renew — Bearer eventWriteToken, no user JWT. */
  async renewEventToken(eventWriteToken: string): Promise<RenewToolTokenResponse | null> {
    return renewToolToken(AscendaConfig.apiBaseUrl, eventWriteToken);
  }

  async sendEvent(payload: AscendaEventPayload, eventWriteToken: string): Promise<IngestResult> {
    return postToolEvent(AscendaConfig.apiBaseUrl, eventWriteToken, payload);
  }

  async sendEventsBatch(payloads: AscendaEventPayload[], eventWriteToken: string): Promise<IngestResult> {
    return postToolEventsBatch(AscendaConfig.apiBaseUrl, eventWriteToken, payloads);
  }
}
