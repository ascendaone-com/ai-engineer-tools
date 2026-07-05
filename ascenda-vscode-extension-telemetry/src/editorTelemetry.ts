import * as vscode from "vscode";
import { AscendaConfig } from "./config";
import { bucketLinesChanged, getFileTypeFromUri } from "./privacy";
import { TelemetryService } from "./telemetryService";
export class EditorTelemetry implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changedLineCounts = new Map<string, number>();
  constructor(private readonly telemetry: TelemetryService) {}
  start(): void {
    if (!AscendaConfig.captureEditorActivity) return;
    this.disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme !== "file") return;
      const key = event.document.uri.toString(); const current = this.changedLineCounts.get(key) ?? 0;
      const delta = event.contentChanges.reduce((sum, change) => { const removedLines = Math.max(0, change.range.end.line - change.range.start.line); const addedLines = Math.max(0, change.text.split(/\r\n|\r|\n/).length - 1); return sum + Math.max(removedLines, addedLines, 1); }, 0);
      this.changedLineCounts.set(key, current + delta);
    }));
    this.disposables.push(vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== "file") return;
      const key = document.uri.toString(); const changedLines = this.changedLineCounts.get(key) ?? 0; this.changedLineCounts.delete(key);
      this.telemetry.track("editor_activity", "low", { activity: "file_saved", language: document.languageId, fileType: getFileTypeFromUri(document.uri), linesChangedBucket: bucketLinesChanged(changedLines) });
    }));
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || editor.document.uri.scheme !== "file") return;
      this.telemetry.track("editor_activity", "low", { activity: "active_editor_changed", language: editor.document.languageId, fileType: getFileTypeFromUri(editor.document.uri) });
    }));
  }
  dispose(): void { for (const disposable of this.disposables) disposable.dispose(); }
}
