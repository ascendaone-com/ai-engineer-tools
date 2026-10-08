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
  SessionStart: { hook_event_name: "SessionStart", source: "startup" },
  SessionEnd: { hook_event_name: "SessionEnd", reason: "exit" },
  BeforeAgent: { hook_event_name: "BeforeAgent", prompt: "run the tests" },
  AfterAgent: { hook_event_name: "AfterAgent", prompt: "run the tests" },
  BeforeTool: { hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "pytest -q" } },
  AfterTool: { hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "pytest -q" }, tool_response: { exitCode: 0 } },
  PreCompress: { hook_event_name: "PreCompress", trigger: "auto" }
}
});
