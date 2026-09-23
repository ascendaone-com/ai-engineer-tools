import * as vscode from "vscode";
import { expandUserPath, resolveEventLogPath } from "@ascenda-one/tool-kit";
import { DEFAULT_QUEUE_MAX_AGE_MS, DEFAULT_QUEUE_MAX_ENTRIES } from "./queueStore";

const DAY_MS = 24 * 60 * 60 * 1000;

export class AscendaConfig {
  static get apiBaseUrl(): string { return vscode.workspace.getConfiguration("ascenda").get<string>("apiBaseUrl", "https://api.ascenda.one").replace(/\/$/, ""); }
  static get telemetryEnabled(): boolean { return vscode.workspace.getConfiguration("ascenda").get<boolean>("telemetry.enabled", true); }
  static get captureEditorActivity(): boolean { return vscode.workspace.getConfiguration("ascenda").get<boolean>("telemetry.captureEditorActivity", true); }
  static get captureTerminalCommands(): boolean { return vscode.workspace.getConfiguration("ascenda").get<boolean>("telemetry.captureTerminalCommands", true); }
  static get afterHoursStart(): string { return vscode.workspace.getConfiguration("ascenda").get<string>("telemetry.afterHoursStart", "19:00"); }
  static get afterHoursEnd(): string { return vscode.workspace.getConfiguration("ascenda").get<string>("telemetry.afterHoursEnd", "07:00"); }
  static get flushIntervalSeconds(): number { return vscode.workspace.getConfiguration("ascenda").get<number>("telemetry.flushIntervalSeconds", 30); }
  /**
   * Whether a backlog left on disk by a previous session may be re-sent. Off
   * by default until the deployed backend is confirmed to dedupe on
   * `idempotencyKey`; while off the backlog is kept and bounded, never sent.
   */
  static get drainPersistedQueue(): boolean { return vscode.workspace.getConfiguration("ascenda").get<boolean>("telemetry.drainPersistedQueue", false); }
  static get queueMaxEntries(): number { return vscode.workspace.getConfiguration("ascenda").get<number>("telemetry.queueMaxEntries", DEFAULT_QUEUE_MAX_ENTRIES); }
  static get queueMaxAgeMs(): number { return vscode.workspace.getConfiguration("ascenda").get<number>("telemetry.queueMaxAgeDays", DEFAULT_QUEUE_MAX_AGE_MS / DAY_MS) * DAY_MS; }
  /**
   * Local JSONL sink. `resolveEventLogPath()` already checks
   * ASCENDA_EVENT_LOG_FILE and, since the hook adapters can persist it there
   * too, ~/.ascenda/credentials.json — both reachable from a process with no
   * shell environment except this one: an editor is launched once, from a
   * dock icon, and holds no ~/.ascenda pairing of its own. This setting is
   * the channel left for it. Either upstream source still wins when set, to
   * keep one override working across every tool.
   */
  static get eventLogFile(): string | undefined {
    return resolveEventLogPath() ?? expandUserPath(vscode.workspace.getConfiguration("ascenda").get<string>("eventLogFile", ""));
  }
}
