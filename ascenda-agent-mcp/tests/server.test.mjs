import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";

// End-to-end through the real MCP protocol (InMemoryTransport, no stdio) —
// not just calling the handler function directly — so a schema regression
// that only breaks the wire (e.g. a Zod shape MCP can't serialise) shows up
// here rather than only in production.

const config = {
  apiBaseUrl: "https://api.example.test",
  toolInstallationId: "claude_code:test-tool",
  eventWriteToken: "test-token",
  tokenFilePath: "/tmp/ascenda-agent-mcp-test-token",
  sessionId: "test-session"
};

async function withConnectedClient(fetchImpl, run) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  const server = buildServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    await run(client);
  } finally {
    global.fetch = originalFetch;
    await client.close();
  }
}

test("tools/list advertises exactly ascenda_emit_work_signal", async () => {
  await withConnectedClient(
    async () => {
      throw new Error("must not reach the network for a list call");
    },
    async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["ascenda_emit_work_signal"]
      );
    }
  );
});

test("a valid call sends the semantic scope and reports accepted", async () => {
  let sentBody;
  await withConnectedClient(
    async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ status: "accepted" }), { status: 200 });
    },
    async (client) => {
      const result = await client.callTool({
        name: "ascenda_emit_work_signal",
        arguments: {
          eventType: "goal_drift_detected",
          skillVersion: "1.0.0",
          windowMinutes: 26,
          evidenceCounts: { scopeChanges: 4, unresolvedDecisions: 3 },
          evidenceFlags: { originalGoalRetained: false }
        }
      });
      assert.equal(result.isError, undefined);
      assert.equal(sentBody.eventType, "goal_drift_detected");
      assert.equal(sentBody.consentScope, "semantic_work_signals");
      assert.equal(sentBody.severity, "low");
      assert.equal(sentBody.metadata.skillVersion, "1.0.0");
      assert.equal(sentBody.metadata.scopeChanges, 4);
      assert.equal(sentBody.metadata.unresolvedDecisions, 3);
      assert.equal(sentBody.metadata.originalGoalRetained, false);
      // 26 minutes buckets to 10-30m, not sent as a raw number.
      assert.equal(sentBody.metadata.durationBucket, "10-30m");
      assert.equal(sentBody.metadata.windowMinutes, undefined);
    }
  );
});

// Note on assertions below: this SDK version converts every tool-call-time
// failure — schema validation included — into a resolved CallToolResult
// with isError:true, not a rejected promise (only a very specific
// elicitation error code crosses the wire as a protocol-level rejection).
// Confirmed directly against the SDK before relying on it here.

test("a non-semantic eventType is refused by the schema before any network call", async () => {
  await withConnectedClient(
    async () => {
      throw new Error("must not be called");
    },
    async (client) => {
      const result = await client.callTool({
        name: "ascenda_emit_work_signal",
        arguments: { eventType: "ai_tool_call_completed", skillVersion: "1.0.0" }
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Invalid arguments/);
    }
  );
});

test("a missing skillVersion is refused by the schema", async () => {
  await withConnectedClient(
    async () => {
      throw new Error("must not be called");
    },
    async (client) => {
      const result = await client.callTool({
        name: "ascenda_emit_work_signal",
        arguments: { eventType: "progress_stalled" }
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Invalid arguments/);
    }
  );
});

test("a free-text-shaped evidence key is refused by the schema", async () => {
  await withConnectedClient(
    async () => {
      throw new Error("must not be called");
    },
    async (client) => {
      const result = await client.callTool({
        name: "ascenda_emit_work_signal",
        arguments: {
          eventType: "approach_churn_detected",
          skillVersion: "1.0.0",
          evidenceFlags: { "the user seemed frustrated": true }
        }
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Invalid arguments/);
    }
  );
});

test("an evidence key colliding with a reserved metadata field is refused at the tool level", async () => {
  await withConnectedClient(
    async () => {
      throw new Error("must not be called");
    },
    async (client) => {
      const result = await client.callTool({
        name: "ascenda_emit_work_signal",
        arguments: {
          eventType: "approach_churn_detected",
          skillVersion: "1.0.0",
          evidenceCounts: { skillVersion: 2 }
        }
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /reserved metadata field/);
    }
  );
});

test("a taskFingerprint that is not hash-shaped is refused by the schema", async () => {
  await withConnectedClient(
    async () => {
      throw new Error("must not be called");
    },
    async (client) => {
      const result = await client.callTool({
        name: "ascenda_emit_work_signal",
        arguments: {
          eventType: "approach_churn_detected",
          skillVersion: "1.0.0",
          taskFingerprint: "fix the auth bug in login.ts"
        }
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Invalid arguments/);
    }
  );
});

test("an auth failure that fails re-pairing surfaces as a clear tool error, not a crash", async () => {
  await withConnectedClient(
    async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    async (client) => {
      const result = await client.callTool({
        name: "ascenda_emit_work_signal",
        arguments: { eventType: "progress_recovered", skillVersion: "1.0.0" }
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /token is invalid or revoked/);
    }
  );
});
