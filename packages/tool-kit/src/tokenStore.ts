import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Default location for persisted event write tokens: ~/.ascenda/tokens/<toolInstallationId>. */
export function defaultTokenFilePath(toolInstallationId: string): string {
  return path.join(os.homedir(), ".ascenda", "tokens", sanitizeFilePart(toolInstallationId));
}

export function persistEventWriteToken(tokenFilePath: string, token: string): void {
  fs.mkdirSync(path.dirname(tokenFilePath), { recursive: true });
  fs.writeFileSync(tokenFilePath, token, { encoding: "utf8", mode: 0o600 });
}

export function readTokenFile(tokenFilePath: string): string | undefined {
  try {
    if (!fs.existsSync(tokenFilePath)) return undefined;
    const value = fs.readFileSync(tokenFilePath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_");
}
