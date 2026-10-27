import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionOnTheWire } from "../../scripts/test-support/hookSessionWire.mjs";
import { HOOK_EVENTS } from "../dist/setup.js";

// Every hook setup registers, through the built CLI, paired, to a stub ingest:
// each event that arrives carries the session the payload named.

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

sessionOnTheWire({
  cli,
  toolType: "cli_agent",
  hooks: HOOK_EVENTS,
  sessionField: "sessionId",
  payloads: {
    sessionStart: { cwd: "/tmp", source: "new", initialPrompt: "run the tests", timestamp: 1761000000000 },
    sessionEnd: { cwd: "/tmp", reason: "complete", timestamp: 1761000000000 },
    userPromptSubmitted: { cwd: "/tmp", prompt: "run the tests", timestamp: 1761000000000 },
    preToolUse: { cwd: "/tmp", toolCalls: [{ id: "c1", name: "bash", args: { command: "npm test" } }] },
    postToolUse: { cwd: "/tmp", timestamp: 1761000000000, toolName: "bash", toolArgs: { command: "npm test" }, toolResult: { resultType: "success" } },
    postToolUseFailure: { cwd: "/tmp", timestamp: 1761000000000, toolName: "bash", toolArgs: { command: "npm test" } },
    preCompact: { cwd: "/tmp", timestamp: 1761000000000 },
    subagentStart: { cwd: "/tmp", timestamp: 1761000000000 },
    subagentStop: { cwd: "/tmp", timestamp: 1761000000000 },
    agentStop: { cwd: "/tmp", stopReason: "end_turn", timestamp: 1761000000000 }
  }
});
