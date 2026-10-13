import * as fs from "fs";
import * as path from "path";
import { writeAtomically } from "./hookRunner";

/**
 * Replaces an agent's settings file with new contents, the way every
 * `setup` and `uninstall` does it.
 *
 *  - **The first backup is kept.** `<file>.ascenda-backup` is written only
 *    when there isn't one, so it stays the file as it was before Ascenda
 *    first touched it. Refreshing it on every write meant an install followed
 *    by an uninstall left a backup with our hooks in it.
 *  - **A symlink stays a symlink.** Settings kept in a dotfiles repo are often
 *    linked into place. The write goes to the file the link points at, so the
 *    link and the repo both see the change.
 *  - **The write is atomic.** The agent reads this file on every event, and a
 *    rename means it sees the old file or the new one, never a torn one.
 *  - **The mode is kept.** A file someone made private stays private.
 */
export function replaceSettingsFile(settingsFile: string, contents: string): void {
  const exists = fs.existsSync(settingsFile);
  const target = exists ? fs.realpathSync(settingsFile) : settingsFile;
  if (exists) {
    const backup = `${settingsFile}.ascenda-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = exists ? fs.statSync(target).mode & 0o777 : 0o644;
  writeAtomically(target, contents, mode);
}
