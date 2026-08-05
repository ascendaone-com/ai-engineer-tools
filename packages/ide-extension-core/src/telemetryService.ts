import * as crypto from "crypto";
import * as vscode from "vscode";
import { AscendaApi, IngestResult } from "./ascendaApi";
import { AscendaConfig } from "./config";
import { getHostDisplayName, resolveTelemetrySource } from "./host";
import { PairingService } from "./pairingService";
import {
  ASCENDA_CONSENT_SCOPE,
  ASCENDA_PROVENANCE,
  AscendaEventMetadata,
  AscendaEventPayload,
  AscendaSeverity,
  AscendaTelemetryEventType
} from "@ascenda-one/tool-contract";
import { isAfterHours } from "@ascenda-one/tool-kit";
import { getWorkspaceHash } from "./privacy";

export class TelemetryService implements vscode.Disposable {
  private readonly queue: AscendaEventPayload[] = [];
  private readonly sessionId = `sess_${crypto.randomUUID()}`;
  private readonly disposables: vscode.Disposable[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private flushing = false;
  private consentWarningShown = false;

  constructor(private readonly api: AscendaApi, private readonly pairingService: PairingService) {}

  start(): void {
    const intervalMs = Math.max(5, AscendaConfig.flushIntervalSeconds) * 1000;
    this.flushTimer = setInterval(() => void this.flush(), intervalMs);
    this.track("create_focus_session", "low", { activity: "session_started" });
  }

  async stop(): Promise<void> {
    this.track("recovery_offline_period", "low", { activity: "session_ended" });
    await this.flush();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  dispose(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  track(eventType: AscendaTelemetryEventType, severity: AscendaSeverity = "low", metadata: AscendaEventMetadata = {}): void {
    if (!AscendaConfig.telemetryEnabled) return;
    const toolInstallationId = this.pairingService.getToolInstallationId();
    if (!toolInstallationId) return;
    const afterHours = isAfterHours(new Date(), AscendaConfig.afterHoursStart, AscendaConfig.afterHoursEnd);
    const payload = this.buildPayload(toolInstallationId, eventType, severity, { ...metadata, afterHours });
    this.queue.push(payload);
    if (afterHours && eventType !== "after_hours_ai_session") {
      this.queue.push(this.buildPayload(toolInstallationId, "after_hours_ai_session", severity === "low" ? "medium" : severity, {
        reason: "after_hours",
        relatedEventType: eventType,
        afterHours: true
      }));
    }
    if (this.queue.length >= 10) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    if (!this.pairingService.isPaired()) return;
    let token = await this.pairingService.ensureEventWriteToken();
    if (!token) return;

    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, Math.min(10, this.queue.length));
        let result: IngestResult;
        try {
          result = batch.length === 1
            ? await this.api.sendEvent(batch[0], token)
            : await this.api.sendEventsBatch(batch, token);

          if (result === "auth_failed") {
            token = await this.pairingService.handleAuthFailure();
            if (!token) {
              this.queue.unshift(...batch);
              break;
            }
            result = batch.length === 1
              ? await this.api.sendEvent(batch[0], token)
              : await this.api.sendEventsBatch(batch, token);
          }
        } catch (error) {
          // 5xx and network failures throw rather than returning an IngestResult;
          // keep the batch for the next flush instead of dropping it.
          this.queue.unshift(...batch);
          throw error;
        }

        if (result === "consent_missing") {
          this.queue.unshift(...batch);
          if (!this.consentWarningShown) {
            this.consentWarningShown = true;
            vscode.window.showWarningMessage("Ascenda telemetry paused. Renew IDE telemetry consent in the Ascenda app.");
          }
          break;
        }

        if (result !== "accepted") {
          this.queue.unshift(...batch);
          console.error("Ascenda telemetry ingest failed", result);
          break;
        }
      }
    } catch (error) {
      console.error("Ascenda telemetry flush failed", error);
    } finally {
      this.flushing = false;
    }
  }

  private buildPayload(
    toolInstallationId: string,
    eventType: AscendaTelemetryEventType,
    severity: AscendaSeverity,
    metadata: AscendaEventMetadata
  ): AscendaEventPayload {
    return {
      toolInstallationId,
      source: resolveTelemetrySource(toolInstallationId),
      eventType,
      occurredAt: new Date().toISOString(),
      severity,
      sessionId: this.sessionId,
      workspaceHash: getWorkspaceHash(),
      consentScope: ASCENDA_CONSENT_SCOPE,
      provenance: ASCENDA_PROVENANCE,
      privacyMode: "metadata_only",
      // Forks share the vscode_extension source, so without this an
      // agent-first IDE is indistinguishable from stock VS Code in the data.
      // Caller-supplied metadata wins: it is the more specific claim.
      metadata: { host: getHostDisplayName(), ...metadata }
    };
  }
}
