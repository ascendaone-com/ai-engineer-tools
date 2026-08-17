import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Default location for persisted event write tokens: ~/.ascenda/tokens/<toolInstallationId>. */
export function defaultTokenFilePath(toolInstallationId: string): string {
  return path.join(os.homedir(), ".ascenda", "tokens", sanitizeFilePart(toolInstallationId));
}

export function persistEventWriteToken(tokenFilePath: string, token: string): void {
  const dir = path.dirname(tokenFilePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFilePath, token, { encoding: "utf8", mode: 0o600 });
  // Both `mode` options above apply only on creation: an existing token file
  // keeps whatever permissions it already had, and `recursive: true` ignores
  // `mode` for directories that already exist. A token rotated into a file that
  // was once world-readable would stay world-readable, so set both explicitly.
  // Windows does not model these bits; chmod there is meaningless, not safer.
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(tokenFilePath, 0o600);
  }
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

// `:` is deliberately absent from the allow-list: it is legal on POSIX but
// illegal in a Windows filename, where it separates the drive and opens an NTFS
// alternate data stream. Real ids carry it (`claude_code:abc-123`), so allowing
// it through would break every Windows install.
export function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
