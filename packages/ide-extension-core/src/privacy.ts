import * as path from "path";
import * as vscode from "vscode";
import { hashWithMachineSalt } from "@ascenda-one/tool-kit";

/**
 * Salted with a machine-local secret that is never transmitted. A workspace
 * name is a folder name, so an unsalted digest is recoverable from a dictionary
 * of common repository names. See packages/tool-kit/src/salt.ts.
 */
export function hashValue(value: string | undefined | null): string | null {
  return hashWithMachineSalt(value);
}

export function getWorkspaceHash(): string | null { return hashValue(vscode.workspace.name); }
export function getFileTypeFromUri(uri: vscode.Uri): string | null { const ext = path.extname(uri.fsPath || "").replace(".", "").toLowerCase(); return ext || null; }
