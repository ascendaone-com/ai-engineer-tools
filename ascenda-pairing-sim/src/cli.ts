#!/usr/bin/env node
import * as crypto from "crypto";
import { defaultTokenFilePath, persistEventWriteToken } from "@ascenda/tool-kit";
import { PairingSimApi } from "./api.js";
import { loadConfig } from "./config.js";

function usage(): never {
  console.log(`ascenda-pairing-sim — simulate Ascenda mobile app pairing (dev/test)

Requires:
  ASCENDA_USER_TOKEN   Authenticated user JWT (app / Kinde / BE test user)
  ASCENDA_API_BASE_URL Optional, default https://api.ascenda.one
  ASCENDA_DEVICE_ID    Optional, default pairing-sim-console

App-side commands (need user JWT):
  confirm-code <6-digit-code>
  confirm-device-code <6-digit-code>
  confirm-secret <pairingSessionId> <secret>
  list
  revoke <toolInstallationId>
  renew-user <toolInstallationId>

Full e2e without an IDE (creates tool session, confirms as app, prints token):
  e2e [--tool-type vscode_extension|cursor_mcp|claude_code] [--name "Display Name"]

Tool-side helpers (anonymous):
  status <pairingSessionId>

Examples:
  export ASCENDA_USER_TOKEN="eyJ..."
  export ASCENDA_API_BASE_URL="http://localhost:5002"

  # Extension shows code 413902 — confirm as the app:
  ascenda-pairing-sim confirm-device-code 413902

  # Full loop without opening VS Code/Cursor:
  ascenda-pairing-sim e2e --tool-type cursor_mcp
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") usage();

  const config = loadConfig();
  const api = new PairingSimApi(config);

  switch (command) {
    case "confirm-code": {
      const code = requireArg(args[0], "code");
      await api.confirmByCode(code);
      console.log(`Paired via confirm-by-code (deviceId=${config.deviceId}).`);
      break;
    }
    case "confirm-device-code": {
      const deviceCode = requireArg(args[0], "deviceCode");
      await api.confirmByDeviceCode(deviceCode);
      console.log(`Paired via confirm-device-code (deviceId=${config.deviceId}).`);
      break;
    }
    case "confirm-secret": {
      const pairingSessionId = requireArg(args[0], "pairingSessionId");
      const secret = requireArg(args[1], "secret");
      await api.confirmBySecret(pairingSessionId, secret);
      console.log(`Paired via confirm-by-secret (deviceId=${config.deviceId}).`);
      break;
    }
    case "list": {
      const tools = await api.listConnectedTools();
      if (tools.length === 0) {
        console.log("No connected tools.");
        break;
      }
      for (const tool of tools) {
        console.log(`${tool.toolInstallationId}\t${tool.toolType}\t${tool.displayName ?? ""}\tpaired=${tool.pairedAt ?? ""}\tlastSeen=${tool.lastSeenAt ?? ""}`);
      }
      break;
    }
    case "revoke": {
      const toolInstallationId = requireArg(args[0], "toolInstallationId");
      await api.revokeTool(toolInstallationId);
      console.log(`Revoked ${toolInstallationId}.`);
      break;
    }
    case "renew-user": {
      const toolInstallationId = requireArg(args[0], "toolInstallationId");
      const renewed = await api.renewTokenAsUser(toolInstallationId);
      console.log(JSON.stringify(renewed, null, 2));
      break;
    }
    case "status": {
      const pairingSessionId = requireArg(args[0], "pairingSessionId");
      const status = await api.getStatus(pairingSessionId);
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    case "e2e": {
      await runE2e(api, args);
      break;
    }
    default:
      usage();
  }
}

async function runE2e(api: PairingSimApi, args: string[]): Promise<void> {
  let toolType = "vscode_extension";
  let displayName = "Pairing Sim Console";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tool-type" && args[i + 1]) {
      toolType = args[++i];
    } else if (args[i] === "--name" && args[i + 1]) {
      displayName = args[++i];
    }
  }

  const toolInstallationId = `${toolType}:${crypto.randomUUID()}`;
  console.log(`Creating tool pairing session (${toolType})...`);
  const session = await api.createToolSession(toolInstallationId, toolType, displayName);
  console.log(`pairingSessionId=${session.pairingSessionId}`);
  console.log(`code/deviceCode=${session.code}`);
  console.log(`expiresAt=${session.expiresAt}`);

  console.log("Confirming as app (confirm-device-code)...");
  await api.confirmByDeviceCode(session.deviceCode);

  console.log("Polling status for eventWriteToken...");
  const status = await api.getStatus(session.pairingSessionId);
  if (status.status !== "paired" || !status.eventWriteToken) {
    throw new Error(`Expected paired + token, got: ${JSON.stringify(status)}`);
  }

  const tokenPath = defaultTokenFilePath(toolInstallationId);
  persistEventWriteToken(tokenPath, status.eventWriteToken);

  console.log("Paired successfully.");
  console.log(`toolInstallationId=${status.toolInstallationId ?? toolInstallationId}`);
  console.log(`eventWriteToken=${status.eventWriteToken}`);
  console.log(`pairedAt=${status.pairedAt}`);
  console.log(`tokenFile=${tokenPath}`);
  console.log("");
  console.log("Claude hooks can reuse:");
  console.log(`  export ASCENDA_TOOL_INSTALLATION_ID="${status.toolInstallationId ?? toolInstallationId}"`);
  console.log(`  export ASCENDA_EVENT_WRITE_TOKEN="${status.eventWriteToken}"`);
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing argument: ${name}`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
