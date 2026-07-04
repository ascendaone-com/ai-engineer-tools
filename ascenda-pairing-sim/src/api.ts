import { SimConfig } from "./config.js";

export type ConnectedTool = {
  toolInstallationId: string;
  toolType: string;
  displayName: string | null;
  pairedAt: string | null;
  lastSeenAt: string | null;
};

export type PairingStatus = {
  status: "pending" | "paired" | "expired" | "cancelled";
  toolInstallationId: string | null;
  eventWriteToken: string | null;
  pairedAt: string | null;
};

export type CreatePairingSessionResponse = {
  pairingSessionId: string;
  code: string;
  deviceCode: string;
  secret: string;
  qrUrl: string;
  expiresAt: string;
};

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

  /** Tool-side (anonymous): create a pairing session for e2e tests without an IDE. */
  async createToolSession(toolInstallationId: string, toolType: string, displayName: string): Promise<CreatePairingSessionResponse> {
    return this.postAnonymous("/v1/tool-pairing-sessions", {
      toolInstallationId,
      toolType,
      displayName
    }) as Promise<CreatePairingSessionResponse>;
  }

  /** Tool-side (anonymous): poll status. */
  async getStatus(pairingSessionId: string): Promise<PairingStatus> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/v1/tool-pairing-sessions/${encodeURIComponent(pairingSessionId)}/status`,
      { headers: { Accept: "application/json" } }
    );
    await throwIfNotOk(response);
    return (await response.json()) as PairingStatus;
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
  async renewTokenAsUser(toolInstallationId: string): Promise<{ eventWriteToken: string; expiresAt: string }> {
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
    return (await response.json()) as { eventWriteToken: string; expiresAt: string };
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
