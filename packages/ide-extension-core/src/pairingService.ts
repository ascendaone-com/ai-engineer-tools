import * as crypto from "crypto";
import * as os from "os";
import * as vscode from "vscode";
import { AscendaApi } from "./ascendaApi";
import { getHostDisplayName, getToolType } from "./host";
import { PairingPanel } from "./pairingPanel";

export // Renew this long before token expiry (client policy, not wire contract).
const TOKEN_RENEW_LEAD_MS = 3 * 24 * 60 * 60 * 1000;
const TOOL_INSTALLATION_ID_KEY = "ascenda.toolInstallationId";
export const PAIRING_SESSION_ID_KEY = "ascenda.pairingSessionId";
export const PAIRED_KEY = "ascenda.paired";
export const EVENT_WRITE_TOKEN_KEY = "ascenda.eventWriteToken";
export const EVENT_TOKEN_EXPIRES_AT_KEY = "ascenda.eventTokenExpiresAt";

export class PairingService {
  private readonly pairedListeners: Array<() => void> = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly api: AscendaApi) {}

  /** Fires once a pairing completes with credentials in hand — the moment a queue that failed on auth can try again. */
  onPaired(listener: () => void): vscode.Disposable {
    this.pairedListeners.push(listener);
    return {
      dispose: () => {
        const index = this.pairedListeners.indexOf(listener);
        if (index >= 0) this.pairedListeners.splice(index, 1);
      }
    };
  }

  async connect(): Promise<void> {
    const toolInstallationId = await this.getOrCreateToolInstallationId();
    const toolType = getToolType();
    const pairing = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Creating Ascenda pairing session...", cancellable: false },
      async () => this.api.createPairingSession(toolInstallationId, toolType, this.getDisplayName())
    );
    await this.context.globalState.update(PAIRING_SESSION_ID_KEY, pairing.pairingSessionId);
    const panel = PairingPanel.createOrShow(this.context.extensionUri, pairing);
    await this.pollPairingStatus(pairing.pairingSessionId, panel);
  }

  async disconnect(): Promise<void> {
    await this.context.globalState.update(PAIRED_KEY, false);
    await this.context.globalState.update(PAIRING_SESSION_ID_KEY, undefined);
    await this.context.globalState.update(EVENT_TOKEN_EXPIRES_AT_KEY, undefined);
    await this.context.secrets.delete(EVENT_WRITE_TOKEN_KEY);
    vscode.window.showInformationMessage("Ascenda disconnected from this editor installation.");
  }

  isPaired(): boolean { return this.context.globalState.get<boolean>(PAIRED_KEY, false); }
  getToolInstallationId(): string | undefined { return this.context.globalState.get<string>(TOOL_INSTALLATION_ID_KEY); }
  async getEventWriteToken(): Promise<string | undefined> { return this.context.secrets.get(EVENT_WRITE_TOKEN_KEY); }

  async ensureEventWriteToken(): Promise<string | undefined> {
    if (!this.isPaired()) return undefined;
    const token = await this.getEventWriteToken();
    if (!token) {
      await this.markNeedsRepair();
      return undefined;
    }
    const expiresAt = this.context.globalState.get<number>(EVENT_TOKEN_EXPIRES_AT_KEY);
    if (expiresAt && Date.now() < expiresAt - TOKEN_RENEW_LEAD_MS) return token;
    return this.renewWithEventToken(token);
  }

  async handleAuthFailure(): Promise<string | undefined> {
    const token = await this.getEventWriteToken();
    if (!token) {
      await this.markNeedsRepair();
      return undefined;
    }
    return this.renewWithEventToken(token);
  }

  async getOrCreateToolInstallationId(): Promise<string> {
    const existing = this.context.globalState.get<string>(TOOL_INSTALLATION_ID_KEY);
    if (existing) return existing;
    const id = `${getToolType()}:${crypto.randomUUID()}`;
    await this.context.globalState.update(TOOL_INSTALLATION_ID_KEY, id);
    return id;
  }

  private async pollPairingStatus(pairingSessionId: string, panel: PairingPanel): Promise<void> {
    const startedAt = Date.now();
    const maxMs = 10 * 60 * 1000;
    const interval = setInterval(async () => {
      try {
        if (Date.now() - startedAt > maxMs) {
          clearInterval(interval);
          panel.showExpired();
          return;
        }
        const status = await this.api.getPairingStatus(pairingSessionId);
        if (status.status === "pending") return;
        if (status.status === "expired" || status.status === "cancelled") {
          clearInterval(interval);
          panel.showExpired();
          return;
        }
        if (status.status === "paired") {
          clearInterval(interval);
          if (status.toolInstallationId) {
            await this.context.globalState.update(TOOL_INSTALLATION_ID_KEY, status.toolInstallationId);
          }
          if (status.eventWriteToken) {
            await this.storeEventWriteToken(status.eventWriteToken);
          }
          // "Connected" must mean "holding credentials", not just "the server
          // says paired". The write token is only ever delivered on this poll
          // — there is no later fetch path without a token to renew from — so
          // a paired response with no token and none stored is a dead state:
          // every flush would silently no-op while the UI claims connected.
          // That exact combination shipped once (a server bug suppressed
          // minting when a previous pairing's token was still active) and the
          // only signal anyone got was silence.
          const token = status.eventWriteToken ?? (await this.getEventWriteToken());
          if (!token) {
            await this.context.globalState.update(PAIRED_KEY, false);
            panel.showTokenMissing();
            vscode.window.showErrorMessage(
              "Ascenda pairing did not complete: the server confirmed the pairing but no credentials arrived. Disconnect this tool in the Ascenda app, then run Ascenda: Connect App again."
            );
            return;
          }
          await this.context.globalState.update(PAIRED_KEY, true);
          panel.showPaired();
          vscode.window.showInformationMessage("Ascenda is connected. Workload telemetry can now be routed to your app.");
          for (const listener of this.pairedListeners) listener();
        }
      } catch (error) {
        clearInterval(interval);
        vscode.window.showErrorMessage(`Ascenda pairing failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 2000);
  }

  private async renewWithEventToken(currentToken: string): Promise<string | undefined> {
    try {
      const renewed = await this.api.renewEventToken(currentToken);
      if (!renewed) {
        await this.markNeedsRepair();
        return undefined;
      }
      await this.storeEventWriteToken(renewed.eventWriteToken, renewed.expiresAt);
      return renewed.eventWriteToken;
    } catch {
      await this.markNeedsRepair();
      return undefined;
    }
  }

  private async storeEventWriteToken(token: string, expiresAtIso?: string | null): Promise<void> {
    await this.context.secrets.store(EVENT_WRITE_TOKEN_KEY, token);
    const expiresAt = expiresAtIso ? Date.parse(expiresAtIso) : Date.now() + 30 * 24 * 60 * 60 * 1000;
    await this.context.globalState.update(EVENT_TOKEN_EXPIRES_AT_KEY, expiresAt);
  }

  private async markNeedsRepair(): Promise<void> {
    await this.context.globalState.update(PAIRED_KEY, false);
    await this.context.secrets.delete(EVENT_WRITE_TOKEN_KEY);
    await this.context.globalState.update(EVENT_TOKEN_EXPIRES_AT_KEY, undefined);
    vscode.window.showWarningMessage("Ascenda connection expired. Run Ascenda: Connect App to re-pair.");
  }

  private getDisplayName(): string {
    // An editor-wide pairing gets an editor-wide name. The old label froze
    // whichever workspace was open at pairing time ("some-repo on VS
    // Code"), which misread the scope as per-project — one pairing covers
    // every project this editor opens — and sent a repository name to the
    // backend, the exact thing the privacy defaults promise never leaves
    // the machine. The hostname is machine metadata, not work content, and
    // is what actually disambiguates pairings across a person's machines.
    return `${getHostDisplayName()} (${os.hostname()})`;
  }
}
