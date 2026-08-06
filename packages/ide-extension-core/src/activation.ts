import * as vscode from "vscode";
import { AscendaApi } from "./ascendaApi";
import { AscendaConfig } from "./config";
import { EditorTelemetry } from "./editorTelemetry";
import { detectHostKind, getHostDisplayName } from "./host";
import { PairingService } from "./pairingService";
import { TelemetryService } from "./telemetryService";
import { TerminalTelemetry } from "./terminalTelemetry";
let telemetryService: TelemetryService | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const api = new AscendaApi(); const pairingService = new PairingService(context, api);
  telemetryService = new TelemetryService(api, pairingService); telemetryService.start(); context.subscriptions.push(telemetryService);
  const editorTelemetry = new EditorTelemetry(telemetryService); editorTelemetry.start(); context.subscriptions.push(editorTelemetry);
  const terminalTelemetry = new TerminalTelemetry(telemetryService); terminalTelemetry.start(); context.subscriptions.push(terminalTelemetry);
  context.subscriptions.push(vscode.commands.registerCommand("ascenda.connect", async () => { await pairingService.connect(); }));
  context.subscriptions.push(vscode.commands.registerCommand("ascenda.disconnect", async () => { await telemetryService?.flush(); await pairingService.disconnect(); }));
  context.subscriptions.push(vscode.commands.registerCommand("ascenda.sendTestSignal", async () => { telemetryService?.track("editor_activity", "low", { activity: "test_signal", message: "Ascenda extension test signal", host: getHostDisplayName(), simulated: true }); await telemetryService?.flush(); vscode.window.showInformationMessage("Ascenda test signal queued."); }));
  context.subscriptions.push(vscode.commands.registerCommand("ascenda.simulateContextCompression", async () => { telemetryService?.track("context_compression_manual", "medium", { trigger: "manual", simulated: true, reason: "context_limit" }); await telemetryService?.flush(); vscode.window.showInformationMessage("Ascenda context compression signal queued."); }));
  context.subscriptions.push(vscode.commands.registerCommand("ascenda.simulateContextPressureHigh", async () => { telemetryService?.track("context_pressure_high", "medium", { trigger: "inferred", simulated: true, tokenPressureBucket: "high", reason: "long_session" }); await telemetryService?.flush(); vscode.window.showInformationMessage("Ascenda context pressure signal queued."); }));
  context.subscriptions.push(vscode.commands.registerCommand("ascenda.simulateAgentLoopLong", async () => { telemetryService?.track("agent_loop_long", "medium", { trigger: "inferred", simulated: true, durationBucket: "30-60m", reason: "long_session" }); await telemetryService?.flush(); vscode.window.showInformationMessage("Ascenda long agent loop signal queued."); }));
  context.subscriptions.push(vscode.commands.registerCommand("ascenda.showStatus", async () => {
    const pairedFlag = pairingService.isPaired();
    const toolInstallationId = pairingService.getToolInstallationId() ?? "not created";
    const hasToken = Boolean(await pairingService.getEventWriteToken());
    // paired=true with no token is not a paired state — nothing can be sent
    // and nothing will recover on its own. Report it as what it is instead
    // of two individually-true fields that add up to a lie.
    const state = pairedFlag && hasToken ? "paired" : pairedFlag ? "NEEDS RE-PAIR (paired but no credentials — run Ascenda: Connect App)" : "not paired";
    vscode.window.showInformationMessage(`Ascenda status: ${state}, host=${detectHostKind()}, telemetry=${AscendaConfig.telemetryEnabled}, tool=${toolInstallationId}`);
  }));
}
export async function deactivate(): Promise<void> { await telemetryService?.stop(); }
