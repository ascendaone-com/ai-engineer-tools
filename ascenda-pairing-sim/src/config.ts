import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export type SimConfig = {
  apiBaseUrl: string;
  userToken: string;
  deviceId: string;
  adminToken?: string;
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Loads KEY=VALUE pairs from a local file into process.env when unset.
 * Used for gitignored DevAuth tokens (local.devauth.env).
 */
export function loadLocalEnvFile(filePath: string = path.join(packageRoot, "local.devauth.env")): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

export function loadConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  loadLocalEnvFile();

  const apiBaseUrl = (overrides.apiBaseUrl
    ?? process.env.ASCENDA_API_BASE_URL
    ?? "http://localhost:5002").replace(/\/$/, "");
  const userToken = overrides.userToken ?? process.env.ASCENDA_USER_TOKEN ?? "";
  const deviceId = overrides.deviceId
    ?? process.env.ASCENDA_DEVICE_ID
    ?? "pairing-sim-console";
  const adminToken = process.env.ASCENDA_ADMIN_TOKEN;

  if (!userToken) {
    throw new Error(
      "Missing ASCENDA_USER_TOKEN. For Development, copy local.devauth.env.example → local.devauth.env " +
      "and fill DevAuth tokens from the BE team (never commit local.devauth.env)."
    );
  }

  return { apiBaseUrl, userToken, deviceId, adminToken };
}
