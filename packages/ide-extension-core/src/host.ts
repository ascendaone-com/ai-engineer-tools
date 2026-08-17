import * as vscode from "vscode";
import { AscendaTelemetrySource } from "@ascenda-one/tool-contract";

export type HostKind = "cursor" | "antigravity" | "vscode" | "unknown";

export function detectHostKind(): HostKind {
  const appName = vscode.env.appName.toLowerCase();
  const uriScheme = vscode.env.uriScheme.toLowerCase();
  if (appName.includes("cursor") || uriScheme.includes("cursor")) return "cursor";
  // Antigravity IDE: appName "Antigravity IDE", uriScheme "antigravity-ide".
  // Checked before the VS Code test because it is a VS Code fork and future
  // builds may well reintroduce "vscode" somewhere in these strings.
  if (appName.includes("antigravity") || uriScheme.includes("antigravity")) return "antigravity";
  if (appName.includes("visual studio code") || uriScheme.includes("vscode")) return "vscode";
  return "unknown";
}

/**
 * Antigravity deliberately reports as `vscode_extension`: it is a VS Code fork
 * running this same extension, and the catalog has no source for it. Minting
 * one is a backend contract change (api-docs/TOOL_PAIRING_API_REFERENCE.md),
 * and pairing rejects a toolType the backend does not know. Until then the
 * `host` metadata on every event is what tells the two apart.
 */
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
  if (host === "antigravity") return "Antigravity";
  if (host === "vscode") return "VS Code";
  return vscode.env.appName || "Editor";
}

const KNOWN_SOURCES: readonly AscendaTelemetrySource[] = ["vscode_extension", "cursor_mcp", "claude_code", "copilot_otel", "cli_agent", "mcp_server", "activity_signals"];

/**
 * Telemetry source must stay consistent with the identity this installation
 * paired under (the toolType prefix of its toolInstallationId); live host
 * detection is only the fallback for ids without a recognisable prefix.
 * Without this, an install paired as vscode_extension that later runs inside
 * Cursor would silently flip its reported source mid-stream.
 */
export function resolveTelemetrySource(toolInstallationId: string | undefined): AscendaTelemetrySource {
  const prefix = toolInstallationId?.split(":")[0];
  if (prefix && (KNOWN_SOURCES as readonly string[]).includes(prefix)) return prefix as AscendaTelemetrySource;
  return getTelemetrySource();
}
