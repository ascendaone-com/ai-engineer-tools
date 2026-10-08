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
  sessionField: "conversation_id",
  payloads: {
  sessionStart: { composer_mode: "agent" },
  sessionEnd: { reason: "completed" },
  beforeSubmitPrompt: { prompt: "run the tests" },
  preToolUse: { tool_name: "Shell", tool_input: { command: "npm test" } },
  postToolUse: { tool_name: "Shell", tool_input: { command: "npm test" }, tool_output: '{"exitCode":0}', duration: 4200 },
  postToolUseFailure: { tool_name: "Shell", tool_input: { command: "npm run build" } },
  preCompact: { trigger: "auto", context_usage_percent: 85 },
  stop: { status: "completed" }
}
});
