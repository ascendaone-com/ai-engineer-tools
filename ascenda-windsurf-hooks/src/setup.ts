import * as os from "os";
import * as path from "path";
import type { CliAgentSetupSpec } from "@ascenda-one/tool-kit";
import { ASCENDA_TOOL_TYPE, WINDSURF_HOST } from "./types.js";

/**
 * Only the hooks that map to a catalog event.
 * `post_cascade_response_with_transcript` repeats the turn end and points at
 * raw conversation content; `post_setup_worktree` has no counterpart.
 */
export const HOOK_EVENTS = [
  "pre_user_prompt",
  "pre_read_code", "post_read_code",
  "pre_write_code", "post_write_code",
  "pre_run_command", "post_run_command",
  "pre_mcp_tool_use", "post_mcp_tool_use",
  "post_cascade_response"
] as const;

export const SETUP: CliAgentSetupSpec = {
  host: WINDSURF_HOST,
  displayName: "Windsurf",
  toolType: ASCENDA_TOOL_TYPE,
  packageName: "@ascenda-one/windsurf-hooks",
  binaryName: "ascenda-windsurf-hook",
  hookEvents: HOOK_EVENTS,
  restartHint: "Restart Windsurf to load the hooks.",
  settings: {
    settingsPath: (scope, projectDir) =>
      scope === "user" ? path.join(os.homedir(), ".codeium", "windsurf", "hooks.json") : path.join(projectDir, ".windsurf", "hooks.json"),
    // Cascade names the hook in `agent_action_name` on stdin, so one command
    // serves every event.
    entry: (command) => ({ command }),
    commandOf: (entry) => (entry && typeof entry === "object" ? (entry as { command?: unknown }).command : undefined) as string | undefined
  }
};
