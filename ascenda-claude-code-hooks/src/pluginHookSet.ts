import * as fs from "node:fs";
import * as path from "node:path";
import { ascendaHome, readHookSet, readViaPlugin, RELEASE_CHECK_ENV_VAR, writeAtomically } from "@ascenda-one/tool-kit";

/**
 * The note for a plugin whose `hooks.json` is older than the code it runs.
 *
 * The plugin's hooks run `npx -y @ascenda-one/claude-code-hooks`, and npx
 * checks the registry for a name-only spec, so the code stays current by
 * itself. The list of events in `hooks.json` doesn't. It changes only when
 * the plugin is updated, so a release that adds a hook leaves plugin users
 * running new code that's never called for the new events.
 *
 * Every command in `hooks.json` carries `--hook-set <n>`, and this release
 * knows its own set, so the hook can tell from its own argv. No file of the
 * plugin's is read and nothing is fetched.
 *
 * Shown once for each pair of sets. The npm release can land before the
 * plugin update that registers its hooks, and a note repeated every session
 * in that window would name a command that can't help yet.
 */

export function pluginHookSetStatePath(): string {
  return path.join(ascendaHome(), "state", "plugin-hook-set.json");
}

export function pendingPluginHookSetNotice(options: {
  currentSet: number;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  file?: string;
}): { text: string; markShown: () => void } | undefined {
  const env = options.env ?? process.env;
  if (!readViaPlugin(env) || env[RELEASE_CHECK_ENV_VAR]?.trim().toLowerCase() === "true") return undefined;
  const registered = readHookSet(options.argv ?? process.argv);
  // A registration with no set predates sets, and one this old has a plugin
  // update waiting regardless; but an argv without the flag is also how a
  // person runs the binary, so it's left alone.
  if (registered === undefined || registered >= options.currentSet) return undefined;

  const file = options.file ?? pluginHookSetStatePath();
  const key = `${registered}->${options.currentSet}`;
  if (readShown(file) === key) return undefined;

  return {
    text:
      `Ascenda note: the Ascenda plugin registers hook set ${registered}, and the code it runs expects set ${options.currentSet}, ` +
      "so some Claude Code events aren't reaching Ascenda. Run `claude plugin update ascenda@ascenda-one`, then restart Claude Code. " +
      "This note appears once.",
    markShown: () => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeAtomically(file, `${JSON.stringify({ shown: key })}\n`, 0o600);
      } catch {
        // Unwritable home: the note may come back next session. Better than never.
      }
    }
  };
}

function readShown(file: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { shown?: unknown };
    return typeof parsed.shown === "string" ? parsed.shown : undefined;
  } catch {
    return undefined;
  }
}
