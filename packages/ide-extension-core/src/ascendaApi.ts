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

  // The transport now returns the status and error code alongside the verdict.
  // This surface keeps returning the bare verdict because the extension holds
  // its own token in the editor's SecretStorage and reports through the editor
  // UI, not the file journal — nothing here consumes the extra fields yet.
  //
  // A replay the server answers `status: "duplicate"` (single door) or
  // per-item `status: "duplicate"` (batch door) arrives here as `accepted`:
  // the transport collapses the two on purpose, because for the queue in
  // TelemetryService they are the same verdict — the event is on the server,
  // evict it. Nothing here may re-split them: a `duplicate` that reached
  // `flush()` as anything but `accepted` would be unshifted back onto the
  // queue and re-sent on every flush for the life of the process.
  async sendEvent(payload: AscendaEventPayload, eventWriteToken: string): Promise<IngestResult> {
    return this.logging([payload], async () => (await postToolEvent(AscendaConfig.apiBaseUrl, eventWriteToken, payload)).result);
  }

  async sendEventsBatch(payloads: AscendaEventPayload[], eventWriteToken: string): Promise<IngestResult> {
    return this.logging(payloads, async () => (await postToolEventsBatch(AscendaConfig.apiBaseUrl, eventWriteToken, payloads)).result);
  }

  /**
   * Mirror to the opt-in local log (ASCENDA_EVENT_LOG_FILE, or the
   * ascenda.eventLogFile setting). The extension batches, so one HTTP result
   * covers several payloads — each gets its own line carrying that shared
   * result. An unreachable backend is logged too: that is when reading the log
   * is most useful — and it now arrives as `transport_error` rather than as a
   * thrown error caught by the `other` default, because the transport returns
   * that outcome instead of throwing.
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
