#!/usr/bin/env node
import { createDevServer } from "./server.js";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.PORT ?? 4477);
const manual = args.includes("--manual");
const HOST = "127.0.0.1";

const { server } = createDevServer({ autoConfirm: !manual });

// Loopback only. The server auto-confirms pairing, issues bearer tokens, and
// serves captured telemetry unauthenticated at /_dev/events — none of which
// should be reachable from the network the developer happens to be on.
server.listen(port, HOST, () => {
  const base = `http://localhost:${port}`;
  console.log(`
  Ascenda dev server — local mock of the /v1 pairing + ingest contract
  ────────────────────────────────────────────────────────────────────
  Base URL          ${base}
  Pairing           ${manual ? "manual (confirm via pairing-sim or curl)" : "auto-confirm (no app needed)"}
  Consent           active   (simulate expiry: curl -X POST ${base}/_dev/consent -d '{"active":false}')
  Received events   ${base}/_dev/events

  Point tools here:
    extensions      set  ascenda.apiBaseUrl = ${base}
    hook CLIs       export ASCENDA_API_BASE_URL=${base}
    pairing-sim     export ASCENDA_API_BASE_URL=${base} ASCENDA_USER_TOKEN=dev

  Events print below as they arrive. Ctrl-C to stop.
`);
});
