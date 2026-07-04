import * as vscode from "vscode";
import { AscendaTelemetrySource } from "./types";

export type HostKind = "cursor" | "vscode" | "unknown";

export function detectHostKind(): HostKind {
  const appName = vscode.env.appName.toLowerCase();
  const uriScheme = vscode.env.uriScheme.toLowerCase();
  if (appName.includes("cursor") || uriScheme.includes("cursor")) return "cursor";
  if (appName.includes("visual studio code") || uriScheme.includes("vscode")) return "vscode";
  return "unknown";
}

export function getToolType(): string {
  return detectHostKind() === "cursor" ? "cursor_mcp" : "vscode_extension";
}

export function getTelemetrySource(): AscendaTelemetrySource {
  const toolType = getToolType();
  return toolType === "cursor_mcp" ? "cursor_mcp" : "vscode_extension";
}

export function getHostDisplayName(): string {
  const host = detectHostKind();
  if (host === "cursor") return "Cursor";
  if (host === "vscode") return "VS Code";
  return vscode.env.appName || "Editor";
}
