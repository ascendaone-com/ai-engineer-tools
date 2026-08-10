import {
  AscendaEventPayload,
  IngestResult,
  PairingSessionResponse,
  PairingStatusResponse,
  RenewToolTokenResponse
} from "@ascenda-one/tool-contract";
import {
  appendEventLog,
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

  async sendEvent(payload: AscendaEventPayload, eventWriteToken: string): Promise<IngestResult> {
    return this.logging([payload], () => postToolEvent(AscendaConfig.apiBaseUrl, eventWriteToken, payload));
  }

  async sendEventsBatch(payloads: AscendaEventPayload[], eventWriteToken: string): Promise<IngestResult> {
    return this.logging(payloads, () => postToolEventsBatch(AscendaConfig.apiBaseUrl, eventWriteToken, payloads));
  }

  /**
   * Mirror to the opt-in local log (ASCENDA_EVENT_LOG_FILE, or the
   * ascenda.eventLogFile setting). The extension batches, so one HTTP result
   * covers several payloads — each gets its own line carrying that shared
   * result. An unreachable backend is logged too: that is when reading the log
   * is most useful.
   */
  private async logging(payloads: AscendaEventPayload[], send: () => Promise<IngestResult>): Promise<IngestResult> {
    const logFile = AscendaConfig.eventLogFile;
    if (!logFile) return send();

    let delivery: IngestResult = "other";
    try {
      delivery = await send();
      return delivery;
    } finally {
      const loggedAt = new Date().toISOString();
      for (const payload of payloads) appendEventLog(logFile, { loggedAt, delivery, payload });
    }
  }
}
