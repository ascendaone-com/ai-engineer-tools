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
  sessionField: "trajectory_id",
  payloads: {
  pre_user_prompt: { agent_action_name: "pre_user_prompt", tool_info: { user_prompt: "run the tests" } },
  pre_read_code: { agent_action_name: "pre_read_code", tool_info: { file_path: "/p/a.ts" } },
  post_read_code: { agent_action_name: "post_read_code", tool_info: { file_path: "/p/a.ts" } },
  pre_write_code: { agent_action_name: "pre_write_code", tool_info: { file_path: "/p/a.ts" } },
  post_write_code: { agent_action_name: "post_write_code", tool_info: { file_path: "/p/a.ts" } },
  pre_run_command: { agent_action_name: "pre_run_command", tool_info: { command_line: "npm test", cwd: "/p" } },
  post_run_command: { agent_action_name: "post_run_command", tool_info: { command_line: "npm test", cwd: "/p" } },
  pre_mcp_tool_use: { agent_action_name: "pre_mcp_tool_use", tool_info: { mcp_server_name: "github", mcp_tool_name: "list_prs" } },
  post_mcp_tool_use: { agent_action_name: "post_mcp_tool_use", tool_info: { mcp_server_name: "github", mcp_tool_name: "list_prs" } },
  post_cascade_response: { agent_action_name: "post_cascade_response" }
}
});
