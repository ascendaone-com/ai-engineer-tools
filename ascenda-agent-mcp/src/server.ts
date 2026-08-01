import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AscendaEventSender, bucketDurationMs } from "@ascenda-one/tool-kit";
import { AscendaEventMetadata, AscendaTelemetryEventType, SEMANTIC_WORK_SIGNAL_EVENT_TYPES } from "@ascenda-one/tool-contract";
import { z } from "zod";
import { AscendaMcpConfig } from "./config.js";

/**
 * Named {@link AscendaEventMetadata} keys — reserved, so a skill's free-form
 * `evidenceCounts`/`evidenceFlags` keys can never collide with (and silently
 * overwrite) a field the wire type gives specific meaning to.
 */
const RESERVED_METADATA_KEYS = new Set([
  "skillVersion",
  "taskFingerprint",
  "language",
  "fileType",
  "durationBucket",
  "tokenPressureBucket",
  "linesChangedBucket",
  "commandClass",
  "outcome",
  "trigger",
  "promptClass",
  "reason",
  "afterHours",
  "activity",
  "message",
  "host",
  "toolName",
  "simulated",
  "relatedEventType"
]);

/**
 * Bare identifiers only (`scopeChanges`, not `"the user said X"`). This is
 * the structural half of "never raw content": the schema below has no field
 * a skill could stuff a sentence into in the first place, and this pattern
 * closes the one place a caller supplies its own keys.
 */
const EVIDENCE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;

const eventTypeSchema = z.enum(
  SEMANTIC_WORK_SIGNAL_EVENT_TYPES as unknown as [string, ...string[]]
);

const evidenceKeySchema = z.string().regex(EVIDENCE_KEY_PATTERN, "must be a bare identifier, not free text");

const inputShape = {
  eventType: eventTypeSchema.describe(
    "Which semantic pattern was observed. One of the six work-signal types " +
      "— see the ascenda-agent-skills package for what each one means and " +
      "the evidence that should accompany it."
  ),
  skillVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/, "must be a semver version, e.g. 1.0.0")
    .describe(
      "The emitting skill's own version. Mandatory: emission depends on the " +
        "model remembering to call this tool, which drifts across model and " +
        "skill revisions — without a version stamp, a changed emission rate " +
        "is indistinguishable from a changed work pattern."
    ),
  taskFingerprint: z
    .string()
    .regex(/^[a-f0-9]{16,64}$/i, "must be a hash (hex), never the task itself")
    .optional()
    .describe("A local hash identifying the task across attempts, if the skill computed one. Never raw task text."),
  windowMinutes: z
    .number()
    .int()
    .positive()
    .max(1440)
    .optional()
    .describe("Roughly how many minutes the observed pattern spans. Bucketed before it leaves this process."),
  evidenceCounts: z
    .record(evidenceKeySchema, z.number().int())
    .optional()
    .describe('Named integer counts, e.g. { "scopeChanges": 4, "unresolvedDecisions": 3 }. No free text.'),
  evidenceFlags: z
    .record(evidenceKeySchema, z.boolean())
    .optional()
    .describe('Named booleans, e.g. { "originalGoalRetained": false }. No free text.')
};

export function buildServer(config: AscendaMcpConfig): McpServer {
  const server = new McpServer({ name: "ascenda-agent-mcp", version: "0.1.0" });
  const sender = new AscendaEventSender({
    apiBaseUrl: config.apiBaseUrl,
    toolInstallationId: config.toolInstallationId,
    source: "mcp_server",
    eventWriteToken: config.eventWriteToken,
    tokenFilePath: config.tokenFilePath,
    sessionId: config.sessionId,
    workspaceHash: config.workspaceHash,
    timeoutMs: 5000
  });

  server.registerTool(
    "ascenda_emit_work_signal",
    {
      title: "Emit an Ascenda work-friction signal",
      description:
        "Report an observable work pattern — repeated approach churn, drift from a " +
        "declared goal, a stalled or recovered session, a declared intention or scope " +
        "change. Report the pattern, not a diagnosis: never infer or state the user's " +
        "emotional or mental state, and never assert severity — Ascenda evaluates that " +
        "server-side against the person's own baseline. This tool never transmits " +
        "prompt content, code, file names, or any other project content; the schema " +
        "accepts only enumerated event types, a version stamp, an optional hash, and " +
        "named counts/flags.",
      inputSchema: inputShape
    },
    async (args) => {
      for (const key of [...Object.keys(args.evidenceCounts ?? {}), ...Object.keys(args.evidenceFlags ?? {})]) {
        if (RESERVED_METADATA_KEYS.has(key)) {
          return errorResult(`"${key}" is a reserved metadata field name and cannot be used as an evidence key.`);
        }
      }

      const durationBucket = args.windowMinutes ? bucketDurationMs(args.windowMinutes * 60_000) : undefined;
      const metadata: AscendaEventMetadata & { skillVersion: string } = {
        skillVersion: args.skillVersion,
        ...(args.taskFingerprint ? { taskFingerprint: args.taskFingerprint } : {}),
        ...(durationBucket ? { durationBucket } : {}),
        ...(args.evidenceCounts ?? {}),
        ...(args.evidenceFlags ?? {})
      };

      try {
        const result = await sender.sendSemanticSignal({
          eventType: args.eventType as AscendaTelemetryEventType,
          metadata
        });
        if (result === "accepted") {
          return { content: [{ type: "text", text: "accepted" }] };
        }
        if (result === "consent_missing") {
          return errorResult(
            "Ascenda rejected this: semantic-signal consent is missing or expired. " +
              "Grant it in the Ascenda app before this tool can report patterns."
          );
        }
        if (result === "auth_failed") {
          return errorResult("Ascenda rejected this: the event write token is invalid or revoked. Re-pair this tool.");
        }
        return errorResult(`Ascenda rejected this: ${result}.`);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  return server;
}

function errorResult(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}
