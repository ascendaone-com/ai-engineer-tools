import {
  ASCENDA_CONSENT_SCOPE,
  ASCENDA_PROVENANCE,
  AscendaEventMetadata,
  AscendaEventPayload,
  AscendaSeverity,
  AscendaTelemetryEventType,
  AscendaTelemetrySource,
  IngestResult
} from "@ascenda-one/tool-contract";
import { postToolEvent, renewToolToken } from "./http";
import { persistEventWriteToken } from "./tokenStore";

export type MappedEvent = {
  eventType: AscendaTelemetryEventType;
  severity: AscendaSeverity;
  metadata?: AscendaEventMetadata;
};

export type EventSenderConfig = {
  apiBaseUrl: string;
  toolInstallationId: string;
  source: AscendaTelemetrySource;
  eventWriteToken: string;
  tokenFilePath: string;
  sessionId?: string | null;
  workspaceHash?: string | null;
  /** Hard cap per HTTP call. Hook-path telemetry must fail fast, never stall the agent. */
  timeoutMs?: number;
};

/**
 * Shared one-shot event sender for agent hook adapters (Claude Code, Codex).
 * Sends metadata-only events with the standard consent scope and provenance,
 * renews the event write token once on auth failure, and persists rotations.
 */
export class AscendaEventSender {
  private eventWriteToken: string;

  constructor(private readonly config: EventSenderConfig) {
    this.eventWriteToken = config.eventWriteToken;
  }

  async send(mapped: MappedEvent): Promise<IngestResult> {
    const payload: AscendaEventPayload = {
      toolInstallationId: this.config.toolInstallationId,
      source: this.config.source,
      occurredAt: new Date().toISOString(),
      sessionId: this.config.sessionId ?? undefined,
      workspaceHash: this.config.workspaceHash ?? undefined,
      consentScope: ASCENDA_CONSENT_SCOPE,
      provenance: ASCENDA_PROVENANCE,
      privacyMode: "metadata_only",
      ...mapped,
      metadata: mapped.metadata ?? {}
    };

    let result = await postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload, this.signal());
    if (result === "auth_failed") {
      const renewed = await this.renewEventToken();
      if (!renewed) return "auth_failed";
      result = await postToolEvent(this.config.apiBaseUrl, this.eventWriteToken, payload, this.signal());
    }
    return result;
  }

  async renewEventToken(): Promise<boolean> {
    const renewed = await renewToolToken(this.config.apiBaseUrl, this.eventWriteToken, this.signal());
    if (!renewed) return false;
    this.eventWriteToken = renewed.eventWriteToken;
    persistEventWriteToken(this.config.tokenFilePath, renewed.eventWriteToken);
    return true;
  }

  private signal(): AbortSignal | undefined {
    return this.config.timeoutMs ? AbortSignal.timeout(this.config.timeoutMs) : undefined;
  }
}
