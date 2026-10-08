import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionOnTheWire } from "../../scripts/test-support/hookSessionWire.mjs";
import { HOOK_EVENTS } from "../dist/setup.js";

// Every hook setup registers, through the built CLI, paired, to a stub ingest:
// each event that arrives carries the session the payload named. Shipped rows
// never fall back to a parent pid the way the local live signal does.

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

sessionOnTheWire({
  cli,
  toolType: "cli_agent",
  hooks: HOOK_EVENTS,
  sessionField: "session_id",
  payloads: {
  SessionStart: { model: "gpt-5", permission_mode: "auto", cwd: "/tmp" },
  UserPromptSubmit: { prompt: "run the tests", cwd: "/tmp" },
  PreToolUse: { tool_name: "shell", tool_input: { command: "npm test" }, cwd: "/tmp" },
  PostToolUse: { tool_name: "shell", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 }, cwd: "/tmp" },
  PreCompact: { trigger: "auto", cwd: "/tmp" },
  PostCompact: { trigger: "auto", cwd: "/tmp" },
  Stop: { cwd: "/tmp" },
  PermissionRequest: { cwd: "/tmp" }
}
});
