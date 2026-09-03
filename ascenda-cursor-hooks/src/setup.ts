import * as os from "os";
import * as path from "path";
import type { CliAgentSetupSpec } from "@ascenda-one/tool-kit";
import { ASCENDA_TOOL_TYPE, CURSOR_HOST } from "./types.js";

/**
 * Only the hooks that map to a catalog event. The shell / MCP / file-edit
 * hooks are specialised views of tool calls `preToolUse`/`postToolUse`
 * already report; registering them would double-count every command.
 */
export const HOOK_EVENTS = ["sessionStart", "sessionEnd", "beforeSubmitPrompt", "preToolUse", "postToolUse", "postToolUseFailure", "preCompact", "stop"] as const;

export const SETUP: CliAgentSetupSpec = {
  host: CURSOR_HOST,
  displayName: "Cursor",
  toolType: ASCENDA_TOOL_TYPE,
  packageName: "@ascenda-one/cursor-hooks",
  binaryName: "ascenda-cursor-hook",
  hookEvents: HOOK_EVENTS,
  restartHint: "Restart Cursor to load the hooks.",
  settings: {
    settingsPath: (scope, projectDir) =>
      scope === "user" ? path.join(os.homedir(), ".cursor", "hooks.json") : path.join(projectDir, ".cursor", "hooks.json"),
    // Cursor's hooks.json is versioned; a file we create must say which.
    scaffold: { version: 1 },
    // Cursor passes the event on stdin too, but this adapter reads argv, so
    // each entry names its event.
    entry: (command, event) => ({ command: `${command} ${event}` }),
    commandOf: (entry) => (entry && typeof entry === "object" ? (entry as { command?: unknown }).command : undefined) as string | undefined
  }
};
