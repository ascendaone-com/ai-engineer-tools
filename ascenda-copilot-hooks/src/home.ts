import * as os from "os";
import * as path from "path";

/**
 * Where Copilot CLI keeps its user-level files: `$COPILOT_HOME` when it is
 * set, otherwise `~/.copilot`. A repository's `.github/hooks` folder is not
 * affected by it.
 */
export function copilotHome(): string {
  const configured = process.env.COPILOT_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".copilot");
}
