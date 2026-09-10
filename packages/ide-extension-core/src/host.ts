import * as vscode from "vscode";
import { ASCENDA_TELEMETRY_SOURCES, AscendaTelemetrySource } from "@ascenda-one/tool-contract";

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

/**
 * Telemetry source must stay consistent with the identity this installation
 * paired under (the toolType prefix of its toolInstallationId); live host
 * detection is only the fallback for ids without a recognisable prefix.
 * Without this, an install paired as vscode_extension that later runs inside
 * Cursor would silently flip its reported source mid-stream.
 */
export function resolveTelemetrySource(toolInstallationId: string | undefined): AscendaTelemetrySource {
  const prefix = toolInstallationId?.split(":")[0];
  // Read straight off the contract. This list used to be restated here and had
  // already drifted by one -- `code_forge` was missing, so a collector paired
  // under it would have fallen through to live host detection and reported the
  // editor it happened to be running in. A `readonly AscendaTelemetrySource[]`
  // annotation cannot catch that: a subset of the union type-checks perfectly.
  // The contract declares the array at runtime for exactly this reason, and its
  // own comment names `code_forge` as the standing reminder.
  if (prefix && (ASCENDA_TELEMETRY_SOURCES as readonly string[]).includes(prefix)) {
    return prefix as AscendaTelemetrySource;
  }
  return getTelemetrySource();
}
