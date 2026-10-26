import * as path from "path";
import type { CliAgentSetupSpec } from "@ascenda-one/tool-kit";
import { copilotHome } from "./home.js";
import { copilotRuntimeLines } from "./runtimeCheck.js";
import { ASCENDA_TOOL_TYPE, COPILOT_HOST } from "./types.js";

export { copilotHome };

/**
 * The hooks that map to a catalog event. Left out:
 *
 *  - `userPromptTransformed` repeats `userPromptSubmitted` with the expanded
 *    text, so registering both would count every prompt twice.
 *  - `permissionRequest` has no documented input.
 *  - `notification` carries UI text and no work signal.
 *  - `errorOccurred` has no catalog event that fits.
 */
export const HOOK_EVENTS = [
  "sessionStart", "sessionEnd",
  "userPromptSubmitted",
  "preToolUse", "postToolUse", "postToolUseFailure",
  "preCompact",
  "subagentStart", "subagentStop",
  "agentStop"
] as const;

/**
 * Copilot fails open on a timeout for every hook, `preToolUse` included, but
 * telemetry that can't finish in a few seconds still isn't worth the wait.
 */
const HOOK_TIMEOUT_SECONDS = 5;

/** The file setup owns. Copilot loads every `*.json` in its hooks directory. */
const HOOKS_FILE = "ascenda.json";

export const SETUP: CliAgentSetupSpec = {
  host: COPILOT_HOST,
  displayName: "GitHub Copilot CLI",
  toolType: ASCENDA_TOOL_TYPE,
  packageName: "@ascenda-one/copilot-hooks",
  binaryName: "ascenda-copilot-hook",
  hookEvents: HOOK_EVENTS,
  restartHint: "Start a new Copilot CLI session to load the hooks.",
  // The git action or milestone a shell command reached, and nothing else
  // beyond the shared set: Copilot's hooks name no model, no posture and no
  // context figure.
  sends: ["git", "turns", "forge"],
  settings: {
    settingsPath: (scope, projectDir) =>
      scope === "user" ? path.join(copilotHome(), "hooks", HOOKS_FILE) : path.join(projectDir, ".github", "hooks", HOOKS_FILE),
    scaffold: { version: 1 },
    owned: true,
    // Flat entries. The payload doesn't name its hook, so the name goes on
    // the command line and arrives as argv[2].
    entry: (command, event) => ({ type: "command", bash: `${command} ${event}`, timeoutSec: HOOK_TIMEOUT_SECONDS }),
    commandOf: (entry) => {
      const bash = entry && typeof entry === "object" ? (entry as { bash?: unknown }).bash : undefined;
      return typeof bash === "string" ? bash : undefined;
    }
  },
  // Which Copilot runtimes ran our hook, from our own per-session record
  // beside Copilot's session logs. See runtimeCheck.ts.
  doctorExtras: (ui) => copilotRuntimeLines({ ui, hookEvents: HOOK_EVENTS, binaryName: "ascenda-copilot-hook", hooksFile: path.join(copilotHome(), "hooks", HOOKS_FILE) })
};
