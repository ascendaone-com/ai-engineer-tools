import {
  bucketDurationMs,
  classifyCommand,
  getNested,
  getNestedString,
  getString,
  inferOutcome,
  isVerificationCommand,
  looksLikeCorrection
} from "@ascenda-one/tool-kit";
import type { AutonomyMode } from "@ascenda-one/tool-contract";
import { CODEX_HOST, CodexHookEventName, CodexHookInput, MappedCodexEvent } from "./types.js";

/**
 * Maps Codex lifecycle hooks to the canonical Ascenda event catalog.
 * Catalog values only; hooks without a catalog counterpart map to nothing.
 * See docs/CODEX_MAPPING.md.
 */
export function mapCodexEvent(hookName: CodexHookEventName, input: CodexHookInput, turnDurationMs?: number): MappedCodexEvent[] {
  switch (hookName) {
    case "SessionStart": return mapSessionStart(input);
    case "UserPromptSubmit": return mapUserPromptSubmit(input);
    // No posture here on purpose: PreToolUse and PostToolUse are a pair over
    // the same call under the same mode, so carrying it once halves the cost
    // on the highest-volume event. Same call the Claude adapter makes.
    case "PreToolUse": return [{ eventType: "ai_tool_call_started", severity: "low", metadata: withHost({ toolName: sanitiseToolName(getToolName(input)) }) }];
    case "PostToolUse": return mapPostToolUse(input);
    case "PreCompact": return mapPreCompact(input);
    // PreCompact/PostCompact are the two hooks Codex's own schemas leave
    // `permission_mode` out of, so these two events carry no posture and that
    // absence is the payload's, not a decision of ours.
    case "PostCompact": return [{ eventType: "context_pressure_high", severity: "medium", metadata: withHost({ trigger: "inferred", reason: "context_limit" }) }];
    case "Stop": return mapStop(input, turnDurationMs);
    // No catalog events for approvals or subagent lifecycle; skip to avoid unclassified noise.
    case "PermissionRequest":
    case "SubagentStart":
    case "SubagentStop":
      return [];
    default: return [];
  }
}

function mapSessionStart(input: CodexHookInput): MappedCodexEvent[] {
  const source = getString(input, ["source"]);
  // "clear" and "compact" restarts are not new working sessions.
  if (source && source !== "startup" && source !== "resume") return [];
  // Codex differs from Claude Code here: its `SessionStart` payload *does*
  // carry `permission_mode`, so this row records the posture the session
  // opened under. It is the opening posture only — Codex sends the mode on
  // every later hook too, and the mode can be switched mid-session, so no
  // reader may treat this one value as the session's posture.
  return [{ eventType: "create_focus_session", severity: "low", metadata: withHost({ activity: "session_started", ...autonomyModeMetadata(input) }) }];
}

function mapUserPromptSubmit(input: CodexHookInput): MappedCodexEvent[] {
  const prompt = getString(input, ["prompt", "userPrompt", "message"]) ?? getNestedString(input, [["payload", "prompt"]]);
  const autonomy = autonomyModeMetadata(input);
  const events: MappedCodexEvent[] = [{ eventType: "ai_prompt_submitted", severity: "low", metadata: withHost({ promptClass: "unknown", ...autonomy }) }];
  if (looksLikeCorrection(prompt)) {
    events.push({ eventType: "ai_correction_prompt", severity: "medium", metadata: withHost({ reason: "repeated_reprompting", trigger: "inferred", ...autonomy }) });
  }
  return events;
}

function mapPostToolUse(input: CodexHookInput): MappedCodexEvent[] {
  const toolName = getToolName(input);
  const safeToolName = sanitiseToolName(toolName);
  const outcome = inferOutcome(input);
  const command = getString(input, ["command"]) ?? getNestedString(input, [["tool_input", "command"], ["input", "command"]]);
  const commandClass = classifyCommand(command);
  const lowered = toolName?.toLowerCase();
  const isShell = lowered === "bash" || lowered === "shell" || lowered === "local_shell";
  // Deliberately not gated on outcome. A call that failed still happened under
  // a permission posture, and a failure under `bypass_permissions` is a
  // different fact from the same failure under `default` — gating would erase it.
  const autonomy = autonomyModeMetadata(input);

  if (outcome === "failure") {
    if (isShell && isVerificationCommand(commandClass)) {
      return [{ eventType: "compile_error", severity: "medium", metadata: withHost({ toolName: safeToolName, commandClass, outcome, reason: "test_failure", ...autonomy }) }];
    }
    return [{ eventType: "ai_tool_call_failed", severity: "medium", metadata: withHost({ toolName: safeToolName, commandClass, outcome, reason: "tool_failure", ...autonomy }) }];
  }

  // apply_patch is Codex's file-modification tool.
  if (lowered === "apply_patch") {
    return [{ eventType: "ai_file_edit", severity: "low", metadata: withHost({ toolName: safeToolName, outcome, ...autonomy }) }];
  }

  if (isShell && isVerificationCommand(commandClass)) {
    return [{ eventType: "editor_verification_activity", severity: "low", metadata: withHost({ toolName: safeToolName, commandClass, outcome, activity: "ai_test_or_build_run", ...autonomy }) }];
  }

  return [{ eventType: "ai_tool_call_completed", severity: "low", metadata: withHost({ toolName: safeToolName, commandClass, outcome, ...autonomy }) }];
}

function mapPreCompact(input: CodexHookInput): MappedCodexEvent[] {
  const trigger = getString(input, ["trigger", "reason"]);
  const isManual = trigger?.toLowerCase().includes("manual") ?? false;
  return [{ eventType: isManual ? "context_compression_manual" : "context_compression_auto", severity: isManual ? "medium" : "high", metadata: withHost({ trigger: isManual ? "manual" : "auto", reason: "context_limit" }) }];
}

