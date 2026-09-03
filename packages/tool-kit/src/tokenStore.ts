import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Root for all machine-wide Ascenda state: tokens, credentials, installed
 * binaries. One directory so an uninstaller has one thing to reason about.
 * `ASCENDA_HOME` overrides it — tests rely on that to stay out of the real
 * home directory, and it is the hook for future per-profile installs.
 */
export function ascendaHome(): string {
  return process.env.ASCENDA_HOME ?? path.join(os.homedir(), ".ascenda");
}

/** Default location for persisted event write tokens: ~/.ascenda/tokens/<toolInstallationId>. */
export function defaultTokenFilePath(toolInstallationId: string): string {
  return path.join(ascendaHome(), "tokens", sanitizeFilePart(toolInstallationId));
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

/**
 * The installation ids whose write token is on disk, for one tool type.
 *
 * Written because on 26 Aug 2026 a collector lost twelve hours of events: the
 * id lived only in a shell rc file, the editor had been launched from the
 * Dock, and every hook it spawned inherited an environment without it. The
 * id was on disk the whole time — it *is* the token filename, in sanitised
 * form — so a hook with an empty environment can still name its installation
 * as long as the answer is unambiguous.
 *
 * Only readable, non-empty token files count: an empty file could not be used
 * to send even if it were chosen. Filenames are sanitised (`:` becomes `_`),
 * and real ids are `<toolType>:<uuid>`, so the id is rebuilt by putting the
 * `:` back after the tool type. Anything that does not parse that way, or
 * whose directory is missing or unreadable, contributes nothing rather than
 * an error: the caller decides what an empty or ambiguous answer means.
 */
export function listPersistedToolInstallationIds(toolType: string): string[] {
  const prefix = `${sanitizeFilePart(toolType)}_`;
  const dir = path.join(ascendaHome(), "tokens");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const ids: string[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith(prefix) || name.length === prefix.length) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    if (readTokenFile(file) === undefined) continue;
    ids.push(`${toolType}:${name.slice(prefix.length)}`);
  }
  return ids;
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
