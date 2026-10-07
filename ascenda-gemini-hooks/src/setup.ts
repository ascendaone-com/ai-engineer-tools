import * as os from "os";
import * as path from "path";
import type { CliAgentSetupSpec } from "@ascenda-one/tool-kit";
import { ASCENDA_TOOL_TYPE, GEMINI_HOST } from "./types.js";

/**
 * The hooks that map to a catalog event, plus `Notification`. `BeforeModel`,
 * `AfterModel` and `BeforeToolSelection` fire per LLM round trip and would
 * multiply volume for signal the tool hooks already carry.
 *
 * `Notification` has no catalog counterpart and sends nothing to the cloud.
 * It is registered for the local live bus alone: a `ToolPermission`
 * notification is the only way Gemini says it has stopped to wait on the
 * person, and without it the desktop app reads a confirmation dialog as work
 * (`liveSignalFor`). One process per confirmation is bounded by how often a
 * person is asked, not by how fast the agent runs.
 */
export const HOOK_EVENTS = ["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "PreCompress", "Notification"] as const;

/**
 * Gemini's default hook timeout is generous. Telemetry that cannot complete
 * in a few seconds is not worth waiting for, and a hung request would
 * otherwise stall the user's turn.
 */
const HOOK_TIMEOUT_SECONDS = 5;

type GeminiHookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: unknown }> };

export const SETUP: CliAgentSetupSpec = {
  host: GEMINI_HOST,
  displayName: "Gemini CLI",
  toolType: ASCENDA_TOOL_TYPE,
  packageName: "@ascenda-one/gemini-hooks",
  binaryName: "ascenda-gemini-hook",
  hookEvents: HOOK_EVENTS,
  restartHint: "Restart Gemini CLI to load the hooks.",
  // Nothing beyond the shared set: Gemini's hooks expose no posture, no
  // model, no git action and no context figure.
  sends: [],
  settings: {
    settingsPath: (scope, projectDir) =>
      scope === "user" ? path.join(os.homedir(), ".gemini", "settings.json") : path.join(projectDir, ".gemini", "settings.json"),
    // Gemini nests one level deeper than the other agents: each event maps to
    // an array of { matcher, hooks: [{ type, command }] }. The event name
    // arrives in `hook_event_name` on stdin, so one command serves every hook.
    entry: (command) => ({ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] }),
    commandOf: (entry) => {
      const group = entry as GeminiHookGroup | undefined;
      const command = group?.hooks?.find((hook) => typeof hook?.command === "string")?.command;
      return typeof command === "string" ? command : undefined;
    }
  }
};