function mapStop(input: CodexHookInput, turnDurationMs: number | undefined): MappedCodexEvent[] {
  const durationBucket = bucketDurationMs(turnDurationMs);
  if (durationBucket === "30-60m" || durationBucket === "60m+") {
    // The posture matters most here: a 90-minute turn under `default` is 90
    // minutes of a person approving every step, and the same 90 minutes under
    // `bypass_permissions` is a person who walked away.
    return [{ eventType: "agent_loop_long", severity: durationBucket === "60m+" ? "high" : "medium", metadata: withHost({ durationBucket, reason: "long_session", trigger: "inferred", ...autonomyModeMetadata(input) }) }];
  }
  return [];
}

/**
 * The supervision posture as a metadata fragment, ready to spread.
 *
 * Two states are deliberately different, exactly as in the Claude adapter:
 *
 * - **The payload carries no posture at all** → `{}`, so the key is absent.
 *   `PreCompact` and `PostCompact` are genuinely like this — Codex's own
 *   generated schemas omit `permission_mode` from both — as is any payload
 *   from a Codex old enough to predate hooks carrying it.
 * - **The payload carries a posture we do not recognise** → `{ autonomyMode:
 *   "unknown" }`, sent, never dropped. OpenAI's five documented values may
 *   grow, and a new mode showing up as a rising `unknown` count is how we find
 *   out; a dropped field would look exactly like nothing having changed.
 */
function autonomyModeMetadata(input: CodexHookInput): { autonomyMode?: AutonomyMode } {
  const raw = readPermissionMode(input);
  return raw === undefined ? {} : { autonomyMode: classifyAutonomyMode(raw) };
}

/**
 * The raw posture value, at whatever spelling and nesting it arrives in, or
 * `undefined` when the payload has none.
 *
 * Returns `unknown` (the type) rather than `string | undefined` on purpose: a
 * present-but-wrong-typed value must reach the classifier so it becomes
 * `"unknown"`, and using `getString` here would have collapsed it back into
 * absence — the one distinction this pair exists to preserve.
 */
function readPermissionMode(input: CodexHookInput): unknown {
  const candidates: unknown[] = [
    input["permission_mode"],
    input["permissionMode"],
    getNested(input, ["payload", "permission_mode"])
  ];
  for (const value of candidates) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Codex's `permission_mode` onto `AutonomyMode` — the same 1:1 upstream mirror
 * the Claude adapter uses, minus the one value Codex does not have. **Total by
 * contract**: every input, including a number, an object, or a mode OpenAI
 * ships next month, produces a value. Exported so the totality is testable
 * directly rather than only through a hook payload.
 *
 * Codex documents five values and its generated wire schema
 * (`codex-rs/hooks/schema/generated/*.command.input.schema.json`, read 28 Aug
 * 2026) pins the enum to exactly those: `default`, `acceptEdits`, `plan`,
 * `dontAsk`, `bypassPermissions`. That is Claude Code's vocabulary minus
 * `auto`, spelled identically, so the mapping is identical too — snake-casing
 * and nothing else.
 *
 * **The mirror is what makes this comparable, not a shared ladder.** Both
 * runtimes' payloads reach the same five tokens without either being
 * translated into a vocabulary we invented, so where they agree the wire shows
 * agreement and where they diverge the wire shows that too, instead of hiding
 * the divergence inside a rung. Whether `accept_edits` on Codex is the same
 * *posture* as `accept_edits` on Claude Code is a reader's question and stays
 * answerable, because the collector name is on every row.
 *
 * `auto` is deliberately **not** in the table even though the Claude adapter
 * emits it. Codex has no such mode today, and its own UI preset named *Auto*
 * is not the same thing — that preset still escalates commands for approval.
 * If Codex ever puts `auto` on the wire, it arrives as a visible bump in
 * `unknown`, which is the point of the escape hatch, and the mapping is added
 * then from what the mode actually does rather than from its spelling.
 *
 * Codex's *native* vocabulary — the `approval_policy`
 * (`untrusted`/`unless-trusted`/`on-failure`/`on-request`/`never`) and
 * `sandbox_mode` (`read-only`/`workspace-write`/`danger-full-access`) pair
 * visible in the binary and in `config.toml` — is likewise unmapped, and not
 * by oversight. Those are two orthogonal axes, no hook payload carries either,
 * and inventing tokens for wire values that no runtime is known to send would
 * be a guess dressed as a measurement.
 *
 * Matching is case-insensitive and trimmed — cheap insurance against a
 * spelling drift that would otherwise silently reclassify a whole cohort as
 * `unknown`.
 */
export function classifyAutonomyMode(raw: unknown): AutonomyMode {
  if (typeof raw !== "string") return "unknown";
  return AUTONOMY_BY_PERMISSION_MODE[raw.trim().toLowerCase()] ?? "unknown";
}

const AUTONOMY_BY_PERMISSION_MODE: Record<string, AutonomyMode> = {
  default: "default",
  plan: "plan",
  acceptedits: "accept_edits",
  dontask: "dont_ask",
  bypasspermissions: "bypass_permissions"
};

function getToolName(input: CodexHookInput): string | undefined {
  return getString(input, ["tool_name", "toolName", "name"]);
}

function sanitiseToolName(toolName: string | undefined): string {
  if (!toolName) return "unknown";
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
}

function withHost(metadata: Record<string, unknown>): MappedCodexEvent["metadata"] {
  return { host: CODEX_HOST, ...metadata } as MappedCodexEvent["metadata"];
}
