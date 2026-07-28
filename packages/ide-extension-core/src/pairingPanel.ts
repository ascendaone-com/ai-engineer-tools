import * as vscode from "vscode";
import { getHostDisplayName } from "./host";
import { renderQrSvg } from "./qr";
import { PairingSessionResponse } from "@ascenda-one/tool-contract";

// Blocks every remote load from the panel. The QR is inlined as SVG markup, so
// nothing here needs the network — and the pairing secret cannot be exfiltrated
// through an image URL again without this failing loudly.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;"/>`;

export class PairingPanel {
  public static currentPanel: PairingPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  static createOrShow(extensionUri: vscode.Uri, pairing: PairingSessionResponse): PairingPanel {
    if (PairingPanel.currentPanel) { PairingPanel.currentPanel.update(pairing); PairingPanel.currentPanel.panel.reveal(vscode.ViewColumn.One); return PairingPanel.currentPanel; }
    const panel = vscode.window.createWebviewPanel("ascendaPairing", "Connect Ascenda", vscode.ViewColumn.One, { enableScripts: false, retainContextWhenHidden: true });
    PairingPanel.currentPanel = new PairingPanel(panel, extensionUri, pairing); return PairingPanel.currentPanel;
  }
  private constructor(private readonly panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri, pairing: PairingSessionResponse) { this.update(pairing); this.panel.onDidDispose(() => this.dispose(), null, this.disposables); }
  update(pairing: PairingSessionResponse): void { this.panel.webview.html = this.getHtml(pairing); }
  showPaired(): void { const host = getHostDisplayName(); this.panel.webview.html = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;"><h1>Ascenda connected</h1><p>This ${escapeHtml(host)} installation is now paired to your Ascenda app.</p><p>No email address or personal identity was shared with ${escapeHtml(host)}.</p><p>Privacy-safe workload telemetry can now be routed through the backend to your app.</p></body></html>`; }
  showExpired(): void { this.panel.webview.html = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;"><h1>Pairing expired</h1><p>Run <strong>Ascenda: Connect App</strong> again to create a new pairing code.</p></body></html>`; }
  dispose(): void { PairingPanel.currentPanel = undefined; this.panel.dispose(); while (this.disposables.length) this.disposables.pop()?.dispose(); }
  private getHtml(pairing: PairingSessionResponse): string {
    const host = getHostDisplayName();
    const qrSvg = renderQrSvg(pairing.qrUrl);
    const expiry = new Date(pairing.expiresAt).toLocaleTimeString();
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>${CSP}<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px;line-height:1.5}.card{max-width:560px;border:1px solid var(--vscode-panel-border);border-radius:8px;padding:24px}.qr{width:240px;height:240px;margin:16px 0;background:white;padding:12px;border-radius:8px}.code{font-size:32px;letter-spacing:4px;font-weight:700;margin:12px 0}.muted{opacity:.75}</style></head><body><div class="card"><h1>Connect Ascenda to ${escapeHtml(host)}</h1><p>Open the Ascenda app and scan this QR code.</p>${qrSvg}<p>Or enter this pairing code in the app:</p><div class="code">${escapeHtml(pairing.code)}</div><p class="muted">Expires at ${escapeHtml(expiry)}.</p><hr/><p class="muted">This does not share your email, name, source code, prompts, files, branch names, repository names, or mobile push token. It links this ${escapeHtml(host)} installation to your Ascenda app so privacy-safe workload signals can be routed to your device.</p></div></body></html>`;
  }
}
function escapeHtml(value: string): string { return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
