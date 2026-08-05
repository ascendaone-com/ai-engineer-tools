import * as vscode from "vscode";
import { expandUserPath, resolveEventLogPath } from "@ascenda-one/tool-kit";

export class AscendaConfig {
  static get apiBaseUrl(): string { return vscode.workspace.getConfiguration("ascenda").get<string>("apiBaseUrl", "https://api.ascenda.one").replace(/\/$/, ""); }
  static get telemetryEnabled(): boolean { return vscode.workspace.getConfiguration("ascenda").get<boolean>("telemetry.enabled", true); }
  static get captureEditorActivity(): boolean { return vscode.workspace.getConfiguration("ascenda").get<boolean>("telemetry.captureEditorActivity", true); }
  static get captureTerminalCommands(): boolean { return vscode.workspace.getConfiguration("ascenda").get<boolean>("telemetry.captureTerminalCommands", true); }
  static get afterHoursStart(): string { return vscode.workspace.getConfiguration("ascenda").get<string>("telemetry.afterHoursStart", "19:00"); }
  static get afterHoursEnd(): string { return vscode.workspace.getConfiguration("ascenda").get<string>("telemetry.afterHoursEnd", "07:00"); }
  static get flushIntervalSeconds(): number { return vscode.workspace.getConfiguration("ascenda").get<number>("telemetry.flushIntervalSeconds", 30); }
  /**
   * Local JSONL sink. The hook adapters take this from ASCENDA_EVENT_LOG_FILE
   * because each hook is a freshly spawned process, but an editor is launched
   * once — from a dock icon, with no shell environment — so a setting is the
   * only channel a user can actually reach. The env var still wins when set,
   * to keep one override working across every tool.
   */
  static get eventLogFile(): string | undefined {
    return resolveEventLogPath() ?? expandUserPath(vscode.workspace.getConfiguration("ascenda").get<string>("eventLogFile", ""));
  }
}
