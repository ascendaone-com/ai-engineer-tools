#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfigFromEnv } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
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
