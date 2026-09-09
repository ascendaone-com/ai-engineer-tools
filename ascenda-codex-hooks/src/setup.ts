import * as os from "os";
import * as path from "path";
import type { CliAgentSetupSpec } from "@ascenda-one/tool-kit";
import { ASCENDA_TOOL_TYPE, CODEX_HOST } from "./types.js";

/**
 * Only the hooks that map to a catalog event. `PermissionRequest` and the
 * subagent lifecycle pair map to nothing, so registering them would spend a
 * process per approval to send an empty list.
 */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse", "PostToolUse",
  "PreCompact", "PostCompact",
  "Stop"
] as const;

/**
 * Matches the timeout in `examples/hooks.json`, so a hand-merged file and a
 * `setup`-written one do not disagree. Generous on purpose: the adapter caps
 * its own HTTP at 3 s (ASCENDA_HTTP_TIMEOUT_MS), so this ceiling is only ever
 * reached by a wedged process, and Codex awaits command hooks.
 */
const HOOK_TIMEOUT_SECONDS = 10;

type CodexHookGroup = { hooks?: Array<{ type?: string; command?: unknown }> };

export const SETUP: CliAgentSetupSpec = {
  host: CODEX_HOST,
  displayName: "Codex CLI",
  toolType: ASCENDA_TOOL_TYPE,
  packageName: "@ascenda-one/codex-hooks",
  binaryName: "ascenda-codex-hook",
  hookEvents: HOOK_EVENTS,
  restartHint: "Restart Codex, then open /hooks to review and trust the Ascenda hooks. Registration alone does not enable execution. After a session, verify the cli_agent send journal and metadata.host: codex in the event log.",
  settings: {
    settingsPath: (scope, projectDir) =>
      scope === "user" ? path.join(os.homedir(), ".codex", "hooks.json") : path.join(projectDir, ".codex", "hooks.json"),
    // Codex nests as Gemini does — each event maps to an array of
    // { hooks: [{ type, command }] } — but reads the event from argv rather
    // than stdin, so unlike Gemini the name has to be on the command line.
    entry: (command, event) => ({ hooks: [{ type: "command", command: `${command} ${event}`, timeout: HOOK_TIMEOUT_SECONDS }] }),
    commandOf: (entry) => {
      const group = entry as CodexHookGroup | undefined;
      const command = group?.hooks?.find((hook) => typeof hook?.command === "string")?.command;
      return typeof command === "string" ? command : undefined;
    }
  }
};
