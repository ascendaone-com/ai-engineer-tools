import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { LinesChangedBucket } from "./types";

export function hashValue(value: string | undefined | null): string | null {
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function getWorkspaceHash(): string | null { return hashValue(vscode.workspace.name); }
export function getFileTypeFromUri(uri: vscode.Uri): string | null { const ext = path.extname(uri.fsPath || "").replace(".", "").toLowerCase(); return ext || null; }
export function bucketLinesChanged(count: number): LinesChangedBucket { if (count <= 0) return "0"; if (count <= 10) return "1-10"; if (count <= 50) return "10-50"; if (count <= 200) return "50-200"; return "200+"; }

export function isAfterHours(now = new Date(), start = "19:00", end = "07:00"): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const s = parseTimeToMinutes(start, 19 * 60);
  const e = parseTimeToMinutes(end, 7 * 60);
  if (s < e) return current >= s && current < e;
  return current >= s || current < e;
}
function parseTimeToMinutes(value: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const h = Number(match[1]); const m = Number(match[2]);
  if (Number.isNaN(h) || Number.isNaN(m)) return fallback;
  return Math.max(0, Math.min(23, h)) * 60 + Math.max(0, Math.min(59, m));
}
