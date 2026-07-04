import * as vscode from "vscode";

export class AscendaConfig {
  static get apiBaseUrl(): string { return vscode.workspace.getConfiguration("ascenda").get<string>("apiBaseUrl", "https://api.ascenda.one").replace(/\/$/, ""); }
  static get telemetryEnabled(): boolean { return vscode.workspace.getConfiguration("ascenda").get<boolean>("telemetry.enabled", true); }
  static get captureEditorActivity(): boolean { return vscode.workspace.getConfiguration("ascenda").get<boolean>("telemetry.captureEditorActivity", true); }
  static get captureTerminalCommands(): boolean { return vscode.workspace.getConfiguration("ascenda").get<boolean>("telemetry.captureTerminalCommands", true); }
  static get afterHoursStart(): string { return vscode.workspace.getConfiguration("ascenda").get<string>("telemetry.afterHoursStart", "19:00"); }
  static get afterHoursEnd(): string { return vscode.workspace.getConfiguration("ascenda").get<string>("telemetry.afterHoursEnd", "07:00"); }
  static get flushIntervalSeconds(): number { return vscode.workspace.getConfiguration("ascenda").get<number>("telemetry.flushIntervalSeconds", 30); }
}
