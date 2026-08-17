import {
  AscendaEventPayload,
  IngestResult,
  PairingSessionResponse,
  PairingStatusResponse,
  RenewToolTokenResponse
} from "@ascenda-one/tool-contract";
import {
  createPairingSession,
  getPairingStatus,
  postToolEvent,
  postToolEventsBatch,
  renewToolToken
} from "@ascenda-one/tool-kit";
import { AscendaConfig } from "./config";

export type { IngestResult };
export { AscendaApiError } from "@ascenda-one/tool-kit";

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

  // The transport now returns the status and error code alongside the verdict.
  // This surface keeps returning the bare verdict because the extension holds
  // its own token in the editor's SecretStorage and reports through the editor
  // UI, not the file journal — nothing here consumes the extra fields yet.
  async sendEvent(payload: AscendaEventPayload, eventWriteToken: string): Promise<IngestResult> {
    return (await postToolEvent(AscendaConfig.apiBaseUrl, eventWriteToken, payload)).result;
  }

  async sendEventsBatch(payloads: AscendaEventPayload[], eventWriteToken: string): Promise<IngestResult> {
    return (await postToolEventsBatch(AscendaConfig.apiBaseUrl, eventWriteToken, payloads)).result;
  }
}
