import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";

export function hashValue(value: string | undefined | null): string | null {
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function getWorkspaceHash(): string | null { return hashValue(vscode.workspace.name); }
export function getFileTypeFromUri(uri: vscode.Uri): string | null { const ext = path.extname(uri.fsPath || "").replace(".", "").toLowerCase(); return ext || null; }
