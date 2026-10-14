#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describePluginBundleOutcome, installPluginBundle, pluginBundlePaths } from "@ascenda-one/tool-kit";
import { loadConfigFromEnv } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  // Started in the background by the Claude Code plugin's launcher, through
  // `npx -y`, to copy this release where the launcher runs it from. Not an
  // MCP session, so stdout is free. See pluginBundle.ts in tool-kit.
  if (process.argv[2] === "plugin-sync") {
    const outcome = installPluginBundle({ name: "agent-mcp" });
    console.log(describePluginBundleOutcome(outcome, pluginBundlePaths("agent-mcp").bundle));
    return;
  }
  const config = loadConfigFromEnv();
  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // stdio carries the MCP protocol — never write anything but JSON-RPC to
  // stdout, or the host's next parse fails. Config and connection errors go
  // to stderr and the process exits non-zero, exactly like a failed pairing
  // in the hook adapters.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
