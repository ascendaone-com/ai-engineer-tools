import * as vscode from "vscode";
import { classifyCommand, isVerificationCommand } from "@ascenda-one/tool-kit";
import { AscendaConfig } from "./config";
import { TelemetryService } from "./telemetryService";
import { CommandClass, CommandOutcome } from "@ascenda-one/tool-contract";
type ShellExecutionStartEvent = { execution?: { commandLine?: { value?: string } } };
type ShellExecutionEndEvent = { execution?: { commandLine?: { value?: string } }; exitCode?: number | undefined };
export class TerminalTelemetry implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  constructor(private readonly telemetry: TelemetryService) {}
  start(): void {
    if (!AscendaConfig.captureTerminalCommands) return;
    const anyWindow = vscode.window as unknown as { onDidStartTerminalShellExecution?: (listener: (event: ShellExecutionStartEvent) => void) => vscode.Disposable; onDidEndTerminalShellExecution?: (listener: (event: ShellExecutionEndEvent) => void) => vscode.Disposable; };
    if (typeof anyWindow.onDidStartTerminalShellExecution === "function") this.disposables.push(anyWindow.onDidStartTerminalShellExecution((event) => this.trackCommandStarted(classifyCommand(event.execution?.commandLine?.value))));
    if (typeof anyWindow.onDidEndTerminalShellExecution === "function") this.disposables.push(anyWindow.onDidEndTerminalShellExecution((event) => this.trackCommandCompleted(classifyCommand(event.execution?.commandLine?.value), classifyOutcome(event.exitCode))));
  }
  dispose(): void { for (const disposable of this.disposables) disposable.dispose(); }
  private trackCommandStarted(commandClass: CommandClass): void {
    if (isVerificationCommand(commandClass)) { this.telemetry.track("editor_verification_activity", "low", { activity: "terminal_command_started", commandClass, outcome: "unknown" }); return; }
    this.telemetry.track("editor_activity", "low", { activity: "terminal_command_started", commandClass });
  }
  private trackCommandCompleted(commandClass: CommandClass, outcome: CommandOutcome): void {
    if (isVerificationCommand(commandClass)) { this.telemetry.track("editor_verification_activity", outcome === "failure" ? "medium" : "low", { activity: "terminal_command_completed", commandClass, outcome }); return; }
    if (outcome === "failure") { this.telemetry.track("editor_correction_activity", "medium", { activity: "terminal_command_failed", commandClass, outcome, reason: "tool_failure" }); return; }
    this.telemetry.track("editor_activity", "low", { activity: "terminal_command_completed", commandClass, outcome });
  }
}
function classifyOutcome(exitCode: number | undefined): CommandOutcome { if (typeof exitCode !== "number") return "unknown"; return exitCode === 0 ? "success" : "failure"; }
