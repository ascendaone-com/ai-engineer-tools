import * as path from "path";
import * as vscode from "vscode";
import { deriveWorkContext, hashWithMachineSalt, recordWorkContext, recordWorkContextAlias } from "@ascenda-one/tool-kit";
import type { WorkContext } from "@ascenda-one/tool-kit";

/**
 * Salted with a machine-local secret that is never transmitted. A workspace
 * name is a folder name, so an unsalted digest is recoverable from a dictionary
 * of common repository names. See packages/tool-kit/src/salt.ts.
 */
export function hashValue(value: string | undefined | null): string | null {
  return hashWithMachineSalt(value);
}

export function getWorkspaceHash(): string | null { return hashValue(vscode.workspace.name); }

/**
 * The canonical project identity for the first workspace folder, from
 * tool-kit's shared derivation — the same digest the CLI hooks and the
 * historical importer send for this repo, worktrees folded into their parent.
 * Memoized per folder because this runs on every event and the derivation
 * walks the filesystem.
 *
 * Recording as a side effect is deliberate: the extension also registers its
 * own wire `workspaceHash` as an alias, because for a multi-root workspace
 * `vscode.workspace.name` is not the folder basename and would otherwise be a
 * digest no local dictionary can name.
 */
const projectContextMemo = new Map<string, WorkContext | null>();

export function getProjectContext(): WorkContext | null {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return null;
  const hit = projectContextMemo.get(folder);
  if (hit !== undefined) return hit;

  const context = deriveWorkContext(folder);
  if (context) {
    recordWorkContext(context);
    const wireWorkspaceHash = getWorkspaceHash();
    if (wireWorkspaceHash && wireWorkspaceHash !== context.workspaceHash && wireWorkspaceHash !== context.projectHash) {
      recordWorkContextAlias(wireWorkspaceHash, vscode.workspace.name ?? context.workspaceLabel ?? folder, folder);
    }
  }
  projectContextMemo.set(folder, context);
  return context;
}

export function getProjectHash(): string | null { return getProjectContext()?.projectHash ?? null; }
export function getFileTypeFromUri(uri: vscode.Uri): string | null { const ext = path.extname(uri.fsPath || "").replace(".", "").toLowerCase(); return ext || null; }
