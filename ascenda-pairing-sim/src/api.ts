import type { ConnectedTool, PairingSessionResponse, PairingStatusResponse, RenewToolTokenResponse } from "@ascenda-one/tool-contract";
import { createPairingSession, getPairingStatus } from "@ascenda-one/tool-kit";
import { SimConfig } from "./config.js";

export type { ConnectedTool } from "@ascenda-one/tool-contract";
export type PairingStatus = PairingStatusResponse;
export type CreatePairingSessionResponse = PairingSessionResponse;

export class PairingSimApi {
  constructor(private readonly config: SimConfig) {}

  /** App-side: confirm by 6-digit code (recommended for modern clients). */
  async confirmByDeviceCode(deviceCode: string): Promise<void> {
    await this.postAuthed("/v1/tool-pairing-sessions/confirm-device-code", {
      deviceCode,
      deviceId: this.config.deviceId
    });
  }

  /** App-side: confirm by code (alias path). */
  async confirmByCode(code: string): Promise<void> {
    await this.postAuthed("/v1/tool-pairing-sessions/confirm-by-code", {
      code,
      deviceId: this.config.deviceId
    });
  }

  /** App-side: confirm by QR secret. */
  async confirmBySecret(pairingSessionId: string, secret: string): Promise<void> {
    await this.postAuthed(`/v1/tool-pairing-sessions/${encodeURIComponent(pairingSessionId)}/confirm`, {
      secret,
      deviceId: this.config.deviceId
    });
  }

  /** Tool-side (anonymous): create a pairing session for e2e tests without an IDE.
   *  Delegates to @ascenda-one/tool-kit so the e2e exercises the same client the tools use. */
  async createToolSession(toolInstallationId: string, toolType: string, displayName: string): Promise<CreatePairingSessionResponse> {
    return createPairingSession(this.config.apiBaseUrl, toolInstallationId, toolType, displayName);
  }

  /** Tool-side (anonymous): poll status. Delegates to @ascenda-one/tool-kit. */
  async getStatus(pairingSessionId: string): Promise<PairingStatus> {
    return getPairingStatus(this.config.apiBaseUrl, pairingSessionId);
  }

  async listConnectedTools(): Promise<ConnectedTool[]> {
    const response = await fetch(`${this.config.apiBaseUrl}/v1/connected-tools`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.userToken}`
      }
    });
    await throwIfNotOk(response);
    const body = (await response.json()) as { tools: ConnectedTool[] };
    return body.tools ?? [];
  }

  async revokeTool(toolInstallationId: string): Promise<void> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/v1/connected-tools/${encodeURIComponent(toolInstallationId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.config.userToken}` }
      }
    );
    await throwIfNotOk(response);
  }

  /** App-side user-JWT renew (not used by tools; useful for sim completeness). */
  async renewTokenAsUser(toolInstallationId: string): Promise<RenewToolTokenResponse> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/v1/connected-tools/${encodeURIComponent(toolInstallationId)}/renew-token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.userToken}`
        },
        body: JSON.stringify({ toolInstallationId })
      }
    );
    await throwIfNotOk(response);
    return (await response.json()) as RenewToolTokenResponse;
  }

  private async postAuthed(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.userToken}`
      },
      body: JSON.stringify(body)
    });
    await throwIfNotOk(response);
  }

  private async postAnonymous(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    await throwIfNotOk(response);
    return response.json();
  }
}

async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;
  const text = await response.text();
  let detail = text;
  try {
    detail = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // keep raw text
  }
  throw new Error(`HTTP ${response.status}: ${detail}`);
}
